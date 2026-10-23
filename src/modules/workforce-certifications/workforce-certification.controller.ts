import type { NextFunction, Request, Response } from 'express';
import { authenticationRequiredError } from '../auth/auth.errors';
import { sendSuccess } from '../../shared/api-response';
import type { WorkforceCertificationActor } from './workforce-certification.types';
import { workforceCertificationService } from './workforce-certification.service';
import {
  validateCertificationIdParam,
  validateCreateWorkforceCertificationInput,
  validateDeactivateWorkforceCertificationInput,
  validateListExpiringWorkforceCertificationsFilter,
  validateListWorkforceCertificationsFilter,
  validateUpdateWorkforceCertificationInput,
  validateVerifyWorkforceCertificationInput,
  validateWorkforceIdParam,
} from './workforce-certification.validation';

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? '' : (value ?? '');
}

/**
 * PART 02 — resolves the authenticated actor for the domain service.
 *
 * `AuthContext` carries the identity; the service resolves effective
 * permissions itself (`permissionService.resolvePermissionsForUser`), so no
 * permission list is trusted from the transport. Keeping the mapping in one
 * place means a controller can never accidentally hand the service an
 * unauthenticated actor.
 */
function actorFromRequest(req: Request): WorkforceCertificationActor {
  if (!req.auth) {
    throw authenticationRequiredError();
  }
  return {
    id: req.auth.userId,
    email: req.auth.user?.email,
    displayName: req.auth.user?.displayName ?? null,
    status: req.auth.user?.status,
    sessionId: req.auth.sessionId,
  };
}

/**
 * `GET /workforce/:workforceId/certifications`
 *
 * The Workforce Profile always comes from the route and is never read from the
 * body or the query, so a caller cannot redirect a read to another profile.
 */
export async function listWorkforceCertificationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = validateWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const filter = validateListWorkforceCertificationsFilter(req.query);
    const certifications =
      await workforceCertificationService.listWorkforceCertifications(
        workforceProfileId,
        filter,
        actorFromRequest(req),
      );
    sendSuccess(res, certifications);
  } catch (error) {
    next(error);
  }
}

export async function getWorkforceCertificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = validateWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const certificationId = validateCertificationIdParam(
      paramString(req.params.certificationId),
    );
    const certification =
      await workforceCertificationService.getWorkforceCertificationById(
        workforceProfileId,
        certificationId,
        actorFromRequest(req),
      );
    sendSuccess(res, certification);
  } catch (error) {
    next(error);
  }
}

export async function createWorkforceCertificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = validateWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const input = validateCreateWorkforceCertificationInput(req.body);
    const certification =
      await workforceCertificationService.createWorkforceCertification(
        workforceProfileId,
        input,
        actorFromRequest(req),
      );
    sendSuccess(res, certification, 201);
  } catch (error) {
    next(error);
  }
}

export async function updateWorkforceCertificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = validateWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const certificationId = validateCertificationIdParam(
      paramString(req.params.certificationId),
    );
    const input = validateUpdateWorkforceCertificationInput(req.body);
    const certification =
      await workforceCertificationService.updateWorkforceCertification(
        workforceProfileId,
        certificationId,
        input,
        actorFromRequest(req),
      );
    sendSuccess(res, certification);
  } catch (error) {
    next(error);
  }
}

export async function verifyWorkforceCertificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = validateWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const certificationId = validateCertificationIdParam(
      paramString(req.params.certificationId),
    );
    const input = validateVerifyWorkforceCertificationInput(req.body);
    const certification =
      await workforceCertificationService.verifyWorkforceCertification(
        workforceProfileId,
        certificationId,
        input,
        actorFromRequest(req),
      );
    sendSuccess(res, certification);
  } catch (error) {
    next(error);
  }
}

export async function deactivateWorkforceCertificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = validateWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const certificationId = validateCertificationIdParam(
      paramString(req.params.certificationId),
    );
    const input = validateDeactivateWorkforceCertificationInput(req.body);
    const certification =
      await workforceCertificationService.deactivateWorkforceCertification(
        workforceProfileId,
        certificationId,
        actorFromRequest(req),
        input,
      );
    sendSuccess(res, certification);
  } catch (error) {
    next(error);
  }
}

export async function listExpiringWorkforceCertificationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filter = validateListExpiringWorkforceCertificationsFilter(
      req.query,
    );
    const items =
      await workforceCertificationService.listExpiringWorkforceCertifications(
        filter,
        actorFromRequest(req),
      );
    sendSuccess(res, items, 200, { days: filter.days });
  } catch (error) {
    next(error);
  }
}
