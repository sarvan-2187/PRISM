/**
 * Session middleware.
 *
 * Closes the hole the scaffold shipped with: every route used to take a
 * userId from the request body, so anyone could pay as anyone. After a
 * passkey login we issue a signed, httpOnly cookie, and `req.userId` comes
 * from that cookie and nowhere else.
 *
 * Rule for every route below this line: never read a user id from a body,
 * a query string, or a header the client controls.
 */
import { Request, Response, NextFunction } from 'express';
import { keyManager } from '../../modules/keys/keyManager';
import { fail } from '../errors';

export const SESSION_COOKIE = 'prism_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 8;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/** Issue the session cookie after a verified passkey login. */
export async function issueSession(res: Response, userId: string, secure = false): Promise<void> {
  const token = await keyManager.signSession(userId, SESSION_TTL_SECONDS);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, // not readable from JS — XSS cannot lift it
    sameSite: 'lax',
    // Mirror the transport the browser used: HTTPS → Secure cookie, HTTP → plain.
    // In development this is read from the X-Forwarded-Proto header that Vite's
    // proxy adds (xfwd:true), which Express sees as req.secure when trust proxy=1.
    // Without this, cookies issued on https://prism.local:5173 lacked the Secure
    // flag and were dropped by strict browser policies, forcing a second sign-in.
    secure,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
}


export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Populates req.userId when a valid cookie is present. Never rejects. */
export async function attachSession(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    try {
      const { userId } = await keyManager.verifySession(token);
      req.userId = userId;
    } catch {
      // Forged or expired — treat as anonymous rather than erroring, so the
      // client gets a clean 401 from requireSession with a code it knows.
    }
  }
  next();
}

/** Guards every route that moves money or reads private data. */
export function requireSession(req: Request, _res: Response, next: NextFunction): void {
  if (!req.userId) fail('AUTH_FAILED');
  next();
}
