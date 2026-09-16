import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  cancelHandymanInspection,
  completeHandymanInspection,
  getHandymanInspection,
  listHandymanInspections,
  openHandymanInspection,
} from './handyman-inspection.service';
import {
  getHandymanRequestService,
  listHandymanRequestServices,
  selectHandymanRequestService,
  supersedeHandymanRequestServiceSelection,
} from './handyman-service-selection.service';
import {
  getHandymanRequestTriage,
  listHandymanRequestTriages,
  triageHandymanRequest,
} from './handyman-triage.service';
import {
  parseCompleteHandymanInspectionHttpBody,
  parseEmptyCommandBody,
  parseHandymanInspectionIdParam,
  parseHandymanRequestIdPathParam,
  parseHandymanRequestServiceIdParam,
  parseHandymanRequestServiceListQuery,
  parseHandymanRequestTriageIdParam,
  parseOpenHandymanInspectionHttpBody,
  parseSelectHandymanRequestServiceHttpBody,
  parseTriageHandymanRequestHttpBody,
} from './handyman-request-governance.validation';

/**
 * CR-HM-BE-03 RUN 4 — thin HTTP handlers for the Run 1 governance authority
 * (triage / re-triage, request-service selection and supersede, inspection
 * open/complete/cancel and governed reads). The request scope comes from the
 * route, the actor only from the authenticated session, and every business
 * rule stays in the governance services; these handlers only parse governed
 * inputs and delegate. Errors flow to the shared Express error pipeline.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

export async function triageHandymanRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const requestId = parseHandymanRequestIdPathParam(
      param(req.params.handymanRequestId),
    );
    const body = parseTriageHandymanRequestHttpBody(req.body);
    sendSuccess(
      res,
      await triageHandymanRequest({ requestId, ...body }, actor(req)),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listHandymanRequestTriagesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const requestId = parseHandymanRequestIdPathParam(
      param(req.params.handymanRequestId),
    );
    sendSuccess(res, await listHandymanRequestTriages(requestId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function getHandymanRequestTriageHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const triageId = parseHandymanRequestTriageIdParam(param(req.params.triageId));
    sendSuccess(res, await getHandymanRequestTriage(triageId, actor(req)));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Request services
// ---------------------------------------------------------------------------

export async function selectHandymanRequestServiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const requestId = parseHandymanRequestIdPathParam(
      param(req.params.handymanRequestId),
    );
    const body = parseSelectHandymanRequestServiceHttpBody(req.body);
    sendSuccess(
      res,
      await selectHandymanRequestService({ requestId, ...body }, actor(req)),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listHandymanRequestServicesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const requestId = parseHandymanRequestIdPathParam(
      param(req.params.handymanRequestId),
    );
    const filters = parseHandymanRequestServiceListQuery(req.query);
    sendSuccess(
      res,
      await listHandymanRequestServices(requestId, actor(req), filters),
    );
  } catch (error) {
    next(error);
  }
}

export async function getHandymanRequestServiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const selectionId = parseHandymanRequestServiceIdParam(
      param(req.params.selectionId),
    );
    sendSuccess(res, await getHandymanRequestService(selectionId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function supersedeHandymanRequestServiceSelectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const selectionId = parseHandymanRequestServiceIdParam(
      param(req.params.selectionId),
    );
    parseEmptyCommandBody(req.body);
    sendSuccess(
      res,
      await supersedeHandymanRequestServiceSelection(selectionId, actor(req)),
    );
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Inspections
// ---------------------------------------------------------------------------

export async function openHandymanInspectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const requestId = parseHandymanRequestIdPathParam(
      param(req.params.handymanRequestId),
    );
    const body = parseOpenHandymanInspectionHttpBody(req.body);
    sendSuccess(
      res,
      await openHandymanInspection({ requestId, ...body }, actor(req)),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listHandymanInspectionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const requestId = parseHandymanRequestIdPathParam(
      param(req.params.handymanRequestId),
    );
    sendSuccess(res, await listHandymanInspections(requestId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function getHandymanInspectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const inspectionId = parseHandymanInspectionIdParam(
      param(req.params.inspectionId),
    );
    sendSuccess(res, await getHandymanInspection(inspectionId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function completeHandymanInspectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const inspectionId = parseHandymanInspectionIdParam(
      param(req.params.inspectionId),
    );
    const body = parseCompleteHandymanInspectionHttpBody(req.body);
    sendSuccess(
      res,
      await completeHandymanInspection(inspectionId, body, actor(req)),
    );
  } catch (error) {
    next(error);
  }
}

export async function cancelHandymanInspectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const inspectionId = parseHandymanInspectionIdParam(
      param(req.params.inspectionId),
    );
    parseEmptyCommandBody(req.body);
    sendSuccess(res, await cancelHandymanInspection(inspectionId, actor(req)));
  } catch (error) {
    next(error);
  }
}
