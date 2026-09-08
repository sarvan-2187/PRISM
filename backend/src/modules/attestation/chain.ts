/**
 * Attestation Chain — the durable, tamper-evident record of how a payment was
 * authorized.
 *
 * Every mandatory security stage appends one row. Rows are:
 *   - ordered      : (attempt, seq), UNIQUE, enforced by the database
 *   - non-skippable : (attempt, stage) UNIQUE + the capability lists every
 *                     stage it requires
 *   - linked        : each row's prev_hash is the previous row's row_hash;
 *                     attempt 1 seq 0 links to transactions.intent_hash
 *   - keyed         : mac = HMAC(K_attest, row_hash), so a row written straight
 *                     into Postgres by someone without the key does not verify
 *
 * settle() then consumes a capability minted only from a complete, valid chain,
 * inside the same DB transaction as the ledger write. The result: skipping a
 * control is a constraint violation, not a code-review miss.
 */
import { PoolClient } from 'pg';
import { query, getClient } from '../../db/pool';
import { keyManager } from '../keys/keyManager';
import { canonicalHash, canonicalJson } from '../../utils/attestationCanonical';
import { hashesMatch } from '../../utils/canonical';
import { disabledControls } from '../../config/policy';
import {
  AuthorizationStage,
  AuthorizationStepRow,
  SettlementCapabilityRow,
} from '../../db/types';
import { fail } from '../../api/errors';

/** Stages must appear in this order within an attempt. */
export const STAGE_ORDER: AuthorizationStage[] = [
  'INTENT_LOCKED',
  'WEBAUTHN_APPROVED',
  // The mobile app cannot hold a passkey (React Native has no
  // navigator.credentials, and a native one needs a signed build), so it
  // authorizes with an HMAC over the same intent hash. Sitting BESIDE
  // WEBAUTHN_APPROVED rather than replacing it keeps both orderings
  // strictly increasing, so each path validates on its own without an
  // either/or in the comparator - and the trail says plainly which of the
  // two actually happened, because they are not equally strong.
  'DEVICE_APPROVED',
  'CONTEXT_VERIFIED',
  'POLICY_EVALUATED',
  'RISK_APPROVED',
  'SEMANTIC_VERIFIED',
  'SETTLEMENT_AUTHORIZED',
];

export interface AppendResult {
  attempt: number;
  seq: number;
  rowHash: string;
}

export interface ChainVerification {
  ok: boolean;
  tipHash: string;
  /** Stages recorded in the target attempt — the authorization that is settling now. */
  stagesPresent: AuthorizationStage[];
  /** Stages recorded anywhere up to the target attempt (e.g. SEMANTIC_VERIFIED from an earlier retry). */
  stagesEver: AuthorizationStage[];
  reason?: string;
}

interface Queryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

function runner(client?: PoolClient): Queryable {
  if (client) return client as unknown as Queryable;
  return { query: (text, params) => query(text as never, params as never) as never };
}

function epochSeconds(d: Date | string): number {
  return Math.floor(new Date(d).getTime() / 1000);
}

export class AttestationChainModule {
  /**
   * Append one authorization step. Returns the new tip.
   *
   * `payload` is the stage's decision and its evidence. This method adds the
   * disabled_controls stamp itself — a control cannot both be off and omit the
   * fact from the record.
   *
   * Passing `client` runs the append inside a caller's transaction; the
   * INTENT_LOCKED root must be written that way, alongside the transactions row.
   */
  async append(
    transactionId: string,
    stage: AuthorizationStage,
    payload: Record<string, unknown>,
    opts: { client?: PoolClient } = {}
  ): Promise<AppendResult> {
    const r = runner(opts.client);

    const tipRows = (
      await r.query<Pick<AuthorizationStepRow, 'attempt' | 'seq' | 'stage' | 'row_hash'>>(
        `SELECT attempt, seq, stage, row_hash
           FROM authorization_steps
          WHERE transaction_id = $1
          ORDER BY attempt DESC, seq DESC
          LIMIT 1`,
        [transactionId]
      )
    ).rows;

    let attempt: number;
    let seq: number;
    let prevHash: string;

    if (tipRows.length === 0) {
      if (stage !== 'INTENT_LOCKED') {
        fail('CHAIN_INVALID', { reason: `first step must be INTENT_LOCKED, got ${stage}` });
      }
      attempt = 1;
      seq = 0;
      const intent = (
        await r.query<{ intent_hash: string }>(`SELECT intent_hash FROM transactions WHERE id = $1`, [
          transactionId,
        ])
      ).rows;
      if (!intent[0]) fail('NOT_FOUND', { reason: 'no such transaction' });
      prevHash = intent[0].intent_hash; // rooted in the exact locked intent
    } else {
      const tip = tipRows[0];
      prevHash = tip.row_hash;
      if (stage === 'INTENT_LOCKED') {
        // A new attempt (re-authorization after a step-up). seq restarts at 0,
        // attempt increments, and the link crosses from the previous tip.
        attempt = tip.attempt + 1;
        seq = 0;
      } else {
        attempt = tip.attempt;
        seq = tip.seq + 1;
        this.assertStageOrder(tip.stage, stage);
      }
    }

    const recordedAt = Math.floor(Date.now() / 1000);
    const stamped = { ...payload, disabledControls: [...disabledControls()].sort() };

    const rowHash = canonicalHash({
      transactionId,
      attempt,
      seq,
      stage,
      payload: stamped,
      prevHash,
      recordedAt,
    });
    const mac = keyManager.macStep(rowHash);

    try {
      await r.query(
        `INSERT INTO authorization_steps
           (transaction_id, attempt, seq, stage, payload, prev_hash, row_hash, mac, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, to_timestamp($9))`,
        [transactionId, attempt, seq, stage, JSON.stringify(stamped), prevHash, rowHash, mac, recordedAt]
      );
    } catch (err) {
      // 23505 = unique_violation: duplicate (attempt,seq), (attempt,stage) or
      // row_hash. Every one means the pipeline is replayed or out of order.
      if ((err as { code?: string }).code === '23505') {
        fail('CHAIN_INVALID', {
          reason: 'stage already recorded for this attempt, or out of order',
          stage,
        });
      }
      throw err;
    }

    return { attempt, seq, rowHash };
  }

