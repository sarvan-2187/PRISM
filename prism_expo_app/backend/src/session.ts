/**
 * Sessions for a client with no cookie jar.
 *
 * React Native's fetch does not persist Set-Cookie, so the app carries the
 * session as a Bearer token instead. It is the SAME signed token the web
 * backend issues — `keyManager.signSession` — so both surfaces validate
 * identically and neither can mint one the other would not accept.
 *
 * The browser keeps its httpOnly cookie precisely because a browser can be
 * XSS'd and cannot be trusted to hold a token in reachable storage. A native
 * app has an OS keychain, which a page does not.
 */
import { Request, Response, NextFunction } from 'express';
import { keyManager } from '../../../backend/src/modules/keys/keyManager';
import { fail } from '../../../backend/src/api/errors';

export const SESSION_TTL_SECONDS = 60 * 60 * 8;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export async function mintToken(userId: string): Promise<string> {
  return keyManager.signSession(userId, SESSION_TTL_SECONDS);
}

/** Populates req.userId from a Bearer token. Never rejects; requireSession does. */
export async function attachSession(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  if (token) {
    try {
      const { userId } = await keyManager.verifySession(token);
      req.userId = userId;
    } catch {
      // Forged or expired reads as anonymous, so the client gets a clean 401
      // from requireSession with a failure code it already knows.
    }
  }
  next();
}

export function requireSession(req: Request, _res: Response, next: NextFunction): void {
  if (!req.userId) fail('AUTH_FAILED');
  next();
}
