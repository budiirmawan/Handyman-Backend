import { Router } from 'express';
import { getAppConfig } from '../../config';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import {
  isLoginRateLimited,
  recordLoginFailure,
  recordLoginSuccess,
} from '../auth/login-rate-limit';
import {
  admitPicWorkspace,
  readPicWorkspaceBearer,
  readPicWorkspaceSession,
  revokePicWorkspaceSession,
} from './pic-workspace-session.service';

/**
 * W03 PART 03C — the PIC credential surface, and NOTHING else (A01 §13
 * "03B — session foundation": `POST`/`DELETE /handyman/pic/session`; this PART
 * adds the third verb `GET`, the session introspection the owner asked for, and
 * no more).
 *
 * There is deliberately no `authenticationMiddleware()` and no
 * `requirePermission()` on any route here (rules 1 and 2, A1/A2): admission is
 * authenticated by the HMAC assertion, use is authenticated by the session
 * store, and a Tenant PIC holds no RBAC grant. Mounting this router next to the
 * staff and care routers — as its OWN router with its own table and its own
 * token prefix — is what makes rule 19 ("no fallback between credential kinds")
 * true by construction: this code path cannot reach `user_sessions`, care
 * workspace sessions, or the handoff exchange store, because it never consults
 * them.
 *
 * The PIC decision endpoint is NOT here. It belongs to `03E` (A01 §13), and the
 * ledger-side session column landed in `0442` precisely so that when 03E ships,
 * an unattributed PIC decision is impossible at the database, not merely
 * unimplemented at the route.
 */
export function createPicWorkspaceRouter(): Router {
  const router = Router();

  router.post('/handyman/pic/session', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    // Rule 7 — the existing local login-throttle convention, in an ISOLATED
    // namespace keyed on the socket address (never a forwarded header). Only a
    // FAILED admission spends quota, a success resets it, and a 429 rejection
    // is never charged back to the same key: a BM host relaying admissions
    // server-to-server must not exhaust every operator behind one egress
    // address. Same reasoning as the care-workspace router; separate namespace,
    // so hammering one credential kind cannot lock the other.
    const key = `handyman-pic-workspace:${req.socket.remoteAddress ?? 'unknown'}`;
    try {
      if (isLoginRateLimited(key)) {
        res.setHeader(
          'Retry-After',
          String(getAppConfig().security.loginRateLimitWindowMinutes * 60),
        );
        throw new AppError({
          code: 'AUTH_RATE_LIMITED',
          message: 'Too many admission attempts.',
          statusCode: 429,
        });
      }
      // Rule 8 — no query parameters, and the body is the signed assertion and
      // nothing else (unknown keys are refused inside the service, T1).
      if (Object.keys(req.query).length) {
        throw AppError.validation('Query parameters are not accepted.');
      }
      const admitted = await admitPicWorkspace(
        req.body,
        req.header('x-hub-signature-256'),
      );
      recordLoginSuccess(key);
      sendSuccess(res, admitted, 201);
    } catch (error) {
      if (!(error instanceof AppError) || error.statusCode !== 429) {
        recordLoginFailure(key);
      }
      next(error);
    }
  });

  router.get('/handyman/pic/session', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { token } = readPicWorkspaceBearer(
        req.header('authorization'),
        req.query,
        undefined,
      );
      sendSuccess(res, await readPicWorkspaceSession(token));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/handyman/pic/session', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      // Rule 18: a Bearer token and nothing else — no context fields, and an
      // already-revoked unexpired token is accepted (idempotent logout).
      const { token } = readPicWorkspaceBearer(
        req.header('authorization'),
        req.query,
        req.body,
      );
      await revokePicWorkspaceSession(token);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
