/**
 * Canonical serialisation for authorization-chain records.
 *
 * Separate from utils/canonical.ts on purpose. That file hashes a fixed,
 * server-built intent with an explicit field list, and its known-answer vector
 * is pinned by npm test -- it must not move. This one has a different job: it
 * serialises step payloads whose shape varies by stage, so it needs a general
 * recursive canonicaliser rather than a field list.
 *
 * The rules are deliberately strict, because a serialiser that silently accepts
 * ambiguous input produces hashes that disagree with themselves later:
 *
 *   - object keys sorted by UTF-16 code unit, no whitespace
 *   - array order preserved (order is meaning)
 *   - undefined, functions, symbols, NaN, +/-Infinity and BigInt are REJECTED
 *     rather than coerced -- JSON.stringify turns several of these into null
 *     or drops the key entirely, which is exactly how two different records
 *     end up with one hash
 *   - Date is rejected: callers convert to an explicit epoch integer, so the
 *     hash never depends on a timezone or a formatting choice
 */
import crypto from 'crypto';

function canonicalise(value: unknown, path: string): string {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`attestationCanonical: non-finite number at ${path}`);
    }
    // -0 and 0 must not hash differently.
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (t === 'bigint') {
    throw new Error(`attestationCanonical: bigint at ${path} — convert to a string or a safe integer`);
  }
  if (t === 'undefined' || t === 'function' || t === 'symbol') {
    throw new Error(`attestationCanonical: ${t} at ${path} — not representable`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v, i) => canonicalise(v, `${path}[${i}]`)).join(',')}]`;
  }

  if (value instanceof Date) {
    throw new Error(`attestationCanonical: Date at ${path} — pass an explicit epoch integer`);
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => {
      if (obj[k] === undefined) {
        throw new Error(`attestationCanonical: undefined at ${path}.${k} — omit the key or use null`);
      }
      return `${JSON.stringify(k)}:${canonicalise(obj[k], `${path}.${k}`)}`;
    });
    return `{${parts.join(',')}}`;
  }

  throw new Error(`attestationCanonical: unsupported type ${t} at ${path}`);
}

/** Deterministic JSON. Same input, same bytes, on any machine, forever. */
export function canonicalJson(value: unknown): string {
  return canonicalise(value, '$');
}

/** base64url(sha256(canonicalJson(value))) — 43 chars, matching the intent hash form. */
export function canonicalHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('base64url');
}
