import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  approveHandymanMaterialExecutionLine,
  estimateHandymanMaterialExecutionLine,
  getHandymanMaterialFinalChargeReadyProjection,
  getHandymanMaterialLinesCustomerCareView,
  getHandymanMaterialProgressProjection,
  issueHandymanMaterialExecutionLine,
  purchaseHandymanMaterialExecutionLine,
  returnHandymanMaterialExecutionLine,
  settleHandymanMaterialExecutionLine,
  useHandymanMaterialExecutionLine,
} from '../handyman-material-execution';
import type {
  HandymanCustomerCareMaterialLineItem,
  HandymanCustomerCareMaterialLinesProjection,
  HandymanMaterialExecutionCommandResult,
  HandymanMaterialExecutionEventRecord,
  HandymanMaterialExecutionLineRecord,
  HandymanMaterialExecutionProgressLine,
  HandymanMaterialFinalChargeReadyProjection,
  HandymanMaterialProgressProjection,
} from '../handyman-material-execution';
import {
  parseEstimateBody,
  parseKeyBody,
  parseMaterialLineIdParam,
  parseMaterialScopeParam,
  parseQuantityBody,
} from './handyman-material-execution-api.validation';

/**
 * CR-HM-09 PART 06 — material-execution HTTP handlers (THIN shell).
 * Each handler does EXACTLY: auth/context → bounded whitelist
 * validation → matching PART 03–05 service → bounded serialization.
 * ZERO lifecycle/transition/quantity/mode logic here — the service
 * layer remains the SOLE authority. ZERO pricing/billing/payment/FM
 * handler and ZERO such field can ever be serialized.
 */

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

/** Bounded line projection (NO client id, NO financial field). */
function toLinePayload(line: HandymanMaterialExecutionLineRecord) {
  return {
    id: line.id,
    executionScopeId: line.executionScopeId,
    quotationVersionId: line.quotationVersionId,
    quotationLineId: line.quotationLineId,
    sourceItemId: line.sourceItemId,
    status: line.status,
    acquisitionMode: line.acquisitionMode,
    estimatedQty: line.estimatedQty,
    approvedQty: line.approvedQty,
    issuedQty: line.issuedQty,
    purchasedQty: line.purchasedQty,
    usedQty: line.usedQty,
    returnedQty: line.returnedQty,
    supplierReference: line.supplierReference,
    createdAt: line.createdAt,
    updatedAt: line.updatedAt,
  };
}

function toEventPayload(event: HandymanMaterialExecutionEventRecord) {
  return {
    id: event.id,
    lineId: event.lineId,
    executionScopeId: event.executionScopeId,
    eventType: event.eventType,
    idempotencyKey: event.idempotencyKey,
    occurredAt: event.occurredAt,
  };
}

function toCommandPayload(result: HandymanMaterialExecutionCommandResult) {
  return {
    line: toLinePayload(result.line),
    event: toEventPayload(result.event),
    replayed: result.replayed,
  };
}

function toProgressLinePayload(line: HandymanMaterialExecutionProgressLine) {
  return {
    id: line.id,
    executionScopeId: line.executionScopeId,
    material: {
      description: line.material.description,
      sourceItemId: line.material.sourceItemId,
    },
    uom: {
      id: line.uom.id,
      code: line.uom.code,
      name: line.uom.name,
      symbol: line.uom.symbol,
      category: line.uom.category,
    },
    status: line.status,
    acquisitionMode: line.acquisitionMode,
    estimatedQty: line.estimatedQty,
    approvedQty: line.approvedQty,
    issuedQty: line.issuedQty,
    purchasedQty: line.purchasedQty,
    usedQty: line.usedQty,
    returnedQty: line.returnedQty,
    finalUsedQty: line.finalUsedQty,
  };
}

function toProgressPayload(projection: HandymanMaterialProgressProjection) {
  return {
    executionScopeId: projection.executionScopeId,
    lines: projection.lines.map(toProgressLinePayload),
  };
}

function toProjectionPayload(
  projection: HandymanMaterialFinalChargeReadyProjection,
) {
  return {
    executionScopeId: projection.executionScopeId,
    lines: projection.lines.map(toProgressLinePayload),
    totalsByUom: projection.totalsByUom.map((total) => ({
      uom: {
        id: total.uom.id,
        code: total.uom.code,
        name: total.uom.name,
        symbol: total.uom.symbol,
        category: total.uom.category,
      },
      totalFinalUsedQty: total.totalFinalUsedQty,
    })),
  };
}

function toCustomerCareLineItemPayload(
  item: HandymanCustomerCareMaterialLineItem,
) {
  return {
    ...toLinePayload(item.line),
    finalUsedQty: item.finalUsedQty,
    events: item.events.map(toEventPayload),
  };
}

function toCustomerCareLinesPayload(
  projection: HandymanCustomerCareMaterialLinesProjection,
) {
  return {
    executionScopeId: projection.executionScopeId,
    lines: projection.lines.map(toCustomerCareLineItemPayload),
    totalFinalUsedQty: projection.totalFinalUsedQty,
  };
}

/**
 * Shared thin keyed-mutation pipeline: parse URL ids + bounded body
 * → service → serialize. Client/actor never enter via the body.
 */
