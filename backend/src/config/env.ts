import dotenv from 'dotenv';
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

  // Key Management (loaded ONLY by KeyManagementModule)
  jwtSecret: requireEnv('JWT_SECRET'),
  qrSigningKey: requireEnv('QR_SIGNING_KEY'),
} as const;
