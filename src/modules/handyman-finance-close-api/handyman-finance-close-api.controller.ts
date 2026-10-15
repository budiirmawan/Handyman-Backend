import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { getPool } from '../../database/connection';
import { authenticationRequiredError } from '../auth';
import {
  buildingAccessDeniedError,
  canAccessClient,
} from '../context-access';
import {
  activateHandymanCommercialAgreementVersion,
  handymanCommercialAgreementRepository,
  handymanCommercialAgreementVersionNotFoundError,
  prepareHandymanCommercialAgreement,
  supersedeHandymanCommercialAgreementVersion,
} from '../handyman-commercial-agreements';
import { prepareHandymanLaborPricingBasis } from '../handyman-labor-pricing';
import { prepareHandymanMaterialPricingBasis } from '../handyman-material-pricing';
import {
  prepareHandymanBmFeeBeneficiary,
  prepareHandymanBmFeeRule,
  prepareHandymanBmFeeTerm,
} from '../handyman-bm-fee-rules';
import {
  readHandymanBmFeeConfigurationAt,
  readHandymanPricingContractAt,
} from '../handyman-pricing-contract';
import {
  composeHandymanChargeLine,
  openHandymanCustomerTransaction,
} from '../handyman-customer-transactions';
import { allocateHandymanCustomerPayment } from '../handyman-customer-payment-allocations';
import {
  adjustHandymanCustomerLedger,
  refundHandymanCustomerPayment,
  reverseHandymanCustomerPayment,
  reverseHandymanPaymentAllocation,
} from '../handyman-customer-ledger-corrections';
import { deriveHandymanFinancialEntitlements } from '../handyman-financial-entitlements';
import {
  holdHandymanSettlementDispute,
  includeHandymanSettlement,
  prepareHandymanSettlement,
  reconcileHandymanSettlement,
  recordHandymanSettlementCorrection,
  settleHandymanSettlement,
} from '../handyman-settlement';
import {
  readHandymanFinancialClientAt,
  readHandymanFinancialTransactionAt,
} from '../handyman-financial-read';
import {
  expireHandymanServiceWarranty,
  startHandymanServiceWarranty,
} from '../handyman-service-warranties';
import {
  completeHandymanServiceWarrantyRework,
  proposeHandymanServiceWarrantyRework,
  startHandymanServiceWarrantyRework,
  verifyHandymanServiceWarrantyRework,
} from '../handyman-service-warranty-reworks';
import {
  assertOnlyKeys,
  optionalNullableStringField,
  optionalQueryLimit,
  optionalQueryString,
  requireIdempotencyKey,
  requirePlainBody,
  requireQueryString,
  requireStringField,
} from './handyman-finance-close-api.validation';

/**
 * CR-HM-E2E-LIFECYCLE-01 — thin HTTP transport over the already-merged
 * J10–J12 domain engines (CR-HM-12 commercial/pricing, CR-HM-13 customer
 * ledger, CR-HM-14 entitlement/settlement/financial-read, CR-HM-15
 * service warranty + free rework).
 *
 * This controller owns no business rule, no amount, no transition:
 * every command delegates to the owning service, which re-derives
 * amounts from governed snapshots, enforces exact-Building / crew
 * authority, and persists append-only events under idempotency keys.
 * The only transport-side additions are:
 *  - strict body allow-lists (no smuggled authority fields), and
 *  - a client-access guard for the client-scoped commercial/pricing
 *    authoring services, which are client-scoped aggregates without a
 *    Building and therefore have no Building guard of their own.
 */

const p = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

