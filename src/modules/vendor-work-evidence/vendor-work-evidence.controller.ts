import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { vendorWorkEvidenceService } from './vendor-work-evidence.service';
import {
  parseEvidenceIdParam,
  parseSubmitVendorWorkEvidenceBody,
  parseVendorWorkEvidenceFilters,
  parseVendorWorkIdParam,
} from './vendor-work-evidence.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** GET /vendor-works/:id/evidence-requirements */
export async function listRequirementsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorWorkId = parseVendorWorkIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const requirements =
      await vendorWorkEvidenceService.resolveVendorWorkEvidenceRequirements(
        vendorWorkId,
        req.auth.userId,
      );
    sendSuccess(res, requirements);
  } catch (error) {
    next(error);
  }
}

/** POST /vendor-works/:id/evidence */
export async function submitEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorWorkId = parseVendorWorkIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const input = parseSubmitVendorWorkEvidenceBody(req.body);
    const evidence = await vendorWorkEvidenceService.submitVendorWorkEvidence({
      ...input,
      vendorWorkId,
      submittedByUserId: req.auth.userId,
    });
    sendSuccess(res, evidence, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /vendor-works/:id/evidence */
export async function listEvidenceForWorkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorWorkId = parseVendorWorkIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const evidence = await vendorWorkEvidenceService.listVendorWorkEvidence(
      vendorWorkId,
      req.auth.userId,
    );
    sendSuccess(res, evidence);
  } catch (error) {
    next(error);
  }
}

/** GET /vendor-work-evidence?vendorWorkId= & vendorId= & buildingId= */
export async function listEvidenceByFiltersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseVendorWorkEvidenceFilters(
      req.query as Record<string, unknown>,
    );

    if (filters.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filters.buildingId,
      );
    }
    const accessibleBuildingIds =
      await contextAccessService.getAccessibleBuildingIds(req.auth.userId);

    const evidence =
      await vendorWorkEvidenceService.listVendorWorkEvidenceByFilters(
        filters,
        req.auth.userId,
        accessibleBuildingIds,
      );
    sendSuccess(res, evidence);
  } catch (error) {
    next(error);
  }
}

/** PATCH /vendor-work-evidence/:evidenceId */
export async function removeEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const evidenceId = parseEvidenceIdParam(paramString(req.params.evidenceId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const evidence = await vendorWorkEvidenceService.removeVendorWorkEvidence(
      evidenceId,
      req.auth.userId,
    );
    sendSuccess(res, evidence);
  } catch (error) {
    next(error);
  }
}
