import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { handymanScopeVariationRepository } from './handyman-scope-variation.repository';
import type { HandymanScopeVariationEventRecord, HandymanScopeVariationRecord } from './handyman-scope-variation.types';

export type AddMaterialBinding = {
  revisedQuotationLineId: string;
  workOrderId: string;
};

// The Operations quotation event is append-only. Its exact line and Work Order
// are included in the PIC consent snapshot; neither comes from the Crew Lead.
function addBindingFromEvents(
  v: HandymanScopeVariationRecord,
  events: HandymanScopeVariationEventRecord[],
  lineType: 'LABOR' | 'MATERIAL',
): AddMaterialBinding | null {
  const revision = events.find((e) => e.eventType === 'REVISED_QUOTATION' && e.actorRole === 'OPERATIONS_MANAGER');
  const line = revision?.metadata.revisedQuotationLineId;
  const workOrder = revision?.metadata.workOrderId;
  if (v.variationType !== 'ADD' || v.lineType !== lineType ||
      revision?.metadata.revisedQuotationVersionId !== v.revisedQuotationVersionId ||
      typeof line !== 'string' || !isValidUuid(line) ||
      typeof workOrder !== 'string' || !isValidUuid(workOrder)) return null;
  return { revisedQuotationLineId: line, workOrderId: workOrder };
}

export function addMaterialBindingFromEvents(v: HandymanScopeVariationRecord, events: HandymanScopeVariationEventRecord[]) {
  return addBindingFromEvents(v, events, 'MATERIAL');
}

export function addLaborBindingFromEvents(v: HandymanScopeVariationRecord, events: HandymanScopeVariationEventRecord[]) {
  return addBindingFromEvents(v, events, 'LABOR');
}

export function variationConsentSnapshot(
  v: HandymanScopeVariationRecord,
  version = v.version,
  binding: AddMaterialBinding | null = null,
) {
  return {
    version,
    revisedQuotationVersionId: v.revisedQuotationVersionId,
    variationType: v.variationType,
    lineType: v.lineType,
    targetQuotationLineId: v.targetQuotationLineId,
    title: v.title,
    description: v.description,
    technicalFinding: v.technicalFinding,
    quantity: v.quantity,
    uomId: v.uomId,
    quotedUnitAmount: v.quotedUnitAmount,
    quotedTotalDelta: v.quotedTotalDelta,
    currency: v.currency,
    ...(binding ?? {}),
  };
}

export async function assertPinnedVariationApproval(
  tx: PoolClient,
  variation: HandymanScopeVariationRecord,
  approvedVersion: number,
  existingEvents?: HandymanScopeVariationEventRecord[],
): Promise<void> {
  const events = existingEvents ?? await handymanScopeVariationRepository.listEventsByVariation(variation.id, tx);
  const decision = events.find((event) => event.eventType === 'TENANT_DECISION');
  const expected = variationConsentSnapshot(variation, approvedVersion,
    addMaterialBindingFromEvents(variation, events) ?? addLaborBindingFromEvents(variation, events));
  const snapshot = decision?.metadata.consentSnapshot;
  if (
    !decision || variation.tenantDecisionOutcome !== 'APPROVED' ||
    decision.actorRole !== 'TENANT' || decision.actorUserId !== variation.tenantDecidedByUserId ||
    decision.metadata.decisionOutcome !== 'APPROVED' || !snapshot ||
    typeof snapshot !== 'object' || Array.isArray(snapshot) ||
    !Object.entries(expected).every(([key, value]) => (snapshot as Record<string, unknown>)[key] === value)
  ) {
    throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message: 'Variation requires an exact version-pinned Tenant PIC approval; obtain a new decision on a newly issued variation.' });
  }
}

/** The quote line itself is the immutable material identity (including its
 * description, UOM and optional inventory source); no inventory item or
 * original quotation line is invented for one-off material. */
