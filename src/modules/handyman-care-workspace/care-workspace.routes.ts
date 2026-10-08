import { getCareWorkspaceRequestDetail } from './care-workspace-request-detail.service';
import { listCareWorkspaceRequests } from './care-workspace-requests.service';
import { issueCareCreateExchange } from './care-create-exchange.service';
import { readCareWorkspaceCatalogue } from './care-workspace-catalogue.service';
import { Router } from 'express';
import { listCareWorkspaceScope, listCareWorkspaceTenants, listCareWorkspaceSpaces, listCareWorkspaceOccupancies } from './care-workspace-scope.service';
import { getAppConfig } from '../../config';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { isLoginRateLimited, recordLoginFailure } from '../auth/login-rate-limit';
import { admitCareWorkspace, revokeCareWorkspaceSession, workspaceUnauthorized } from './care-workspace.service';

/** Care-only credential surface; no local User middleware or grant administration. */
export function createCareWorkspaceRouter(): Router {
  const router = Router();
  router.post('/handyman/care/session', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      // Existing local login-throttle convention, isolated namespace and socket
      // address (never trust a forwarded header). Count all admission attempts.
      const key = `handyman-care-workspace:${req.socket.remoteAddress ?? 'unknown'}`;
      if (isLoginRateLimited(key)) {
        res.setHeader('Retry-After', String(getAppConfig().security.loginRateLimitWindowMinutes * 60));
        throw new AppError({ code: 'AUTH_RATE_LIMITED', message: 'Too many admission attempts.', statusCode: 429 });
      }
      recordLoginFailure(key);
      if (Object.keys(req.query).length) throw AppError.validation('Query parameters are not accepted.');
      const admitted = await admitCareWorkspace(req.body, req.header('x-hub-signature-256'));
      sendSuccess(res, admitted, 201);
    } catch (error) { next(error); }
  });
  router.delete('/handyman/care/session', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      if (Object.keys(req.query).length ||
          (req.body !== undefined && (typeof req.body !== 'object' || req.body === null ||
            Array.isArray(req.body) || Object.keys(req.body).length))) {
        throw AppError.validation('Logout does not accept context fields.');
      }
      await revokeCareWorkspaceSession(match[1]);
      res.status(204).end();
    } catch (error) { next(error); }
  });
  router.get(['/handyman/care/properties', '/handyman/care/properties/:propertyId/buildings'], async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      const result = await listCareWorkspaceScope(match[1], req.query, req.params.propertyId, req.body);
      sendSuccess(res, result);
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/properties/:propertyId/tenant-companies', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      sendSuccess(res, await listCareWorkspaceTenants(match[1], req.query, req.params.propertyId, req.body));
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/properties/:propertyId/spaces', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      sendSuccess(res, await listCareWorkspaceSpaces(match[1], req.query, req.params.propertyId, req.body));
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/properties/:propertyId/occupancies', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      sendSuccess(res, await listCareWorkspaceOccupancies(match[1], req.query, req.params.propertyId, req.body));
    } catch (error) { next(error); }
  });
  for (const [path, kind] of [
    ['/handyman/care/properties/:propertyId/catalogue/services', 'services'],
    ['/handyman/care/properties/:propertyId/catalogue/material-profiles', 'profiles'],
    ['/handyman/care/properties/:propertyId/catalogue/material-profiles/:profileId', 'profiles'],
  ] as const) {
    router.get(path, async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
        if (!match) throw workspaceUnauthorized();
        const profileId = 'profileId' in req.params ? req.params.profileId : undefined;
        sendSuccess(res, await readCareWorkspaceCatalogue(match[1], req.params.propertyId,
          kind, req.query, profileId, req.body));
      } catch (error) { next(error); }
    });
  }
  router.post('/handyman/care/properties/:propertyId/create-exchanges', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      sendSuccess(res, await issueCareCreateExchange(match[1], req.params.propertyId, req.body, req.query), 201);
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/requests', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      sendSuccess(res, await listCareWorkspaceRequests(match[1], req.query, req.body));
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/requests/:requestId', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      sendSuccess(res, await getCareWorkspaceRequestDetail(match[1], req.params.requestId, req.query, req.body));
    } catch (error) { next(error); }
  });
  return router;
}
