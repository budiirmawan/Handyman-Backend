import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  readHandymanLedgerClientBasisAt,
  readHandymanLedgerTransactionAt,
  type HandymanLedgerClientBasisEntry,
  type HandymanLedgerClientBasisRead,
  type HandymanLedgerReadAllocation,
  type HandymanLedgerReadChargeLine,
  type HandymanLedgerReadCorrection,
  type HandymanLedgerReadPayment,
  type HandymanLedgerReadTotals,
  type HandymanLedgerTransactionRead,
} from '../handyman-customer-ledger-read';
import {
  confirmHandymanCustomerPayment,
  listHandymanCustomerPayments,
  recordHandymanCustomerPayment,
  rejectHandymanCustomerPayment,
  type HandymanCustomerPaymentCommandResult,
  type HandymanCustomerPaymentEventRecord,
  type HandymanCustomerPaymentRecord,
} from '../handyman-customer-payments';
import {
  parseConfirmCustomerPaymentBody,
  parseCustomerLedgerClientBasisQuery,
  parseCustomerLedgerScopeParam,
  parseCustomerPaymentIdParam,
  parseRecordCustomerPaymentBody,
  parseRejectCustomerPaymentBody,
} from './handyman-customer-ledger-api.validation';

/**
 * CR-HM-17 GAP PART 05 — Thin HTTP transport over CR-HM-13 Customer
 * Transaction & Payment Ledger (`readHandymanLedgerTransactionAt`,
 * `readHandymanLedgerClientBasisAt`, `listHandymanCustomerPayments`,
 * `recordHandymanCustomerPayment`, `confirmHandymanCustomerPayment`,
 * `rejectHandymanCustomerPayment`).
 *
 * Exposes customer transaction and payment facts only (`LABOR`/`MATERIAL`
 * charge lines, payments, allocations, corrections, and authoritative
 * totals). Zero local financial calculation; zero downstream provider/BM
 * payable or reconciliation surface.
 */

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function toChargeLinePayload(line: HandymanLedgerReadChargeLine) {
  return {
    chargeLineId: line.chargeLineId,
    quotationLineId: line.quotationLineId,
    lineKind: line.lineKind,
    compositionKind: line.compositionKind,
    basisFactKind: line.basisFactKind,
    currency: line.currency,
    amount: line.amount,
    adjusted: line.adjusted,
    netAmount: line.netAmount,
    allocated: line.allocated,
    reversedAllocations: line.reversedAllocations,
    applied: line.applied,
    outstanding: line.outstanding,
  };
}

function toLedgerPaymentPayload(payment: HandymanLedgerReadPayment) {
  return {
    paymentId: payment.paymentId,
    status: payment.status,
    channel: payment.channel,
    currency: payment.currency,
    amount: payment.amount,
    receivedAt: payment.receivedAt,
    allocated: payment.allocated,
    reversedAllocations: payment.reversedAllocations,
    applied: payment.applied,
    refunded: payment.refunded,
    reversedPayment: payment.reversedPayment,
    netReceived: payment.netReceived,
    authoritativeForEntitlement: payment.authoritativeForEntitlement,
  };
}

function toAllocationPayload(allocation: HandymanLedgerReadAllocation) {
  return {
    allocationId: allocation.allocationId,
    paymentId: allocation.paymentId,
    chargeLineId: allocation.chargeLineId,
    lineKind: allocation.lineKind,
    currency: allocation.currency,
    amount: allocation.amount,
    occurredAt: allocation.occurredAt,
    reversed: allocation.reversed,
  };
}

function toCorrectionPayload(correction: HandymanLedgerReadCorrection) {
  return {
    correctionId: correction.correctionId,
    correctionKind: correction.correctionKind,
    sourceKind: correction.sourceKind,
    sourcePaymentId: correction.sourcePaymentId,
    sourceAllocationId: correction.sourceAllocationId,
    sourceChargeLineId: correction.sourceChargeLineId,
    currency: correction.currency,
    amount: correction.amount,
    reason: correction.reason,
    correctedByUserId: correction.correctedByUserId,
    occurredAt: correction.occurredAt,
  };
}

