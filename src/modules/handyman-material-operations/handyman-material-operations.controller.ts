import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  cancelHandymanMaterialCommercialAddendum,
  cancelHandymanMaterialDemand,
  createCustomerSuppliedMaterialDemand,
  createHandymanMaterialCommercialAddendum,
  createNonChargeableMaterialDemand,
  createQuotationIncludedMaterialDemand,
  decideHandymanMaterialApprovalInApp,
  getHandymanMaterialApproval,
  getHandymanMaterialCommercialAddendum,
  getHandymanMaterialDemand,
  listHandymanMaterialCommercialAddenda,
  listHandymanMaterialDemands,
  recordHandymanMaterialApprovalAssistedDecision,
} from '../handyman-material-demands';
import { handymanMaterialDemandNotFoundError } from '../handyman-material-demands/handyman-material-demand.errors';
import {
  handymanMaterialInventoryIssueNotFoundError,
  handymanMaterialInventoryUomIncompatibleError,
} from '../handyman-material-inventory/handyman-material-inventory.errors';
import {
  cancelHandymanMaterialReservation,
  issueHandymanProviderStock,
  recordHandymanMaterialActualUsage,
  releaseHandymanMaterialReservation,
  reserveHandymanMaterialDemand,
  returnUnusedHandymanProviderStock,
} from '../handyman-material-inventory';
import {
  getDemandFulfillment,
  getIssueById,
  listApprovalsByJob,
  listIssuesByDemand,
  listReservationsByDemand,
  listReturnsByIssue,
  listUsagesByDemand,
} from './handyman-material-operations.reads';
import {
  assertEmptyTerminalReservationHttpBody,
  parseCancelMaterialHttpBody,
  parseCreateCustomerSuppliedDemandHttpBody,
  parseCreateMaterialAddendumHttpBody,
  parseCreateOperationalDemandHttpBody,
  parseCreateQuotationIncludedDemandHttpBody,
  parseDecideMaterialApprovalAssistedHttpBody,
  parseDecideMaterialApprovalInAppHttpBody,
  parseHandymanJobIdParam,
  parseIdempotencyKeyHeader,
  parseIssueMaterialHttpBody,
  parseMaterialAddendumIdParam,
  parseMaterialApprovalIdParam,
  parseMaterialDemandIdParam,
  parseMaterialIssueIdParam,
  parseMaterialReservationIdParam,
  parseRecordMaterialUsageHttpBody,
  parseReserveMaterialHttpBody,
  parseReturnMaterialHttpBody,
  parseSupersedeDemandHttpBody,
} from './handyman-material-operations.validation';

