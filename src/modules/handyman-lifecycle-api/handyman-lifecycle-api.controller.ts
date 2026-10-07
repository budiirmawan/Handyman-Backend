import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestInspectionService,
  handymanServiceRequestReferralService,
  handymanServiceRequestTriageService,
} from '../handyman-requests';
import {
  parseLifecycleDiagnosisBody,
  parseLifecycleHandymanRequestIdParam,
  parseLifecycleInspectionBody,
  parseLifecycleReferralBody,
  parseLifecycleTriageBody,
} from './handyman-lifecycle-api.validation';

/**
 * CR-HM-03 PART 05A — Handyman lifecycle HTTP handlers (FROZEN F8).
 *
 * Thin shells only: URL request id + whitelisted body + authenticated
 * actor from `req.auth.userId`. The PART 01–04 services remain the sole
 * authority for state transitions, scope validation, discipline /
 * classification derivation, referral eligibility and immutability — no
 * business rule exists in this layer. The actor is NEVER accepted from the
 * request body.
 */

const p = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;

/** POST /handyman/requests/:handymanRequestId/triage — INTAKE → TRIAGE disposition. */
export async function postHandymanTriageHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseLifecycleHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const input = parseLifecycleTriageBody(req.body);
    const record = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        { ...input, handymanRequestId },
        req.auth.userId,
      );
    sendSuccess(res, record, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/requests/:handymanRequestId/triage — bounded existing record. */
export async function getHandymanTriageHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseLifecycleHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const record = await handymanServiceRequestTriageService
      .getHandymanRequestTriage(handymanRequestId, req.auth.userId);
    sendSuccess(res, record, 200);
  } catch (error) {
    next(error);
  }
}

/** POST /handyman/requests/:handymanRequestId/inspection — INSPECTION_REQUIRED → DIAGNOSIS. */
export async function postHandymanInspectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseLifecycleHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const input = parseLifecycleInspectionBody(req.body);
    const record = await handymanServiceRequestInspectionService
      .recordHandymanInspection(
        { ...input, handymanRequestId },
        req.auth.userId,
      );
    sendSuccess(res, record, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/requests/:handymanRequestId/inspection — bounded existing record. */
export async function getHandymanInspectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseLifecycleHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const record = await handymanServiceRequestInspectionService
      .getHandymanRequestInspection(handymanRequestId, req.auth.userId);
    sendSuccess(res, record, 200);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /handyman/requests/:handymanRequestId/diagnosis — F9
 * discipline-anchored diagnosis. `scopeClassification` is never an input:
 * it is derived from discipline.scopeClass by the PART 03 service.
 */
export async function postHandymanDiagnosisHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseLifecycleHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const input = parseLifecycleDiagnosisBody(req.body);
    const record = await handymanServiceRequestDiagnosisService
      .recordHandymanDiagnosis(
        { ...input, handymanRequestId },
        req.auth.userId,
      );
    sendSuccess(res, record, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/requests/:handymanRequestId/diagnosis — bounded existing record. */
export async function getHandymanDiagnosisHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseLifecycleHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const record = await handymanServiceRequestDiagnosisService
      .getHandymanRequestDiagnosis(handymanRequestId, req.auth.userId);
    sendSuccess(res, record, 200);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /handyman/requests/:handymanRequestId/referral — handoff fact only.
 * `referralType` / target discipline are derived by the PART 04 service
 * from the immutable diagnosis; they are never body inputs. No request
 * state transition occurs here.
 */
export async function postHandymanReferralHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseLifecycleHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const input = parseLifecycleReferralBody(req.body);
    const record = await handymanServiceRequestReferralService
      .recordHandymanReferral(
        { ...input, handymanRequestId },
        req.auth.userId,
      );
    sendSuccess(res, record, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/requests/:handymanRequestId/referral — bounded existing record. */
export async function getHandymanReferralHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseLifecycleHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const record = await handymanServiceRequestReferralService
      .getHandymanRequestReferral(handymanRequestId, req.auth.userId);
    sendSuccess(res, record, 200);
  } catch (error) {
    next(error);
  }
}