  private assertStageOrder(prevStage: AuthorizationStage, nextStage: AuthorizationStage): void {
    if (STAGE_ORDER.indexOf(nextStage) <= STAGE_ORDER.indexOf(prevStage)) {
      fail('CHAIN_INVALID', { reason: `stage ${nextStage} cannot follow ${prevStage}` });
    }
  }

  /**
   * Recompute the whole chain up to `attempt` and check every link and MAC.
   * This is what settlement calls, and what the offline verifier reproduces.
   */
  async verify(
    transactionId: string,
    attempt: number,
    intentHash: string,
    opts: { client?: PoolClient } = {}
  ): Promise<ChainVerification> {
    const r = runner(opts.client);

    const rows = (
      await r.query<AuthorizationStepRow>(
        `SELECT * FROM authorization_steps
          WHERE transaction_id = $1 AND attempt <= $2
          ORDER BY attempt ASC, seq ASC`,
        [transactionId, attempt]
      )
    ).rows;

    const bad = (reason: string): ChainVerification => ({
      ok: false,
      tipHash: '',
      stagesPresent: [],
      stagesEver: [],
      reason,
    });
    if (rows.length === 0) return bad('no chain');

    let expectedPrev = intentHash;
    let lastAttempt = 0;
    let lastSeq = -1;
    const stagesInTargetAttempt: AuthorizationStage[] = [];
    const stagesEver: AuthorizationStage[] = [];

    for (const row of rows) {
      if (row.attempt === lastAttempt) {
        if (row.seq !== lastSeq + 1) return bad(`seq gap at attempt ${row.attempt}`);
      } else if (row.seq !== 0) {
        return bad(`attempt ${row.attempt} does not start at seq 0`);
      }

      if (!hashesMatch(row.prev_hash, expectedPrev)) {
        return bad(`broken link at attempt ${row.attempt} seq ${row.seq}`);
      }

      const recomputed = canonicalHash({
        transactionId,
        attempt: row.attempt,
        seq: row.seq,
        stage: row.stage,
        payload: row.payload,
        prevHash: row.prev_hash,
        recordedAt: epochSeconds(row.recorded_at),
      });
      if (!hashesMatch(recomputed, row.row_hash)) {
        return bad(`row_hash mismatch at attempt ${row.attempt} seq ${row.seq} (payload altered)`);
      }
      if (!keyManager.macMatches(keyManager.macStep(row.row_hash), row.mac)) {
        return bad(`MAC invalid at attempt ${row.attempt} seq ${row.seq} (forged row)`);
      }

      expectedPrev = row.row_hash;
      lastAttempt = row.attempt;
      lastSeq = row.seq;
      stagesEver.push(row.stage);
      if (row.attempt === attempt) stagesInTargetAttempt.push(row.stage);
    }

    return {
      ok: true,
      tipHash: expectedPrev,
      stagesPresent: stagesInTargetAttempt,
      stagesEver,
    };
  }

