import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import {
  readAssignedFieldExecutionScopeDetail,
  readAssignedFieldMaterials,
  readAssignedFieldQuotationSnapshot,
  readAssignedFieldRequestDetail,
  readMyHandymanFieldFeed,
} from './handyman-field-feed.service';

function ensureEmptyQuery(req: Request): void {
  if (Object.keys(req.query).length) {
    throw AppError.validation('Query parameters not supported.');
  }
}

export function createHandymanFieldFeedRouter(): Router {
  const r = Router();

  r.get(
    '/handyman/field/my-jobs',
    authenticationMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        ensureEmptyQuery(req);
        sendSuccess(res, await readMyHandymanFieldFeed(req.auth.userId));
      } catch (error) {
        next(error);
      }
    },
  );

  for (const path of [
    '/handyman/field/work-orders/:executionScopeId',
    '/handyman/field/execution-scopes/:executionScopeId',
  ]) {
    r.get(
      path,
      authenticationMiddleware,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          ensureEmptyQuery(req);
          sendSuccess(
            res,
            await readAssignedFieldExecutionScopeDetail(
              String(req.params.executionScopeId ?? ''),
              req.auth.userId,
            ),
          );
        } catch (error) {
          next(error);
        }
      },
    );
  }

  r.get(
    '/handyman/field/execution-scopes/:executionScopeId/quotation-snapshot',
    authenticationMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        ensureEmptyQuery(req);
        sendSuccess(
          res,
          await readAssignedFieldQuotationSnapshot(
            String(req.params.executionScopeId ?? ''),
            req.auth.userId,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  r.get(
    '/handyman/field/execution-scopes/:executionScopeId/materials',
    authenticationMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        ensureEmptyQuery(req);
        sendSuccess(
          res,
          await readAssignedFieldMaterials(
            String(req.params.executionScopeId ?? ''),
            req.auth.userId,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  r.get(
    '/handyman/field/requests/:handymanRequestId',
    authenticationMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        ensureEmptyQuery(req);
        sendSuccess(
          res,
          await readAssignedFieldRequestDetail(
            String(req.params.handymanRequestId ?? ''),
            req.auth.userId,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  return r;
}
