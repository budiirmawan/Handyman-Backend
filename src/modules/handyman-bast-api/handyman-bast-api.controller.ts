import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  acceptHandymanBast,
  getHandymanBastCustomerCareDetail,
  getHandymanExecutionScopeBastCustomerCareView,
  rejectHandymanBast,
  toHandymanBastAcceptanceReadContract,
} from '../handyman-bast';
import type {
  HandymanBastAcceptanceReadContract,
  HandymanBastApprovedSignOffBinding,
  HandymanBastCommandResult,
  HandymanBastEventRecord,
  HandymanBastRecord,
  HandymanBastSignOffRecord,
} from '../handyman-bast';
import { toHandymanBastArtifactReference } from '../handyman-bast';
import { computeBastAvailableActions } from '../handyman-bast/handyman-bast.available-actions';
import {
  parseBastDecisionSignOffBody,
  parseBastIdParam,
  parseBastScopeParam,
  parseBastSignOffBody,
} from './handyman-bast-api.validation';

/**
 * CR-HM-17 GAP PART 04 — Thin HTTP handlers over CR-HM-11 BAST
 * services (`getHandymanExecutionScopeBastCustomerCareView`,
 * `getHandymanBastCustomerCareDetail`, `acceptHandymanBast`,
 * `rejectHandymanBast`).
 *
 * Worker/provider BAST preparation, issuance, and voiding commands
 * are NEVER imported or exposed here.
 */

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function toBastPayload(bast: HandymanBastRecord) {
  const artifact = toHandymanBastArtifactReference(bast);
  return {
    id: bast.id,
    executionScopeId: bast.executionScopeId,
    status: bast.status,
    issuedAt: bast.issuedAt,
    acceptedAt: bast.acceptedAt,
    rejectedAt: bast.rejectedAt,
    voidedAt: bast.voidedAt,
    createdAt: bast.createdAt,
    updatedAt: bast.updatedAt,
    artifact: {
      ref: artifact.ref,
      version: artifact.version,
    },
    availableActions: computeBastAvailableActions(bast.status),
  };
}

function toBastAcceptancePayload(
  acceptance: HandymanBastAcceptanceReadContract,
) {
  return {
    bastId: acceptance.bastId,
    executionScopeId: acceptance.executionScopeId,
    status: acceptance.status,
    customerAccepted: acceptance.customerAccepted,
    warrantyStartEligible: acceptance.warrantyStartEligible,
    issuedAt: acceptance.issuedAt,
    acceptedAt: acceptance.acceptedAt,
    rejectedAt: acceptance.rejectedAt,
    voidedAt: acceptance.voidedAt,
    artifactRef: acceptance.artifactRef,
    approvedSignOff: toApprovedSignOffPayload(acceptance.approvedSignOff),
    signOffComplete: acceptance.signOffComplete,
  };
}

function toApprovedSignOffPayload(
  binding: HandymanBastApprovedSignOffBinding | null,
) {
  if (!binding) return null;
  return {
    signOffId: binding.signOffId,
    eventId: binding.eventId,
    signatureDigest: binding.signatureDigest,
    evidenceRecordId: binding.evidenceRecordId,
    actorUserId: binding.actorUserId,
    occurredAt: binding.occurredAt,
    createdAt: binding.createdAt,
  };
}

function toBastEventPayload(event: HandymanBastEventRecord) {
  return {
    id: event.id,
    bastId: event.bastId,
    executionScopeId: event.executionScopeId,
    eventType: event.eventType,
    idempotencyKey: event.idempotencyKey,
    actorUserId: event.actorUserId,
    occurredAt: event.occurredAt,
    createdAt: event.createdAt,
  };
}

function toBastSignOffPayload(signOff: HandymanBastSignOffRecord) {
  return {
    id: signOff.id,
    bastId: signOff.bastId,
    eventId: signOff.eventId,
    executionScopeId: signOff.executionScopeId,
    decision: signOff.decision,
    signatureDigest: signOff.signatureDigest,
    evidenceRecordId: signOff.evidenceRecordId,
    rejectReason: signOff.rejectReason,
    createdAt: signOff.createdAt,
  };
}

function toCommandPayload(result: HandymanBastCommandResult) {
  const events = [result.event];
  const signOffs = result.signOff ? [result.signOff] : [];
  return {
    bast: toBastPayload(result.bast),
    acceptance: toBastAcceptancePayload(
      toHandymanBastAcceptanceReadContract(result.bast, events, signOffs),
    ),
    event: toBastEventPayload(result.event),
    signOff: result.signOff ? toBastSignOffPayload(result.signOff) : null,
    replayed: result.replayed,
  };
}

export async function getExecutionScopeBastHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseBastScopeParam(
      p(req.params.executionScopeId),
    );
    const view = await getHandymanExecutionScopeBastCustomerCareView(
      executionScopeId,
      actor(req),
    );
    sendSuccess(
      res,
      {
        executionScopeId: view.executionScopeId,
        bast: view.bast ? toBastPayload(view.bast) : null,
        acceptance: view.acceptance
          ? toBastAcceptancePayload(view.acceptance)
          : null,
        events: view.events.map(toBastEventPayload),
        signOffs: view.signOffs.map(toBastSignOffPayload),
      },
      200,
    );
  } catch (error) {
    next(error);
  }
}

export async function getBastByIdHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bastId = parseBastIdParam(p(req.params.bastId));
    const view = await getHandymanBastCustomerCareDetail(
      bastId,
      actor(req),
    );
    sendSuccess(
      res,
      {
        bast: toBastPayload(view.bast),
        acceptance: toBastAcceptancePayload(view.acceptance),
        events: view.events.map(toBastEventPayload),
        signOffs: view.signOffs.map(toBastSignOffPayload),
      },
      200,
    );
  } catch (error) {
    next(error);
  }
}

export async function postBastAcceptHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bastId = parseBastIdParam(p(req.params.bastId));
    const body = parseBastSignOffBody(req.body);
    const result = await acceptHandymanBast(actor(req), {
      bastId,
      idempotencyKey: body.idempotencyKey,
      signatureDigest: body.signatureDigest,
      evidenceRecordId: body.evidenceRecordId,
    });
    sendSuccess(res, toCommandPayload(result), 200);
  } catch (error) {
    next(error);
  }
}

export async function postBastRejectHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bastId = parseBastIdParam(p(req.params.bastId));
    const body = parseBastSignOffBody(req.body);
    const result = await rejectHandymanBast(actor(req), {
      bastId,
      idempotencyKey: body.idempotencyKey,
      signatureDigest: body.signatureDigest,
      evidenceRecordId: body.evidenceRecordId,
      rejectReason: body.rejectReason,
    });
    sendSuccess(res, toCommandPayload(result), 200);
  } catch (error) {
    next(error);
  }
}

export async function postBastSignOffHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bastId = parseBastIdParam(p(req.params.bastId));
    const body = parseBastDecisionSignOffBody(req.body);
    const result = body.decision === 'ACCEPT'
      ? await acceptHandymanBast(actor(req), {
          bastId,
          idempotencyKey: body.idempotencyKey,
          signatureDigest: body.signatureDigest,
          evidenceRecordId: body.evidenceRecordId,
        })
      : await rejectHandymanBast(actor(req), {
          bastId,
          idempotencyKey: body.idempotencyKey,
          signatureDigest: body.signatureDigest,
          evidenceRecordId: body.evidenceRecordId,
          rejectReason: body.rejectReason,
        });
    sendSuccess(res, toCommandPayload(result), 200);
  } catch (error) {
    next(error);
  }
}
