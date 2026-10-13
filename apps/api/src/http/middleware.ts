import type { Request, Response, NextFunction } from 'express';
import { InviteError } from '../auth/invites.ts';
import { CarrierLeakError } from '@safeside/shared';
import { NotFoundError } from '../db/scoped.ts';
import { resolveSession, SESSION_COOKIE, type SessionUser } from '../auth/sessions.ts';
import type { AppContext } from '../context.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      ctx: AppContext;
    }
  }
}

export function attachContext(ctx: AppContext) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.ctx = ctx;
    next();
  };
}

/**
 * Resolve the session cookie to a user, or 401.
 *
 * Every route touching proposal data sits behind this. It only establishes WHO is
 * calling — it says nothing about what they may see. Ownership is a separate
 * check in db/scoped.ts, applied per query, because an authenticated user is
 * still not entitled to another broker's proposals.
 */
export function requireUser() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await resolveSession(req.ctx.db, req.cookies?.[SESSION_COOKIE]);
      if (!user) {
        res.status(401).json({ error: 'Not signed in' });
        return;
      }
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Narrow an authenticated request without repeating the non-null assertion. */
/**
 * Admins only. Mounted after requireUser, so req.user is already set.
 *
 * is_admin was recorded on every account from the start and checked nowhere.
 * Inviting people is the first thing that genuinely needs it: whoever can create
 * invites decides who gets into a system holding client data.
 */
export function requireAdmin() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.is_admin) {
      res.status(403).json({ error: 'Only an admin can do that.' });
      return;
    }
    next();
  };
}

export function currentUser(req: Request): SessionUser {
  if (!req.user) throw new Error('currentUser called on an unauthenticated request');
  return req.user;
}

export class ValidationError extends Error {
  readonly status = 400;
  readonly details: string[];
  constructor(details: string[]) {
    super(details[0] ?? 'Invalid request');
    this.name = 'ValidationError';
    this.details = details;
  }
}

/**
 * Terminal error handler.
 *
 * Client errors carry their message through; anything unrecognised becomes a
 * generic 500 with the detail logged rather than returned. An internal message
 * can name a table, a column or a file path, and none of that belongs in a
 * response.
 */
export function errorHandler() {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message, details: err.details });
      return;
    }
    // A dead invite link is 410 Gone rather than 404: the link was real, it just
    // no longer works, and the page can say why.
    if (err instanceof InviteError) {
      const status = { invalid: 404, expired: 410, used: 410, revoked: 410, exists: 409, bad_input: 400 }[err.code];
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    // Generation refused because the document named a carrier. 422 with the
    // offending fields, so the review screen can point at them.
    if (err instanceof CarrierLeakError) {
      res.status(422).json({
        error: 'Generation blocked: the document contains carrier information.',
        leak_findings: err.findings,
      });
      return;
    }
    console.error('[api] unhandled error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  };
}

/** Wrap an async handler so a rejected promise reaches the error handler. */
export function handler(
  fn: (req: Request, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/**
 * Read a route parameter as a string.
 *
 * Express 5 types params as `string | string[]` because a path can repeat a name.
 * None of ours do, so this narrows once here rather than casting at every call
 * site — and throws rather than silently coercing an array, which would otherwise
 * reach a query as "a,b".
 */
export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  if (typeof value === 'string') return value;
  throw new ValidationError([`Missing or repeated route parameter: ${name}`]);
}