  /**
   * Mint a settlement capability from a complete, valid chain. `requiredStages`
   * is recorded on the capability so settlement checks against what THIS
   * transaction actually needed, not a global list.
   */
  async mintCapability(
    transactionId: string,
    attempt: number,
    intentHash: string,
    requiredStages: AuthorizationStage[],
    mode: 'NORMAL' | 'DURESS',
    ttlSeconds: number
  ): Promise<SettlementCapabilityRow> {
    const chain = await this.verify(transactionId, attempt, intentHash);
    if (!chain.ok) fail('CHAIN_INVALID', { reason: chain.reason });

    // SEMANTIC_VERIFIED may have been recorded in an earlier attempt (the user
    // confirmed the change, then re-authorized) — a completed step-up does not
    // expire per attempt. Every other stage must be in the attempt that is
    // settling now.
    const missing = requiredStages.filter((s) =>
      s === 'SEMANTIC_VERIFIED'
        ? !chain.stagesEver.includes(s)
        : !chain.stagesPresent.includes(s)
    );
    if (missing.length > 0) {
      fail('CHAIN_INCOMPLETE', { reason: `missing mandatory stages: ${missing.join(', ')}`, missing });
    }

    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const body = {
      typ: 'prism.capability.v1',
      transactionId,
      attempt,
      intentHash,
      chainTipHash: chain.tipHash,
      requiredStages: [...requiredStages].sort(),
      mode,
      expiresAt,
    };
    const mac = keyManager.macCapability(canonicalJson(body));

    const rows = (
      await query<SettlementCapabilityRow>(
        `INSERT INTO settlement_capabilities
           (transaction_id, attempt, intent_hash, chain_tip_hash, required_stages, mode, mac, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, to_timestamp($8))
         RETURNING *`,
        [transactionId, attempt, intentHash, chain.tipHash, requiredStages, mode, mac, expiresAt]
      )
    ).rows;

    return rows[0];
  }

  /**
   * Cryptographic half of capability validation: MAC and freshness. Consumption
   * (the WHERE consumed_at IS NULL update) is done by settlement inside its own
   * transaction with FOR UPDATE.
   */
  verifyCapabilityShape(cap: SettlementCapabilityRow): void {
    const body = {
      typ: 'prism.capability.v1',
      transactionId: cap.transaction_id,
      attempt: cap.attempt,
      intentHash: cap.intent_hash,
      chainTipHash: cap.chain_tip_hash,
      requiredStages: [...cap.required_stages].sort(),
      mode: cap.mode,
      expiresAt: epochSeconds(cap.expires_at),
    };
    if (!keyManager.macMatches(keyManager.macCapability(canonicalJson(body)), cap.mac)) {
      fail('CAPABILITY_INVALID', { reason: 'capability MAC does not verify' });
    }
    if (cap.consumed_at) fail('REPLAY_BLOCKED', { reason: 'capability already consumed' });
    if (new Date(cap.expires_at).getTime() <= Date.now()) {
      fail('CAPABILITY_INVALID', { reason: 'capability expired' });
    }
  }

  /** Read the chain for display / the receipt. No verification side effects. */
  async load(transactionId: string): Promise<AuthorizationStepRow[]> {
    const { rows } = await query<AuthorizationStepRow>(
      `SELECT * FROM authorization_steps WHERE transaction_id = $1 ORDER BY attempt ASC, seq ASC`,
      [transactionId]
    );
    return rows;
  }

  /**
   * Begin (or continue) an authorization attempt and return its number.
   *
   * intentLock.lock() writes the attempt-1 root. The first /authorize continues
   * attempt 1. A re-authorization after a step-up finds attempt 1 already used
   * past its root, so it opens attempt 2 with a fresh INTENT_LOCKED linked to
   * the previous tip — the chain stays continuous across the retry.
   */
  async startAttempt(transactionId: string): Promise<number> {
    const tip = (
      await query<Pick<AuthorizationStepRow, 'attempt' | 'seq' | 'stage'>>(
        `SELECT attempt, seq, stage FROM authorization_steps
          WHERE transaction_id = $1 ORDER BY attempt DESC, seq DESC LIMIT 1`,
        [transactionId]
      )
    ).rows[0];

    if (!tip) fail('CHAIN_INVALID', { reason: 'transaction has no INTENT_LOCKED root' });
    if (tip.stage === 'INTENT_LOCKED' && tip.seq === 0) return tip.attempt; // fresh, unused
    const r = await this.append(transactionId, 'INTENT_LOCKED', { reattempt: true });
    return r.attempt;
  }

  /**
   * Whether a given stage has been recorded — for one attempt, or anywhere for
   * the transaction when `attempt` is null.
   */
  async hasStage(
    transactionId: string,
    attempt: number | null,
    stage: AuthorizationStage
  ): Promise<boolean> {
    const { rows } =
      attempt === null
        ? await query(
            `SELECT 1 FROM authorization_steps WHERE transaction_id = $1 AND stage = $2 LIMIT 1`,
            [transactionId, stage]
          )
        : await query(
            `SELECT 1 FROM authorization_steps
              WHERE transaction_id = $1 AND attempt = $2 AND stage = $3 LIMIT 1`,
            [transactionId, attempt, stage]
          );
    return rows.length > 0;
  }

  /** Highest attempt number recorded for a transaction (0 if none). */
  async currentAttempt(transactionId: string, client?: PoolClient): Promise<number> {
    const rows = (
      await runner(client).query<{ a: number }>(
        `SELECT COALESCE(MAX(attempt), 0)::int AS a FROM authorization_steps WHERE transaction_id = $1`,
        [transactionId]
      )
    ).rows;
    return Number(rows[0]?.a ?? 0);
  }

  /** So a caller can open its own transaction for the INTENT_LOCKED root. */
  getClient = getClient;
}

export const attestationChain = new AttestationChainModule();
