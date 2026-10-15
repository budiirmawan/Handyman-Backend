import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  getHandymanExecutionScopeBastCustomerCareView,
  issueHandymanBast,
  prepareHandymanBast,
  voidHandymanBast,
  toHandymanBastAcceptanceReadContract,
  toHandymanBastArtifactReference,
} from '../handyman-bast';
import type {
  HandymanBastAcceptanceReadContract,
  HandymanBastCommandResult,
  HandymanBastEventRecord,
  HandymanBastRecord,
} from '../handyman-bast';
import {
  assertWorkerBastExpectedVersion,
  computeWorkerBastAvailableActions,
  loadWorkerBastLaneBast,
  loadWorkerBastLaneScope,
} from './handyman-bast-worker-authority';
import type { WorkerBastAction } from './handyman-bast-worker-authority';
import {
  parseWorkerBastIdParam,
  parseWorkerBastIssueBody,
  parseWorkerBastPrepareBody,
  parseWorkerBastScopeParam,
  parseWorkerBastVoidBody,
} from './handyman-bast-worker-api.validation';

/**
 * CR-HM-BAST-HTTP-01 — thin worker BAST command handlers. Each handler does
 * EXACTLY: authenticate-context → bounded whitelist validation → worker-lane
 * authority preamble (Building + CURRENT Crew Lead) → the existing frozen
 * CR-HM-11 PART 01 service → bounded serialization. ZERO lifecycle, QC,
 * acceptance or financial decision logic here. The actor is ALWAYS
 * `req.auth.userId` — no request field can name another actor.
 */

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function toWorkerBastPayload(bast: HandymanBastRecord) {
  const artifact = toHandymanBastArtifactReference(bast);
  return {
    id: bast.id,
    executionScopeId: bast.executionScopeId,
    qcRunId: bast.qcRunId,
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
    availableActions: computeWorkerBastAvailableActions(bast.status),
  };
}

function toWorkerAcceptancePayload(
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
  };
}

function toWorkerEventPayload(event: HandymanBastEventRecord) {
  const metadata = event.metadata ?? {};
  return {
    id: event.id,
    bastId: event.bastId,
    executionScopeId: event.executionScopeId,
    eventType: event.eventType,
    idempotencyKey: event.idempotencyKey,
    actorUserId: event.actorUserId,
    occurredAt: event.occurredAt,
    createdAt: event.createdAt,
    voidReason:
      typeof metadata.voidReason === 'string' ? metadata.voidReason : null,
  };
}

function toWorkerCommandPayload(result: HandymanBastCommandResult) {
  return {
    bast: toWorkerBastPayload(result.bast),
    acceptance: toWorkerAcceptancePayload(
      toHandymanBastAcceptanceReadContract(
        result.bast,
        [result.event],
        result.signOff ? [result.signOff] : [],
      ),
    ),
    event: toWorkerEventPayload(result.event),
    replayed: result.replayed,
  };
}

/**
 * GET /handyman/field/execution-scopes/:executionScopeId/bast
 * Worker-authorized read projection for page refresh/state recovery. Reuses
 * the existing BAST read service and the same active-then-latest document
 * selection as Customer Care, but only after `handyman.bast.manage`, exact
 * Building and CURRENT Crew Lead authorization. It deliberately omits
 * sign-off rows, signature digests/evidence, and ACCEPT/REJECT event details;
 * customer decision state is represented by the bounded acceptance facts.
 */
export async function getWorkerExecutionScopeBastHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseWorkerBastScopeParam(
      p(req.params.executionScopeId),
    );
    const actorUserId = actor(req);
    const laneScope = await loadWorkerBastLaneScope(
      executionScopeId,
      actorUserId,
    );
    const view = await getHandymanExecutionScopeBastCustomerCareView(
      executionScopeId,
      actorUserId,
    );
    const hasActiveBast = Boolean(view.bast && view.bast.status !== 'VOID');
    const lifecycleActions = hasActiveBast && view.bast
      ? computeWorkerBastAvailableActions(view.bast.status)
      : laneScope.status === 'AUTHORIZED'
        ? ['PREPARE' as const]
        : [];
    const workerEvents = view.events
      .filter((event) => ['PREPARE', 'ISSUE', 'VOID'].includes(event.eventType))
      .map(toWorkerEventPayload);

    sendSuccess(res, {
      executionScopeId: view.executionScopeId,
      scopeStatus: laneScope.status,
      bast: view.bast ? toWorkerBastPayload(view.bast) : null,
      acceptance: view.acceptance
        ? toWorkerAcceptancePayload(view.acceptance)
        : null,
      eligibility: {
        currentWorkerAssignment: 'CURRENT_CREW_LEAD',
        scopeAuthorized: laneScope.status === 'AUTHORIZED',
        bastQcRunId: view.bast?.qcRunId ?? null,
        prepareRequiresLatestGuardedQcPass: true,
        issueRequiresAnchoredQcPassToRemainLatest: true,
        customerAccepted: view.acceptance?.customerAccepted ?? false,
        warrantyStartEligible: view.acceptance?.warrantyStartEligible ?? false,
      },
      lifecycleActions,
      events: workerEvents,
    }, 200);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /handyman/field/execution-scopes/:executionScopeId/bast/prepare
 * Creates (or idempotently replays) the DRAFT BAST anchored to the latest
 * guarded Supervisor QC PASS. 201 on create, 200 on replay. Never issues,
 * signs or accepts.
 */
export async function postWorkerBastPrepareHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseWorkerBastScopeParam(
      p(req.params.executionScopeId),
    );
    const body = parseWorkerBastPrepareBody(req.body);
    const actorUserId = actor(req);
    await loadWorkerBastLaneScope(executionScopeId, actorUserId);
    const result = await prepareHandymanBast(actorUserId, {
      executionScopeId,
      idempotencyKey: body.idempotencyKey,
    });
    sendSuccess(res, toWorkerCommandPayload(result), result.replayed ? 200 : 201);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /handyman/field/bast/:bastId/issue
 * DRAFT → ISSUED for a permitted CURRENT Crew Lead. Preserves document
 * identity, version history and the event chain; ISSUED is not customer
 * acceptance.
 */
export async function postWorkerBastIssueHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bastId = parseWorkerBastIdParam(p(req.params.bastId));
    const body = parseWorkerBastIssueBody(req.body);
    const actorUserId = actor(req);
    const bast = await loadWorkerBastLaneBast(bastId, actorUserId);
    assertWorkerBastExpectedVersion(bast, 'ISSUE', body.expectedVersion);
    const result = await issueHandymanBast(actorUserId, {
      bastId,
      idempotencyKey: body.idempotencyKey,
    });
    sendSuccess(res, toWorkerCommandPayload(result), 200);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /handyman/field/bast/:bastId/void
 * DRAFT|ISSUED → VOID for a permitted CURRENT Crew Lead with a required
 * reason preserved in the append-only event chain. Historical documents,
 * prior acceptance evidence and the event history are never deleted.
 */
export async function postWorkerBastVoidHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bastId = parseWorkerBastIdParam(p(req.params.bastId));
    const body = parseWorkerBastVoidBody(req.body);
    const actorUserId = actor(req);
    const bast = await loadWorkerBastLaneBast(bastId, actorUserId);
    assertWorkerBastExpectedVersion(bast, 'VOID', body.expectedVersion);
    const result = await voidHandymanBast(actorUserId, {
      bastId,
      idempotencyKey: body.idempotencyKey,
      voidReason: body.reason,
    });
    sendSuccess(res, toWorkerCommandPayload(result), 200);
  } catch (error) {
    next(error);
  }
}

export type { WorkerBastAction };
