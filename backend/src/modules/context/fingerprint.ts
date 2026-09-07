/**
 * Context Module
 * Captures device/network/session micro-fingerprint and detects anomalous drift.
 *
 * PRISM Flow Stage: Context verification (Layer 4 of 4-layer binding)
 */
import { Request } from 'express';
import redis from '../../utils/redis';

export interface ContextSnapshot {
  ipAddress: string;
  userAgent: string;
  acceptLanguage: string;
  // TODO: Extend with device fingerprint fields (screen res, timezone, etc.)
}

export interface ContextResult {
  snapshot: ContextSnapshot;
  /** 0.0 = identical to baseline; 1.0 = completely anomalous */
  driftScore: number;
  isSuspicious: boolean;
}

export class ContextModule {

  /**
   * Extract a micro-fingerprint from the incoming HTTP request.
   */
  extractSnapshot(req: Request): ContextSnapshot {
    return {
      ipAddress: req.ip ?? 'unknown',
      userAgent: req.headers['user-agent'] ?? 'unknown',
      acceptLanguage: req.headers['accept-language'] ?? 'unknown',
    };
  }

  /**
   * STAGE: Context Fingerprinting
   * Compares current request snapshot against the user's stored baseline.
   * Returns a drift score for the Risk Engine.
   */
  async evaluateContext(userId: string, current: ContextSnapshot): Promise<ContextResult> {
    // TODO: 1. GET `context:baseline:{userId}` from Redis (JSON string)
    // TODO: 2. If no baseline, store current snapshot as baseline, return { driftScore: 0 }
    // TODO: 3. Compare fields (IP subnet, UA hash, language) → compute driftScore (0.0–1.0)
    // TODO: 4. If driftScore > threshold, flag isSuspicious = true
    // TODO: 5. Optionally update baseline on clean sessions
    // TODO: 6. Return ContextResult
    throw new Error('Not implemented');
  }
}
