import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { authenticationRequiredError } from '../auth/auth.errors';
import { sendSuccess } from '../../shared/api-response';
import {
  readHandymanWorkerProfileByContextId,
  readMyHandymanWorkerProfileProjection,
} from './handyman-worker-profile.service';

export const handymanWorkerProfileRouter = Router();

export function createHandymanWorkerProfileRouter(): Router {
  return handymanWorkerProfileRouter;
}

// CR-HM-BACKEND-FULL-CAPABILITY-E2E-CLOSURE-01 — scope the transport
// authentication wall to THIS router's own path families (see the
// field-evidence router note). A path-less router.use(auth) would
// 401 every later-mounted /api/v1 route, including unknown routes
// that must 404.
handymanWorkerProfileRouter.use(
  '/handyman/field/me',
  authenticationMiddleware,
);
handymanWorkerProfileRouter.use(
  '/handyman/field/workers',
  authenticationMiddleware,
);

handymanWorkerProfileRouter.get(
  '/handyman/field/me/profile',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const profile = await readMyHandymanWorkerProfileProjection(
        req.auth.userId,
      );
      sendSuccess(res, { profile }, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanWorkerProfileRouter.get(
  '/handyman/field/workers/:workerContextId/profile',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const profile = await readHandymanWorkerProfileByContextId(
        req.auth.userId,
        String(req.params.workerContextId),
      );
      sendSuccess(res, { profile }, 200);
    } catch (error) {
      next(error);
    }
  },
);