async function runKeyedMutation(
  req: Request,
  res: Response,
  next: NextFunction,
  command: (
    input: {
      executionScopeId: string;
      lineId: string;
      idempotencyKey: string;
    },
    actorUserId: string,
  ) => Promise<HandymanMaterialExecutionCommandResult>,
): Promise<void> {
  try {
    const executionScopeId = parseMaterialScopeParam(
      p(req.params.executionScopeId));
    const lineId = parseMaterialLineIdParam(p(req.params.lineId));
    const { idempotencyKey } = parseKeyBody(req.body);
    sendSuccess(
      res,
      toCommandPayload(await command(
        { executionScopeId, lineId, idempotencyKey },
        actor(req),
      )),
      200,
    );
  } catch (error) {
    next(error);
  }
}

/** Shared thin quantity-mutation pipeline (ISSUE/PURCHASE/USE/RETURN). */
async function runQuantityMutation(
  req: Request,
  res: Response,
  next: NextFunction,
  mode: 'ISSUE' | 'PURCHASE' | 'USE' | 'RETURN',
): Promise<void> {
  try {
    const executionScopeId = parseMaterialScopeParam(
      p(req.params.executionScopeId));
    const lineId = parseMaterialLineIdParam(p(req.params.lineId));
    const body = parseQuantityBody(req.body);
    const actorUserId = actor(req);
    let result: HandymanMaterialExecutionCommandResult;
    if (mode === 'ISSUE' || mode === 'PURCHASE') {
      const command = mode === 'ISSUE'
        ? issueHandymanMaterialExecutionLine
        : purchaseHandymanMaterialExecutionLine;
      result = await command({
        executionScopeId,
        lineId,
        quantity: body.quantity,
        supplierReference: body.supplierReference,
        idempotencyKey: body.idempotencyKey,
      }, actorUserId);
    } else {
      const command = mode === 'USE'
        ? useHandymanMaterialExecutionLine
        : returnHandymanMaterialExecutionLine;
      result = await command({
        executionScopeId,
        lineId,
        quantity: body.quantity,
        idempotencyKey: body.idempotencyKey,
      }, actorUserId);
    }
    sendSuccess(res, toCommandPayload(result), 200);
  } catch (error) {
    next(error);
  }
}

/** ESTIMATE: bind one MATERIAL quotation line as an execution line. */
export function postEstimateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return (async () => {
    try {
      const executionScopeId = parseMaterialScopeParam(
        p(req.params.executionScopeId));
      const body = parseEstimateBody(req.body);
      sendSuccess(
        res,
        toCommandPayload(await estimateHandymanMaterialExecutionLine({
          executionScopeId,
          quotationVersionId: body.quotationVersionId,
          quotationLineId: body.quotationLineId,
          estimatedQty: body.estimatedQty,
          idempotencyKey: body.idempotencyKey,
        }, actor(req))),
        200,
      );
    } catch (error) {
      next(error);
    }
  })();
}

/** APPROVE (ESTIMATED -> APPROVED). */
export function postApproveHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runKeyedMutation(req, res, next,
    approveHandymanMaterialExecutionLine);
}

/** ISSUE: consume from client-held execution storage. */
export function postIssueHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runQuantityMutation(req, res, next, 'ISSUE');
}

/** PURCHASE: acquire via lead-local supplier (bounded reference). */
export function postPurchaseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runQuantityMutation(req, res, next, 'PURCHASE');
}

/** USE: consume held quantity (delta). */
export function postUseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runQuantityMutation(req, res, next, 'USE');
}

/** RETURN: hand back held-not-used quantity (delta). */
export function postReturnHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runQuantityMutation(req, res, next, 'RETURN');
}

/** SETTLE: close one line (FINAL_CHARGE_READY). */
export function postSettleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runKeyedMutation(req, res, next,
    settleHandymanMaterialExecutionLine);
}

/** GET FINAL_CHARGE_READY projection over one execution scope. */
export async function getProjectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseMaterialScopeParam(
      p(req.params.executionScopeId));
    sendSuccess(
      res,
      toProjectionPayload(
        await getHandymanMaterialFinalChargeReadyProjection(
          executionScopeId,
          actor(req),
        ),
      ),
      200,
    );
  } catch (error) {
    next(error);
  }
}

/** GET the current Lead's field-safe material progress for one scope. */
export async function getProgressHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseMaterialScopeParam(
      p(req.params.executionScopeId));
    sendSuccess(
      res,
      toProgressPayload(
        await getHandymanMaterialProgressProjection(
          executionScopeId,
          actor(req),
        ),
      ),
      200,
    );
  } catch (error) {
    next(error);
  }
}

/**
 * CR-HM-17 GAP PART 03 — GET Customer Care material execution lines
 * projection across all governed statuses on an execution scope.
 */
export async function getMaterialLinesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseMaterialScopeParam(
      p(req.params.executionScopeId));
    sendSuccess(
      res,
      toCustomerCareLinesPayload(
        await getHandymanMaterialLinesCustomerCareView(
          executionScopeId,
          actor(req),
        ),
      ),
      200,
    );
  } catch (error) {
    next(error);
  }
}
