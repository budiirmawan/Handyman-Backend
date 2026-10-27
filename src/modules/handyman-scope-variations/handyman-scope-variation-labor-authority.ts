import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { handymanScopeVariationRepository } from './handyman-scope-variation.repository';
import {
  addLaborBindingFromEvents, assertAddLaborQuoteBinding, assertPinnedVariationApproval,
} from './handyman-scope-variation-material-authority';

/** The immutable LABOR quotation line is the service identity: its description,
 * UOM and quantity are the actual commercial snapshot, not an inferred
 * Service Catalog entry or the original quotation's labor line. */
export async function resolveApprovedAddLabor(
  tx: PoolClient,
  executionScopeId: string,
  variationId: string,
  expectedVersion: number,
) {
  const variation = await handymanScopeVariationRepository.findByIdForUpdate(tx, variationId, executionScopeId);
  if (!variation || variation.variationType !== 'ADD' || variation.lineType !== 'LABOR' ||
      variation.tenantDecisionOutcome !== 'APPROVED' ||
      !['AUTHORIZED_SCOPE', 'EXECUTION'].includes(variation.status) ||
      !variation.revisedQuotationVersionId || variation.quotedUnitAmount === null || !variation.currency) {
    throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message: 'Labor execution requires an authorized, approved ADD labor variation.' });
  }
  const events = await handymanScopeVariationRepository.listEventsByVariation(variation.id, tx);
  const binding = addLaborBindingFromEvents(variation, events);
  const decision = events.find((event) => event.eventType === 'TENANT_DECISION');
  const approvedVersion = (decision?.metadata.consentSnapshot as { version?: unknown } | undefined)?.version;
  const authorization = events.find((event) => event.eventType === 'AUTHORIZED_SCOPE' && event.actorRole === 'OPERATIONS_MANAGER');
  if (!binding || !authorization || typeof approvedVersion !== 'number' ||
      !Number.isInteger(approvedVersion) || approvedVersion < 1) {
    throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message: 'ADD labor requires a PIC-approved quotation-line and Work Order binding.' });
  }
  if (approvedVersion !== expectedVersion) {
    throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_VARIATION_VERSION_CONFLICT,
      message: 'The selected approved variation version is stale.' });
  }
  await assertPinnedVariationApproval(tx, variation, approvedVersion, events);
  await assertAddLaborQuoteBinding(tx, {
    executionScopeId, quotationVersionId: variation.revisedQuotationVersionId,
    quotationLineId: binding.revisedQuotationLineId, workOrderId: binding.workOrderId,
    quantity: variation.quantity, uomId: variation.uomId,
    quotedUnitAmount: variation.quotedUnitAmount, currency: variation.currency,
  });
  return { variation, binding, approvedVersion };
}
