import { Router, type NextFunction, type Request, type Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { authenticationRequiredError } from '../auth';
import { getCompletionManifest, listCompletionDeclarations, recordCompletionDeclaration, revokeCompletionDeclaration,
  submitCompletionManifest, verifyCompletionManifest } from './handyman-completion-manifest.service';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
function body(req: Request, permitted: string[]): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body as object).some(key => !permitted.includes(key))) {
    throw AppError.validation('Unexpected or invalid completion request fields.');
  }
  return req.body as Record<string, unknown>;
}
function handler(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try { sendSuccess(res, await fn(req)); } catch (error) { next(error); }
  };
}

/** Authentication never grants item authority: services re-resolve exact
 * Building/Lead or assigned QC Supervisor, and ignore helper attendance. */
export function createHandymanCompletionManifestRouter(): Router {
  const router = Router(), auth = authenticationMiddleware;
  const scope = '/handyman/execution-scopes/:executionScopeId';
  router.post(`${scope}/work-sessions/:sessionId/completion-declarations`, auth, handler(req =>
    recordCompletionDeclaration(param(req.params.executionScopeId), param(req.params.sessionId),
      body(req, ['quotationLineId', 'variationId', 'actualQty', 'evidenceReference', 'idempotencyKey']), actor(req))));
  router.get(`${scope}/completion-declarations`, auth, handler(req =>
    listCompletionDeclarations(param(req.params.executionScopeId), actor(req))));
  router.post(`${scope}/completion-declarations/:declarationId/revoke`, auth, handler(req =>
    revokeCompletionDeclaration(param(req.params.executionScopeId), param(req.params.declarationId),
      body(req, ['reason', 'idempotencyKey']), actor(req))));
  router.post(`${scope}/completion-manifests`, auth, handler(req =>
    submitCompletionManifest(param(req.params.executionScopeId), body(req, ['idempotencyKey']), actor(req))));
  router.get(`${scope}/completion-manifests/:manifestId`, auth, handler(req =>
    getCompletionManifest(param(req.params.executionScopeId), param(req.params.manifestId), actor(req))));
  router.post(`${scope}/completion-manifests/:manifestId/verify`, auth, handler(req =>
    verifyCompletionManifest(param(req.params.executionScopeId), param(req.params.manifestId),
      body(req, ['qcRunId', 'qcRunVersion', 'manifestVersion', 'manifestSha256', 'reviewed', 'idempotencyKey']), actor(req))));
  return router;
}
