import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { authenticationRequiredError } from '../auth/auth.errors';
import { requirePermission } from '../auth/rbac.middleware';
import { sendSuccess } from '../../shared/api-response';
import {
  authorizeScopeHelperPersonnelChange,
  confirmFieldHelperAttendance,
  getFieldHelperAttendance,
  getOperationsHelperAttendance,
} from './handyman-helper-attendance.service';

export const handymanHelperAttendanceRouter = Router();

export function createHandymanHelperAttendanceRouter(): Router {
  return handymanHelperAttendanceRouter;
}

const paramStr = (val: string | string[] | undefined): string =>
  Array.isArray(val) ? (val[0] ?? '') : (val ?? '');

// Path-scoped authentication walls — never path-less router.use(auth)
handymanHelperAttendanceRouter.use(
  '/handyman/field/execution-scopes/:executionScopeId/helper-attendance',
  authenticationMiddleware,
);
handymanHelperAttendanceRouter.use(
  '/handyman/execution-scopes/:executionScopeId/helper-attendance',
  authenticationMiddleware,
);

// --- Mobile Field Endpoints (Crew Lead / PIC Pekerjaan) ---

handymanHelperAttendanceRouter.get(
  '/handyman/field/execution-scopes/:executionScopeId/helper-attendance',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await getFieldHelperAttendance(
        req.auth.userId,
        paramStr(req.params.executionScopeId),
        req.query,
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanHelperAttendanceRouter.post(
  '/handyman/field/execution-scopes/:executionScopeId/helper-attendance/confirm',
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await confirmFieldHelperAttendance(
        req.auth.userId,
        paramStr(req.params.executionScopeId),
        req.body,
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

// --- Operations Endpoints (RBAC + exact-Building scope) ---

handymanHelperAttendanceRouter.get(
  '/handyman/execution-scopes/:executionScopeId/helper-attendance',
  requirePermission('tenant_company.read'),
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await getOperationsHelperAttendance(
        req.auth.userId,
        paramStr(req.params.executionScopeId),
        req.query,
      );
      sendSuccess(res, result, 200);
    } catch (error) {
      next(error);
    }
  },
);

handymanHelperAttendanceRouter.post(
  '/handyman/execution-scopes/:executionScopeId/helper-attendance/personnel-changes',
  requirePermission('tenant_company.manage'),
  async (req, res, next) => {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const result = await authorizeScopeHelperPersonnelChange(
        req.auth.userId,
        paramStr(req.params.executionScopeId),
        req.body,
      );
      sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (error) {
      next(error);
    }
  },
);