async function assertAddQuoteBinding(
  tx: PoolClient,
  input: {
    executionScopeId: string;
    quotationVersionId: string;
    quotationLineId: string;
    workOrderId: string;
    quantity: string;
    uomId: string;
    quotedUnitAmount: string;
    currency: string;
  },
  lineType: 'LABOR' | 'MATERIAL',
): Promise<{ sourceItemId: string | null }> {
  const workOrder = await tx.query<{ client_id: string; building_id: string; status: string }>(
    'SELECT client_id, building_id, status FROM work_orders WHERE id=$1 FOR SHARE', [input.workOrderId]);
  if (!workOrder.rows[0]) {
    throw new AppError({ statusCode: 404, code: ERROR_CODES.WORK_ORDER_NOT_FOUND, message: 'Work Order not found.' });
  }
  const scope = await tx.query<{ client_id: string; building_id: string }>(
    'SELECT client_id, building_id FROM handyman_execution_scopes WHERE id=$1', [input.executionScopeId]);
  if (!scope.rows[0] || scope.rows[0].client_id !== workOrder.rows[0].client_id ||
      scope.rows[0].building_id !== workOrder.rows[0].building_id) {
    throw new AppError({ statusCode: 403, code: ERROR_CODES.BUILDING_ACCESS_DENIED,
      message: 'Work Order must belong to the exact execution scope Client and Building.' });
  }
  if (!['OPEN', 'ASSIGNED', 'IN_PROGRESS'].includes(workOrder.rows[0].status)) {
    throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message: `Work Order is not open for ${lineType.toLowerCase()} execution.` });
  }
  const result = await tx.query<{ source_item_id: string | null }>(
    `SELECT l.source_item_id
       FROM handyman_execution_scopes s
       JOIN handyman_quotation_versions v ON v.quotation_id=s.quotation_id
       JOIN handyman_quotation_lines l ON l.quotation_version_id=v.id
      WHERE s.id=$1 AND v.id=$2 AND v.id<>s.approved_quotation_version_id
        AND l.id=$3 AND l.line_type=$8 AND l.quantity=$4::numeric
        AND l.uom_id=$5 AND l.final_quoted_unit_amount=$6::numeric AND l.currency=$7`,
    [input.executionScopeId, input.quotationVersionId, input.quotationLineId,
      input.quantity, input.uomId, input.quotedUnitAmount, input.currency, lineType],
  );
  if (!result.rows[0]) {
    throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message: `ADD ${lineType.toLowerCase()} must bind the exact revised quotation ${lineType} line, quantity, UOM and approved terms.` });
  }
  return { sourceItemId: result.rows[0].source_item_id };
}

type AddQuoteBindingInput = Parameters<typeof assertAddQuoteBinding>[1];
export function assertAddMaterialQuoteBinding(tx: PoolClient, input: AddQuoteBindingInput) {
  return assertAddQuoteBinding(tx, input, 'MATERIAL');
}
export function assertAddLaborQuoteBinding(tx: PoolClient, input: AddQuoteBindingInput) {
  return assertAddQuoteBinding(tx, input, 'LABOR');
}

/** Called under the execution-scope lock. The selected version is the exact
 * PIC-approved version, not a later lifecycle projection version. */
export async function resolveApprovedAddMaterial(
  tx: PoolClient,
  executionScopeId: string,
  variationId: string,
  expectedVersion?: number,
) {
  const v = await handymanScopeVariationRepository.findByIdForUpdate(tx, variationId, executionScopeId);
  if (!v || v.variationType !== 'ADD' || v.lineType !== 'MATERIAL' ||
      v.tenantDecisionOutcome !== 'APPROVED' || !['AUTHORIZED_SCOPE', 'EXECUTION'].includes(v.status) ||
      !v.revisedQuotationVersionId || v.quotedUnitAmount === null || !v.currency) {
    throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message: 'Material execution requires an authorized ADD material variation.' });
  }
  const events = await handymanScopeVariationRepository.listEventsByVariation(v.id, tx);
  const binding = addMaterialBindingFromEvents(v, events);
  const decision = events.find((e) => e.eventType === 'TENANT_DECISION');
  const approvedVersion = (decision?.metadata.consentSnapshot as { version?: unknown } | undefined)?.version;
  const authorization = events.find((e) => e.eventType === 'AUTHORIZED_SCOPE' && e.actorRole === 'OPERATIONS_MANAGER');
  if (!binding || !authorization || typeof approvedVersion !== 'number' || !Number.isInteger(approvedVersion) || approvedVersion < 1) {
    throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_VARIATION_ILLEGAL_TRANSITION,
      message: 'ADD material requires a PIC-approved quotation-line and Work Order binding.' });
  }
  if (expectedVersion !== undefined && approvedVersion !== expectedVersion) {
    throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_VARIATION_VERSION_CONFLICT,
      message: 'The selected approved variation version is stale.' });
  }
  await assertPinnedVariationApproval(tx, v, approvedVersion, events);
  const quote = await assertAddMaterialQuoteBinding(tx, {
    executionScopeId, quotationVersionId: v.revisedQuotationVersionId,
    quotationLineId: binding.revisedQuotationLineId, workOrderId: binding.workOrderId,
    quantity: v.quantity, uomId: v.uomId, quotedUnitAmount: v.quotedUnitAmount, currency: v.currency,
  });
  return { variation: v, binding, approvedVersion, sourceItemId: quote.sourceItemId };
}