function toTotalsPayload(totals: HandymanLedgerReadTotals) {
  return {
    chargedGross: totals.chargedGross,
    laborGross: totals.laborGross,
    materialGross: totals.materialGross,
    laborAdjusted: totals.laborAdjusted,
    materialAdjusted: totals.materialAdjusted,
    adjustedTransactionScope: totals.adjustedTransactionScope,
    adjusted: totals.adjusted,
    chargedNet: totals.chargedNet,
    laborNet: totals.laborNet,
    materialNet: totals.materialNet,
    allocated: totals.allocated,
    reversedAllocations: totals.reversedAllocations,
    applied: totals.applied,
    receivedGross: totals.receivedGross,
    receivedReversed: totals.receivedReversed,
    receivedNet: totals.receivedNet,
    refunded: totals.refunded,
    netReceived: totals.netReceived,
    outstanding: totals.outstanding,
    corrections: {
      refunds: totals.corrections.refunds,
      reversals: totals.corrections.reversals,
      adjustments: totals.corrections.adjustments,
    },
  };
}

function toTransactionReadPayload(read: HandymanLedgerTransactionRead) {
  return {
    contractVersion: read.contractVersion,
    readOnly: read.readOnly,
    transaction: {
      transactionId: read.transaction.transactionId,
      clientId: read.transaction.clientId,
      executionScopeId: read.transaction.executionScopeId,
      quotationVersionId: read.transaction.quotationVersionId,
      currency: read.transaction.currency,
      createdAt: read.transaction.createdAt,
    },
    chargeLines: read.chargeLines.map(toChargeLinePayload),
    payments: read.payments.map(toLedgerPaymentPayload),
    allocations: read.allocations.map(toAllocationPayload),
    corrections: read.corrections.map(toCorrectionPayload),
    totals: toTotalsPayload(read.totals),
    authority: {
      authoritativeForEntitlement:
        read.authority.authoritativeForEntitlement,
      deniedBy: [...read.authority.deniedBy],
    },
  };
}

function toClientBasisEntryPayload(entry: HandymanLedgerClientBasisEntry) {
  return {
    transactionId: entry.transactionId,
    executionScopeId: entry.executionScopeId,
    currency: entry.currency,
    openedAt: entry.openedAt,
    chargedNet: entry.chargedNet,
    laborNet: entry.laborNet,
    materialNet: entry.materialNet,
    adjusted: entry.adjusted,
    applied: entry.applied,
    receivedNet: entry.receivedNet,
    refunded: entry.refunded,
    reversedAllocations: entry.reversedAllocations,
    receivedReversed: entry.receivedReversed,
    netReceived: entry.netReceived,
    outstanding: entry.outstanding,
    corrections: {
      refunds: entry.corrections.refunds,
      reversals: entry.corrections.reversals,
      adjustments: entry.corrections.adjustments,
    },
    authority: {
      authoritativeForEntitlement:
        entry.authority.authoritativeForEntitlement,
      deniedBy: [...entry.authority.deniedBy],
    },
  };
}

function toClientBasisReadPayload(read: HandymanLedgerClientBasisRead) {
  return {
    contractVersion: read.contractVersion,
    readOnly: read.readOnly,
    clientId: read.clientId,
    from: read.from,
    to: read.to,
    limit: read.limit,
    transactions: read.transactions.map(toClientBasisEntryPayload),
    totals: {
      transactionCount: read.totals.transactionCount,
      chargedNet: read.totals.chargedNet,
      laborNet: read.totals.laborNet,
      materialNet: read.totals.materialNet,
      adjusted: read.totals.adjusted,
      applied: read.totals.applied,
      receivedNet: read.totals.receivedNet,
      refunded: read.totals.refunded,
      reversedAllocations: read.totals.reversedAllocations,
      receivedReversed: read.totals.receivedReversed,
      netReceived: read.totals.netReceived,
      outstanding: read.totals.outstanding,
      corrections: {
        refunds: read.totals.corrections.refunds,
        reversals: read.totals.corrections.reversals,
        adjustments: read.totals.corrections.adjustments,
      },
    },
    authority: {
      authoritativeForEntitlement:
        read.authority.authoritativeForEntitlement,
      deniedBy: [...read.authority.deniedBy],
      nonAuthoritativeTransactionIds: [
        ...read.authority.nonAuthoritativeTransactionIds,
      ],
    },
  };
}