/**
 * CR-HM-BE-07 RUN 3 — Thin HTTP handlers over the Run-1/Run-2 service
 * authority (material demands, addenda, approvals, reservations, issues,
 * usages, returns, derived fulfillment). ALL authority lives in the
 * services: commercial basis, customer approval, demand caps, reservation
 * allocation, STOCK_OUT/STOCK_IN posting, usage/return accounting and
 * idempotent replay/convergence. These handlers ONLY parse governed
 * inputs, derive the actor from the authenticated session (NEVER from the
 * body), resolve route-addressed parents server-side, and delegate. No
 * lifecycle, pricing, inventory, approval, visit/session, Work Order or
 * financial authority is decided here, and no domain conflict is ever
 * converted into a transport error: failures flow to the shared Express
 * error pipeline via `next(error)` with their domain codes intact.
 *
 * Status codes: commands that ESTABLISH a new fact answer 201, or 200 with
 * `replayed: true` on idempotent replay/convergence. Transitions of an
 * existing fact (cancels, decisions, reservation release/cancel) always
 * answer 200.
 *
 * NULL-UOM boundary (§10): within the Run-2 service flow every movement
 * fact except the item-master-derived UOM is a same-transaction server
 * value, so a movement-proof trigger failure can only mean item-UOM /
 * demand-UOM divergence (the known Run-2 P2). The two stock-posting
 * handlers map exactly that trigger signature to the governed
 * HANDYMAN_MATERIAL_INVENTORY_UOM_INCOMPATIBLE domain error so HTTP never
 * surfaces a raw PostgreSQL exception. No Run-2 authority is changed and
 * no underlying condition is repaired here.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function idempotencyKey(req: Request): string {
  return parseIdempotencyKeyHeader(req.header('Idempotency-Key'));
}

function mapMovementProofFailure(error: unknown): unknown {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : '';
    if (
      code === 'P0001' &&
      (message.includes('must reference its matching STOCK_OUT') ||
        message.includes('must reference its matching STOCK_IN'))
    ) {
      return handymanMaterialInventoryUomIncompatibleError();
    }
  }
  return error;
}

// ---------------------------------------------------------------------------
// Material demands
// ---------------------------------------------------------------------------

export async function listMaterialDemandsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = parseHandymanJobIdParam(param(req.params.jobId));
    sendSuccess(res, await listHandymanMaterialDemands(jobId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function getMaterialDemandHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const demandId = parseMaterialDemandIdParam(param(req.params.demandId));
    sendSuccess(res, await getHandymanMaterialDemand(demandId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function getMaterialDemandFulfillmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const demandId = parseMaterialDemandIdParam(param(req.params.demandId));
    await getHandymanMaterialDemand(demandId, actor(req));
    const fulfillment = await getDemandFulfillment(demandId);
    if (!fulfillment) throw handymanMaterialInventoryIssueNotFoundError();
    sendSuccess(res, fulfillment);
  } catch (error) {
    next(error);
  }
}

export async function createQuotationIncludedDemandHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = parseHandymanJobIdParam(param(req.params.jobId));
    const body = parseCreateQuotationIncludedDemandHttpBody(req.body);
    const result = await createQuotationIncludedMaterialDemand(
      {
        handymanJobId: jobId,
        handymanQuotationLineId: body.handymanQuotationLineId,
        idempotencyKey: idempotencyKey(req),
      },
      actor(req),
    );
    sendSuccess(res, result, result.replayed ? 200 : 201);
  } catch (error) {
    next(error);
  }
}

export async function createOperationalDemandHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = parseHandymanJobIdParam(param(req.params.jobId));
    const body = parseCreateOperationalDemandHttpBody(req.body);
    const result = await createNonChargeableMaterialDemand(
      { handymanJobId: jobId, ...body, idempotencyKey: idempotencyKey(req) },
      actor(req),
    );
    sendSuccess(res, result, result.replayed ? 200 : 201);
  } catch (error) {
    next(error);
  }
}

export async function createCustomerSuppliedDemandHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = parseHandymanJobIdParam(param(req.params.jobId));
    const body = parseCreateCustomerSuppliedDemandHttpBody(req.body);
    const result = await createCustomerSuppliedMaterialDemand(
      { handymanJobId: jobId, ...body, idempotencyKey: idempotencyKey(req) },
      actor(req),
    );
    sendSuccess(res, result, result.replayed ? 200 : 201);
  } catch (error) {
    next(error);
  }
}

export async function cancelMaterialDemandHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const demandId = parseMaterialDemandIdParam(param(req.params.demandId));
    const body = parseCancelMaterialHttpBody(req.body);
    sendSuccess(
      res,
      await cancelHandymanMaterialDemand(
        {
          handymanMaterialDemandId: demandId,
          reason: body.reason,
          idempotencyKey: idempotencyKey(req),
        },
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function supersedeMaterialDemandHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const demandId = parseMaterialDemandIdParam(param(req.params.demandId));
    const body = parseSupersedeDemandHttpBody(req.body);
    // The predecessor comes from the route; its job is resolved server-side
    // from the authoritative demand (which also gates actor access).
    const predecessor = await getHandymanMaterialDemand(demandId, actor(req));
    const result = await createNonChargeableMaterialDemand(
      {
        handymanJobId: predecessor.handymanJobId,
        ...body,
        supersedesDemandId: demandId,
        idempotencyKey: idempotencyKey(req),
      },
      actor(req),
    );
    sendSuccess(res, result, result.replayed ? 200 : 201);
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Commercial addenda
// ---------------------------------------------------------------------------

export async function listMaterialAddendaHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = parseHandymanJobIdParam(param(req.params.jobId));
    sendSuccess(res, await listHandymanMaterialCommercialAddenda(jobId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function getMaterialAddendumHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const addendumId = parseMaterialAddendumIdParam(param(req.params.addendumId));
    sendSuccess(res, await getHandymanMaterialCommercialAddendum(addendumId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function createMaterialAddendumHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = parseHandymanJobIdParam(param(req.params.jobId));
    const body = parseCreateMaterialAddendumHttpBody(req.body);
    const result = await createHandymanMaterialCommercialAddendum(
      { handymanJobId: jobId, ...body, idempotencyKey: idempotencyKey(req) },
      actor(req),
    );
    sendSuccess(res, result, result.replayed ? 200 : 201);
  } catch (error) {
    next(error);
  }
}

export async function cancelMaterialAddendumHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const addendumId = parseMaterialAddendumIdParam(param(req.params.addendumId));
    const body = parseCancelMaterialHttpBody(req.body);
    sendSuccess(
      res,
      await cancelHandymanMaterialCommercialAddendum(
        {
          handymanMaterialCommercialAddendumId: addendumId,
          reason: body.reason,
          idempotencyKey: idempotencyKey(req),
        },
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Material approvals
// ---------------------------------------------------------------------------

export async function listMaterialApprovalsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const jobId = parseHandymanJobIdParam(param(req.params.jobId));
    // Staff/customer-only read gate stays Run-1 owned; the history itself is
    // a derived projection over the same authoritative facts.
    await listHandymanMaterialCommercialAddenda(jobId, actor(req));
    sendSuccess(res, await listApprovalsByJob(jobId));
  } catch (error) {
    next(error);
  }
}

export async function getMaterialApprovalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const approvalId = parseMaterialApprovalIdParam(param(req.params.approvalId));
    sendSuccess(res, await getHandymanMaterialApproval(approvalId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function decideMaterialApprovalInAppHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const approvalId = parseMaterialApprovalIdParam(param(req.params.approvalId));
    const body = parseDecideMaterialApprovalInAppHttpBody(req.body);
    sendSuccess(
      res,
      await decideHandymanMaterialApprovalInApp(
        {
          handymanMaterialApprovalId: approvalId,
          decision: body.decision,
          ...(body.notes === undefined ? {} : { notes: body.notes }),
          idempotencyKey: idempotencyKey(req),
        },
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function decideMaterialApprovalAssistedHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const approvalId = parseMaterialApprovalIdParam(param(req.params.approvalId));
    const body = parseDecideMaterialApprovalAssistedHttpBody(req.body);
    sendSuccess(
      res,
      await recordHandymanMaterialApprovalAssistedDecision(
        {
          handymanMaterialApprovalId: approvalId,
          decision: body.decision,
          approvedFor: body.approvedFor,
          notes: body.notes,
          idempotencyKey: idempotencyKey(req),
        },
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

export async function reserveMaterialHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const demandId = parseMaterialDemandIdParam(param(req.params.demandId));
    const body = parseReserveMaterialHttpBody(req.body);
    const result = await reserveHandymanMaterialDemand(
      {
        handymanMaterialDemandId: demandId,
        ...body,
        idempotencyKey: idempotencyKey(req),
      },
      actor(req),
    );
    sendSuccess(res, result, result.replayed ? 200 : 201);
  } catch (error) {
    next(error);
  }
}

export async function listMaterialReservationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const demandId = parseMaterialDemandIdParam(param(req.params.demandId));
    await getHandymanMaterialDemand(demandId, actor(req));
    sendSuccess(res, await listReservationsByDemand(demandId));
  } catch (error) {
    next(error);
  }
}

export async function releaseMaterialReservationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const reservationId = parseMaterialReservationIdParam(param(req.params.reservationId));
    assertEmptyTerminalReservationHttpBody(req.body);
    sendSuccess(
      res,
      await releaseHandymanMaterialReservation(
        {
          inventoryMaterialReservationId: reservationId,
          idempotencyKey: idempotencyKey(req),
        },
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function cancelMaterialReservationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const reservationId = parseMaterialReservationIdParam(param(req.params.reservationId));
    assertEmptyTerminalReservationHttpBody(req.body);
    sendSuccess(
      res,
      await cancelHandymanMaterialReservation(
        {
          inventoryMaterialReservationId: reservationId,
          idempotencyKey: idempotencyKey(req),
        },
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Controlled issues
// ---------------------------------------------------------------------------

export async function issueMaterialHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const demandId = parseMaterialDemandIdParam(param(req.params.demandId));
    const body = parseIssueMaterialHttpBody(req.body);
    const result = await issueHandymanProviderStock(
      {
        handymanMaterialDemandId: demandId,
        ...body,
        idempotencyKey: idempotencyKey(req),
      },
      actor(req),
    );
    sendSuccess(res, result, result.replayed ? 200 : 201);
  } catch (error) {
    next(mapMovementProofFailure(error));
  }
}

export async function listMaterialIssuesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const demandId = parseMaterialDemandIdParam(param(req.params.demandId));
    await getHandymanMaterialDemand(demandId, actor(req));
    sendSuccess(res, await listIssuesByDemand(demandId));
  } catch (error) {
    next(error);
  }
}

export async function getMaterialIssueHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const issueId = parseMaterialIssueIdParam(param(req.params.issueId));
    const issue = await getIssueById(issueId);
    if (!issue) throw handymanMaterialInventoryIssueNotFoundError();
    await getHandymanMaterialDemand(issue.handymanMaterialDemandId, actor(req));
    sendSuccess(res, issue);
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Actual usages
// ---------------------------------------------------------------------------

export async function recordMaterialUsageHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const demandId = parseMaterialDemandIdParam(param(req.params.demandId));
    const body = parseRecordMaterialUsageHttpBody(req.body);
    const result = await recordHandymanMaterialActualUsage(
      {
        handymanMaterialDemandId: demandId,
        ...body,
        idempotencyKey: idempotencyKey(req),
      },
      actor(req),
    );
    sendSuccess(res, result, result.replayed ? 200 : 201);
  } catch (error) {
    next(error);
  }
}

export async function listMaterialUsagesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const demandId = parseMaterialDemandIdParam(param(req.params.demandId));
    await getHandymanMaterialDemand(demandId, actor(req));
    sendSuccess(res, await listUsagesByDemand(demandId));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

export async function returnMaterialHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const issueId = parseMaterialIssueIdParam(param(req.params.issueId));
    const body = parseReturnMaterialHttpBody(req.body);
    const result = await returnUnusedHandymanProviderStock(
      {
        handymanMaterialControlledIssueId: issueId,
        ...body,
        idempotencyKey: idempotencyKey(req),
      },
      actor(req),
    );
    sendSuccess(res, result, result.replayed ? 200 : 201);
  } catch (error) {
    next(mapMovementProofFailure(error));
  }
}

export async function listMaterialReturnsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const issueId = parseMaterialIssueIdParam(param(req.params.issueId));
    const issue = await getIssueById(issueId);
    if (!issue) throw handymanMaterialInventoryIssueNotFoundError();
    await getHandymanMaterialDemand(issue.handymanMaterialDemandId, actor(req));
    sendSuccess(res, await listReturnsByIssue(issueId));
  } catch (error) {
    next(error);
  }
}
