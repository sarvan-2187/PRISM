import dotenv from 'dotenv';
import path from 'path';

// .env lives at the repo root, but npm scripts run with cwd=backend/.
// Load the root file first, then any backend-local override. dotenv never
// overwrites variables that are already set, so docker-compose wins.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // PostgreSQL
  databaseUrl: requireEnv('DATABASE_URL'),

  // Redis
  redisUrl: requireEnv('REDIS_URL'),

  // WebAuthn / FIDO2
  webauthn: {
    rpId: requireEnv('WEBAUTHN_RP_ID'),
    rpName: requireEnv('WEBAUTHN_RP_NAME'),
    expectedOrigin: requireEnv('WEBAUTHN_EXPECTED_ORIGIN'),
  },

  // Key Management — read ONLY by KeyManagementModule, never by other modules.
  jwtSecret: requireEnv('JWT_SECRET'),
  // Ed25519 private key (PKCS#8 PEM) for signing QR tokens. Optional: when
  // absent, KeyManagementModule generates an ephemeral keypair at boot, which
  // is fine for a demo and explicitly not how this would run in production.
  qrSigningKeyPem: process.env.QR_SIGNING_KEY || null,
} as const;