function toPaymentRecordPayload(payment: HandymanCustomerPaymentRecord) {
  return {
    id: payment.id,
    clientId: payment.clientId,
    transactionId: payment.transactionId,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    channel: payment.channel,
    providerName: payment.providerName,
    providerReference: payment.providerReference,
    externalReference: payment.externalReference,
    receivedAt: payment.receivedAt,
    recordedByUserId: payment.recordedByUserId,
    decidedAt: payment.decidedAt,
    decidedByUserId: payment.decidedByUserId,
    rejectionReason: payment.rejectionReason,
    createdAt: payment.createdAt,
  };
}

function toPaymentEventPayload(event: HandymanCustomerPaymentEventRecord) {
  return {
    id: event.id,
    clientId: event.clientId,
    paymentId: event.paymentId,
    transactionId: event.transactionId,
    eventType: event.eventType,
    idempotencyKey: event.idempotencyKey,
    actorUserId: event.actorUserId,
    occurredAt: event.occurredAt,
    createdAt: event.createdAt,
  };
}

function toPaymentCommandPayload(
  result: HandymanCustomerPaymentCommandResult,
) {
  return {
    payment: toPaymentRecordPayload(result.payment),
    event: toPaymentEventPayload(result.event),
    replayed: result.replayed,
  };
}

export async function getExecutionScopeCustomerLedgerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseCustomerLedgerScopeParam(
      p(req.params.executionScopeId),
    );
    const read = await readHandymanLedgerTransactionAt(
      executionScopeId,
      actor(req),
    );
    sendSuccess(res, toTransactionReadPayload(read), 200);
  } catch (error) {
    next(error);
  }
}

export async function getClientCustomerLedgerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { clientId, options } = parseCustomerLedgerClientBasisQuery(
      (req.query ?? {}) as Record<string, unknown>,
    );
    const read = await readHandymanLedgerClientBasisAt(
      clientId,
      actor(req),
      options,
    );
    sendSuccess(res, toClientBasisReadPayload(read), 200);
  } catch (error) {
    next(error);
  }
}

export async function getExecutionScopeCustomerPaymentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseCustomerLedgerScopeParam(
      p(req.params.executionScopeId),
    );
    const payments = await listHandymanCustomerPayments(
      executionScopeId,
      actor(req),
    );
    sendSuccess(
      res,
      {
        executionScopeId,
        payments: payments.map(toPaymentRecordPayload),
      },
      200,
    );
  } catch (error) {
    next(error);
  }
}

export async function postRecordCustomerPaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseCustomerLedgerScopeParam(
      p(req.params.executionScopeId),
    );
    const body = parseRecordCustomerPaymentBody(req.body);
    const result = await recordHandymanCustomerPayment(
      {
        executionScopeId,
        amount: body.amount,
        channel: body.channel,
        providerName: body.providerName,
        providerReference: body.providerReference,
        externalReference: body.externalReference,
        idempotencyKey: body.idempotencyKey,
      },
      actor(req),
    );
    sendSuccess(res, toPaymentCommandPayload(result), 200);
  } catch (error) {
    next(error);
  }
}

export async function postConfirmCustomerPaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseCustomerLedgerScopeParam(
      p(req.params.executionScopeId),
    );
    const paymentId = parseCustomerPaymentIdParam(p(req.params.paymentId));
    const body = parseConfirmCustomerPaymentBody(req.body);
    const result = await confirmHandymanCustomerPayment(
      {
        executionScopeId,
        paymentId,
        idempotencyKey: body.idempotencyKey,
      },
      actor(req),
    );
    sendSuccess(res, toPaymentCommandPayload(result), 200);
  } catch (error) {
    next(error);
  }
}

export async function postRejectCustomerPaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseCustomerLedgerScopeParam(
      p(req.params.executionScopeId),
    );
    const paymentId = parseCustomerPaymentIdParam(p(req.params.paymentId));
    const body = parseRejectCustomerPaymentBody(req.body);
    const result = await rejectHandymanCustomerPayment(
      {
        executionScopeId,
        paymentId,
        reason: body.reason,
        idempotencyKey: body.idempotencyKey,
      },
      actor(req),
    );
    sendSuccess(res, toPaymentCommandPayload(result), 200);
  } catch (error) {
    next(error);
  }
}
