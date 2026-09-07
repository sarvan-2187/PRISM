/**
 * Drives one complete, real legitimate payment through the actual PRISM API
 * — initiate, challenge, sign with a real Ed25519 credential, authorize.
 * Used by (a) the "run a legit transaction" control feature so the dashboard
 * can show a real payment succeeding, and (b) attack scenarios that first
 * need a real settled/step-up transaction to attack (replay, brute force).
 */
import { establishDeviceSession, DeviceSession } from './deviceSession';
import { post } from './httpClient';
import { AttackContext } from './types';

export interface LegitPaymentParams {
  userId: string;
  email: string;
  payeeAccountId: string;
  amountMinor: number;
  /** How quickly to "approve" after the challenge is issued — low values trip HASTY_APPROVAL. */
  deliberationMs?: number;
  /** Reuse an existing device session instead of creating a new one. */
  session?: DeviceSession;
}

export interface LegitPaymentResult {
  txId: string;
  session: DeviceSession;
  initiate: Awaited<ReturnType<typeof post>>;
  authorize: Awaited<ReturnType<typeof post>>;
  /** The exact body sent to POST /payment/:id/authorize — for replay attacks to resend verbatim. */
  authorizeRequestBody: Record<string, unknown>;
}

export async function runLegitPayment(
  ctx: AttackContext,
  params: LegitPaymentParams
): Promise<LegitPaymentResult> {
  const session = params.session ?? (await establishDeviceSession(params.userId, params.email));
  if (!params.session) {
    await ctx.log('LEGITIMATE', 'IDENTITY', 'Legitimate device registered a real passkey and logged in', {
      email: params.email,
    });
  }

  const initiate = await post(
    '/api/v1/payment/initiate',
    { payeeAccountId: params.payeeAccountId, amountMinor: params.amountMinor },
    { cookie: session.cookie }
  );
  if (initiate.status !== 201) {
    throw new Error(`payment/initiate failed: ${initiate.status} ${JSON.stringify(initiate.body)}`);
  }
  const txId = initiate.body.txId as string;
  await ctx.log('LEGITIMATE', 'INTENT', `Transaction locked — ${initiate.body.amountFormatted} to ${initiate.body.payeeHandle}`, {
    txId,
    intentHash: initiate.body.intentHash,
  });

  const challenge = await post(`/api/v1/payment/${txId}/challenge`, {}, { cookie: session.cookie });
  if (challenge.status !== 200) {
    throw new Error(`challenge failed: ${challenge.status} ${JSON.stringify(challenge.body)}`);
  }
  await ctx.log('LEGITIMATE', 'IDENTITY', 'WebAuthn assertion challenge issued (challenge = intent hash)', { txId });

  if (params.deliberationMs) await new Promise((r) => setTimeout(r, params.deliberationMs));

  const assertion = session.credential.sign(challenge.body.challenge);
  await ctx.log('LEGITIMATE', 'IDENTITY', 'Real Ed25519-signed assertion produced by the device credential', {
    txId,
    deliberationMs: params.deliberationMs ?? 0,
  });

  const authorizeRequestBody = { assertion, deliberationMs: params.deliberationMs ?? 0 };
  const authorize = await post(`/api/v1/payment/${txId}/authorize`, authorizeRequestBody, {
    cookie: session.cookie,
  });
  await ctx.log(
    'PRISM',
    authorize.status === 200 ? 'AUTHORIZATION' : authorize.status === 202 ? 'RISK' : 'AUTHORIZATION',
    `Authorize response: ${authorize.status} ${authorize.body?.decision ?? authorize.body?.failureCode ?? ''}`.trim(),
    { txId, response: authorize.body }
  );

  return { txId, session, initiate, authorize, authorizeRequestBody };
}