async function assertClientAccess(
  actorUserId: string,
  clientId: string,
): Promise<void> {
  if (!(await canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function assertVersionClientAccess(
  actorUserId: string,
  agreementVersionId: string,
): Promise<void> {
  const version = await handymanCommercialAgreementRepository.findVersionById(
    getPool(),
    agreementVersionId,
  );
  if (!version) {
    throw handymanCommercialAgreementVersionNotFoundError();
  }
  await assertClientAccess(actorUserId, version.clientId);
}

/* ------------------------------------------------------------------ */
/* J12 — commercial agreement + pricing/BM-fee authoring (client scope) */
/* ------------------------------------------------------------------ */

export async function postCommercialAgreementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['clientId', 'idempotencyKey']);
    const clientId = requireStringField(body, 'clientId');
    await assertClientAccess(actorUserId, clientId);
    const result = await prepareHandymanCommercialAgreement(actorUserId, {
      clientId,
      idempotencyKey: requireIdempotencyKey(body),
    });
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postCommercialAgreementVersionActivateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const agreementVersionId = p(req.params.agreementVersionId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['effectiveFrom', 'idempotencyKey']);
    await assertVersionClientAccess(actorUserId, agreementVersionId);
    const result = await activateHandymanCommercialAgreementVersion(
      actorUserId,
      {
        versionId: agreementVersionId,
        effectiveFrom: requireStringField(body, 'effectiveFrom'),
        idempotencyKey: requireIdempotencyKey(body),
      },
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postCommercialAgreementVersionSupersedeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const agreementVersionId = p(req.params.agreementVersionId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, [
      'replacementVersionId',
      'effectiveFrom',
      'idempotencyKey',
    ]);
    await assertVersionClientAccess(actorUserId, agreementVersionId);
    const result = await supersedeHandymanCommercialAgreementVersion(
      actorUserId,
      {
        versionId: agreementVersionId,
        replacementVersionId: requireStringField(
          body,
          'replacementVersionId',
        ),
        effectiveFrom: requireStringField(body, 'effectiveFrom'),
        idempotencyKey: requireIdempotencyKey(body),
      },
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postLaborPricingBasisHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const agreementVersionId = p(req.params.agreementVersionId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, [
      'mode',
      'crewMode',
      'billableTimeBasis',
      'unitAmount',
      'currency',
      'idempotencyKey',
    ]);
    await assertVersionClientAccess(actorUserId, agreementVersionId);
    const result = await prepareHandymanLaborPricingBasis(actorUserId, {
      agreementVersionId,
      mode: requireStringField(body, 'mode'),
      crewMode: requireStringField(body, 'crewMode'),
      billableTimeBasis: optionalNullableStringField(
        body,
        'billableTimeBasis',
      ),
      unitAmount: requireStringField(body, 'unitAmount'),
      currency: requireStringField(body, 'currency'),
      idempotencyKey: requireIdempotencyKey(body),
    });
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postMaterialPricingBasisHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const agreementVersionId = p(req.params.agreementVersionId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['mode', 'idempotencyKey']);
    await assertVersionClientAccess(actorUserId, agreementVersionId);
    const result = await prepareHandymanMaterialPricingBasis(actorUserId, {
      agreementVersionId,
      mode: requireStringField(body, 'mode'),
      idempotencyKey: requireIdempotencyKey(body),
    });
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postBmFeeRuleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const agreementVersionId = p(req.params.agreementVersionId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['basis', 'mode', 'idempotencyKey']);
    await assertVersionClientAccess(actorUserId, agreementVersionId);
    const result = await prepareHandymanBmFeeRule(actorUserId, {
      agreementVersionId,
      basis: requireStringField(body, 'basis'),
      mode: requireStringField(body, 'mode'),
      idempotencyKey: requireIdempotencyKey(body),
    });
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postBmFeeTermHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const agreementVersionId = p(req.params.agreementVersionId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['termKind', 'ratePercent', 'idempotencyKey']);
    await assertVersionClientAccess(actorUserId, agreementVersionId);
    const result = await prepareHandymanBmFeeTerm(actorUserId, {
      agreementVersionId,
      termKind: requireStringField(body, 'termKind'),
      ratePercent: requireStringField(body, 'ratePercent'),
      idempotencyKey: requireIdempotencyKey(body),
    });
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postBmFeeBeneficiaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const agreementVersionId = p(req.params.agreementVersionId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, [
      'beneficiaryKind',
      'beneficiaryReferenceId',
      'idempotencyKey',
    ]);
    await assertVersionClientAccess(actorUserId, agreementVersionId);
    const result = await prepareHandymanBmFeeBeneficiary(actorUserId, {
      agreementVersionId,
      beneficiaryKind: requireStringField(body, 'beneficiaryKind'),
      beneficiaryReferenceId: requireStringField(
        body,
        'beneficiaryReferenceId',
      ),
      idempotencyKey: requireIdempotencyKey(body),
    });
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function getPricingContractHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const clientId = requireQueryString(query, 'clientId');
    const asOf = requireQueryString(query, 'asOf');
    await assertClientAccess(actorUserId, clientId);
    const result = await readHandymanPricingContractAt(clientId, asOf);
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function getBmFeeConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const clientId = requireQueryString(query, 'clientId');
    const asOf = requireQueryString(query, 'asOf');
    await assertClientAccess(actorUserId, clientId);
    const result = await readHandymanBmFeeConfigurationAt(clientId, asOf);
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

/* ------------------------------------------------------------------ */
/* J10 — customer transaction open / charge / allocation / corrections  */
/* ------------------------------------------------------------------ */

export async function postOpenCustomerTransactionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['idempotencyKey']);
    const result = await openHandymanCustomerTransaction(
      {
        executionScopeId,
        idempotencyKey: requireIdempotencyKey(body),
      },
      actorUserId,
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postComposeChargeLineHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['quotationLineId', 'idempotencyKey']);
    const result = await composeHandymanChargeLine(
      {
        executionScopeId,
        quotationLineId: requireStringField(body, 'quotationLineId'),
        idempotencyKey: requireIdempotencyKey(body),
      },
      actorUserId,
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postAllocateCustomerPaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, [
      'paymentId',
      'chargeLineId',
      'amount',
      'idempotencyKey',
    ]);
    const result = await allocateHandymanCustomerPayment(
      {
        executionScopeId,
        paymentId: requireStringField(body, 'paymentId'),
        chargeLineId: requireStringField(body, 'chargeLineId'),
        amount: requireStringField(body, 'amount'),
        idempotencyKey: requireIdempotencyKey(body),
      },
      actorUserId,
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postRefundCustomerPaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['paymentId', 'amount', 'reason', 'idempotencyKey']);
    const result = await refundHandymanCustomerPayment(
      {
        executionScopeId,
        paymentId: requireStringField(body, 'paymentId'),
        amount: requireStringField(body, 'amount'),
        reason: requireStringField(body, 'reason'),
        idempotencyKey: requireIdempotencyKey(body),
      },
      actorUserId,
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postReversePaymentAllocationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['allocationId', 'reason', 'idempotencyKey']);
    const result = await reverseHandymanPaymentAllocation(
      {
        executionScopeId,
        allocationId: requireStringField(body, 'allocationId'),
        reason: requireStringField(body, 'reason'),
        idempotencyKey: requireIdempotencyKey(body),
      },
      actorUserId,
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postReverseCustomerPaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['paymentId', 'reason', 'idempotencyKey']);
    const result = await reverseHandymanCustomerPayment(
      {
        executionScopeId,
        paymentId: requireStringField(body, 'paymentId'),
        reason: requireStringField(body, 'reason'),
        idempotencyKey: requireIdempotencyKey(body),
      },
      actorUserId,
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postAdjustCustomerLedgerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, [
      'chargeLineId',
      'amount',
      'reason',
      'idempotencyKey',
    ]);
    const result = await adjustHandymanCustomerLedger(
      {
        executionScopeId,
        chargeLineId: optionalNullableStringField(body, 'chargeLineId'),
        amount: requireStringField(body, 'amount'),
        reason: requireStringField(body, 'reason'),
        idempotencyKey: requireIdempotencyKey(body),
      },
      actorUserId,
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

/* ------------------------------------------------------------------ */
/* J12 — entitlement derivation, settlement ladder, financial reads     */
/* ------------------------------------------------------------------ */

export async function postDeriveEntitlementsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['idempotencyKey']);
    const result = await deriveHandymanFinancialEntitlements(
      executionScopeId,
      actorUserId,
      requireIdempotencyKey(body),
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postPrepareSettlementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['idempotencyKey']);
    const result = await prepareHandymanSettlement(
      executionScopeId,
      actorUserId,
      requireIdempotencyKey(body),
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postIncludeSettlementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['idempotencyKey']);
    const result = await includeHandymanSettlement(
      executionScopeId,
      actorUserId,
      requireIdempotencyKey(body),
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postReconcileSettlementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['idempotencyKey']);
    const result = await reconcileHandymanSettlement(
      executionScopeId,
      actorUserId,
      requireIdempotencyKey(body),
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postSettleSettlementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['idempotencyKey']);
    const result = await settleHandymanSettlement(
      executionScopeId,
      actorUserId,
      requireIdempotencyKey(body),
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postSettlementCorrectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['ledgerCorrectionId', 'idempotencyKey']);
    const result = await recordHandymanSettlementCorrection(
      executionScopeId,
      actorUserId,
      requireStringField(body, 'ledgerCorrectionId'),
      requireIdempotencyKey(body),
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postSettlementDisputeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['idempotencyKey']);
    const result = await holdHandymanSettlementDispute(
      executionScopeId,
      actorUserId,
      requireIdempotencyKey(body),
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function getFinancialTransactionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const result = await readHandymanFinancialTransactionAt(
      executionScopeId,
      actorUserId,
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

const FINANCIAL_CLIENT_QUERY_KEYS = [
  'clientId',
  'buildingId',
  'from',
  'to',
  'limit',
] as const;

export async function getFinancialClientHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const query = (req.query ?? {}) as Record<string, unknown>;
    assertOnlyKeys(query, FINANCIAL_CLIENT_QUERY_KEYS);
    const clientId = requireQueryString(query, 'clientId');
    const result = await readHandymanFinancialClientAt(
      clientId,
      actorUserId,
      {
        buildingId: optionalQueryString(query, 'buildingId') ?? null,
        from: optionalQueryString(query, 'from') ?? null,
        to: optionalQueryString(query, 'to') ?? null,
        limit: optionalQueryLimit(query),
      },
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

/* ------------------------------------------------------------------ */
/* J11 — service warranty start/expire + field free-rework ladder       */
/* ------------------------------------------------------------------ */

export async function postStartServiceWarrantyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const executionScopeId = p(req.params.executionScopeId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['idempotencyKey']);
    const result = await startHandymanServiceWarranty(
      {
        executionScopeId,
        idempotencyKey: requireIdempotencyKey(body),
      },
      actorUserId,
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postExpireServiceWarrantyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const warrantyId = p(req.params.warrantyId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['idempotencyKey']);
    const result = await expireHandymanServiceWarranty(
      {
        warrantyId,
        idempotencyKey: requireIdempotencyKey(body),
      },
      actorUserId,
    );
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postProposeServiceWarrantyReworkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const claimId = p(req.params.claimId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['scopeNote', 'idempotencyKey']);
    const result = await proposeHandymanServiceWarrantyRework(actorUserId, {
      claimId,
      scopeNote: optionalNullableStringField(body, 'scopeNote'),
      idempotencyKey: requireIdempotencyKey(body),
    });
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postStartServiceWarrantyReworkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const reworkId = p(req.params.reworkId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['idempotencyKey']);
    const result = await startHandymanServiceWarrantyRework(actorUserId, {
      reworkId,
      idempotencyKey: requireIdempotencyKey(body),
    });
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postCompleteServiceWarrantyReworkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const reworkId = p(req.params.reworkId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['completionNote', 'idempotencyKey']);
    const result = await completeHandymanServiceWarrantyRework(actorUserId, {
      reworkId,
      completionNote: optionalNullableStringField(body, 'completionNote'),
      idempotencyKey: requireIdempotencyKey(body),
    });
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}

export async function postVerifyServiceWarrantyReworkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorUserId = actor(req);
    const reworkId = p(req.params.reworkId);
    const body = requirePlainBody(req.body);
    assertOnlyKeys(body, ['evidenceRecordId', 'qcRunId', 'idempotencyKey']);
    const result = await verifyHandymanServiceWarrantyRework(actorUserId, {
      reworkId,
      evidenceRecordId: requireStringField(body, 'evidenceRecordId'),
      qcRunId: optionalNullableStringField(body, 'qcRunId'),
      idempotencyKey: requireIdempotencyKey(body),
    });
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}
