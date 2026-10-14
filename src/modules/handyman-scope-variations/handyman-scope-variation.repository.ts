import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanScopeVariationActorRole,
  HandymanScopeVariationEventRecord,
  HandymanScopeVariationLineType,
  HandymanScopeVariationQcOutcome,
  HandymanScopeVariationRecord,
  HandymanScopeVariationStatus,
  HandymanScopeVariationTenantDecision,
  HandymanScopeVariationType,
} from './handyman-scope-variation.types';

type DbExecutor = Pick<PoolClient, 'query'>;

interface VariationRow {
  id: string;
  client_id: string;
  execution_scope_id: string;
  handyman_request_id: string;
  tenant_company_id: string;
  building_id: string;
  variation_type: HandymanScopeVariationType;
  line_type: HandymanScopeVariationLineType;
  target_quotation_line_id: string | null;
  revised_quotation_version_id: string | null;
  title: string;
  description: string;
  technical_finding: string;
  quantity: string;
  uom_id: string;
  quoted_unit_amount: string | null;
  quoted_total_delta: string | null;
  currency: string | null;
  status: HandymanScopeVariationStatus;
  tenant_decision_outcome: HandymanScopeVariationTenantDecision | null;
  tenant_decided_by_user_id: string | null;
  tenant_decided_at: Date | string | null;
  qc_outcome: HandymanScopeVariationQcOutcome | null;
  qc_verified_by_user_id: string | null;
  qc_verified_at: Date | string | null;
  final_charge_eligible: boolean;
  invoiced: boolean;
  origin_actor_user_id: string;
  origin_actor_role: 'PIC_PEKERJAAN' | 'INSPECTOR';
  latest_evidence_reference: string;
  create_idempotency_key: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface VariationEventRow {
  id: string;
  client_id: string;
  variation_id: string;
  execution_scope_id: string;
  event_type: HandymanScopeVariationStatus;
  from_status: HandymanScopeVariationStatus | null;
  to_status: HandymanScopeVariationStatus;
  actor_user_id: string;
  actor_role: HandymanScopeVariationActorRole;
  evidence_reference: string;
  notes: string | null;
  idempotency_key: string;
  metadata: Record<string, unknown> | null;
  occurred_at: Date | string;
}

function toIso(val: Date | string | null): string | null {
  if (!val) return null;
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

function mapVariationRow(row: VariationRow): HandymanScopeVariationRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    handymanRequestId: row.handyman_request_id,
    tenantCompanyId: row.tenant_company_id,
    buildingId: row.building_id,
    variationType: row.variation_type,
    lineType: row.line_type,
    targetQuotationLineId: row.target_quotation_line_id,
    revisedQuotationVersionId: row.revised_quotation_version_id,
    title: row.title,
    description: row.description,
    technicalFinding: row.technical_finding,
    quantity: Number(row.quantity).toFixed(3),
    uomId: row.uom_id,
    quotedUnitAmount:
      row.quoted_unit_amount !== null
        ? Number(row.quoted_unit_amount).toFixed(2)
        : null,
    quotedTotalDelta:
      row.quoted_total_delta !== null
        ? Number(row.quoted_total_delta).toFixed(2)
        : null,
    currency: row.currency,
    status: row.status,
    tenantDecisionOutcome: row.tenant_decision_outcome,
    tenantDecidedByUserId: row.tenant_decided_by_user_id,
    tenantDecidedAt: toIso(row.tenant_decided_at),
    qcOutcome: row.qc_outcome,
    qcVerifiedByUserId: row.qc_verified_by_user_id,
    qcVerifiedAt: toIso(row.qc_verified_at),
    finalChargeEligible: Boolean(row.final_charge_eligible),
    invoiced: Boolean(row.invoiced),
    originActorUserId: row.origin_actor_user_id,
    originActorRole: row.origin_actor_role,
    latestEvidenceReference: row.latest_evidence_reference,
    createIdempotencyKey: row.create_idempotency_key,
    version: Number(row.version),
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

function mapVariationEventRow(
  row: VariationEventRow,
): HandymanScopeVariationEventRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    variationId: row.variation_id,
    executionScopeId: row.execution_scope_id,
    eventType: row.event_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorUserId: row.actor_user_id,
    actorRole: row.actor_role,
    evidenceReference: row.evidence_reference,
    notes: row.notes,
    idempotencyKey: row.idempotency_key,
    metadata: row.metadata ?? {},
    occurredAt: toIso(row.occurred_at)!,
  };
}

const VARIATION_COLUMNS = `
  id, client_id, execution_scope_id, handyman_request_id, tenant_company_id,
  building_id, variation_type, line_type, target_quotation_line_id,
  revised_quotation_version_id, title, description, technical_finding,
  quantity::text AS quantity, uom_id,
  quoted_unit_amount::text AS quoted_unit_amount,
  quoted_total_delta::text AS quoted_total_delta,
  currency, status, tenant_decision_outcome, tenant_decided_by_user_id,
  tenant_decided_at, qc_outcome, qc_verified_by_user_id, qc_verified_at,
  final_charge_eligible, invoiced, origin_actor_user_id, origin_actor_role,
  latest_evidence_reference, create_idempotency_key, version,
  created_at, updated_at
`;

export const handymanScopeVariationRepository = {
  async findByIdForUpdate(
    tx: DbExecutor,
    variationId: string,
    executionScopeId: string,
  ): Promise<HandymanScopeVariationRecord | null> {
    const res = await tx.query<VariationRow>(
      `SELECT ${VARIATION_COLUMNS}
         FROM handyman_scope_variations
        WHERE id = $1 AND execution_scope_id = $2
        FOR UPDATE`,
      [variationId, executionScopeId],
    );
    return res.rows[0] ? mapVariationRow(res.rows[0]) : null;
  },

  async findByCreateIdempotencyKey(
    tx: DbExecutor,
    executionScopeId: string,
    createIdempotencyKey: string,
  ): Promise<HandymanScopeVariationRecord | null> {
    const res = await tx.query<VariationRow>(
      `SELECT ${VARIATION_COLUMNS}
         FROM handyman_scope_variations
        WHERE execution_scope_id = $1 AND create_idempotency_key = $2`,
      [executionScopeId, createIdempotencyKey],
    );
    return res.rows[0] ? mapVariationRow(res.rows[0]) : null;
  },

  async listByExecutionScope(
    executionScopeId: string,
    tx?: DbExecutor,
  ): Promise<HandymanScopeVariationRecord[]> {
    const db = tx ?? getPool();
    const res = await db.query<VariationRow>(
      `SELECT ${VARIATION_COLUMNS}
         FROM handyman_scope_variations
        WHERE execution_scope_id = $1
        ORDER BY created_at ASC, id ASC`,
      [executionScopeId],
    );
    return res.rows.map(mapVariationRow);
  },

  async insertVariation(
    tx: DbExecutor,
    input: {
      id: string;
      clientId: string;
      executionScopeId: string;
      handymanRequestId: string;
      tenantCompanyId: string;
      buildingId: string;
      variationType: HandymanScopeVariationType;
      lineType: HandymanScopeVariationLineType;
      targetQuotationLineId: string | null;
      title: string;
      description: string;
      technicalFinding: string;
      quantity: string;
      uomId: string;
      status: HandymanScopeVariationStatus;
      originActorUserId: string;
      originActorRole: 'PIC_PEKERJAAN' | 'INSPECTOR';
      latestEvidenceReference: string;
      createIdempotencyKey: string;
    },
  ): Promise<HandymanScopeVariationRecord> {
    const res = await tx.query<VariationRow>(
      `INSERT INTO handyman_scope_variations (
         id, client_id, execution_scope_id, handyman_request_id,
         tenant_company_id, building_id, variation_type, line_type,
         target_quotation_line_id, title, description, technical_finding,
         quantity, uom_id, status, origin_actor_user_id, origin_actor_role,
         latest_evidence_reference, create_idempotency_key, version
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13::numeric(14,3), $14, $15, $16, $17, $18, $19, 1
       )
       RETURNING ${VARIATION_COLUMNS}`,
      [
        input.id,
        input.clientId,
        input.executionScopeId,
        input.handymanRequestId,
        input.tenantCompanyId,
        input.buildingId,
        input.variationType,
        input.lineType,
        input.targetQuotationLineId,
        input.title,
        input.description,
        input.technicalFinding,
        input.quantity,
        input.uomId,
        input.status,
        input.originActorUserId,
        input.originActorRole,
        input.latestEvidenceReference,
        input.createIdempotencyKey,
      ],
    );
    return mapVariationRow(res.rows[0]);
  },

  async updateVariationState(
    tx: DbExecutor,
    input: {
      variationId: string;
      status: HandymanScopeVariationStatus;
      latestEvidenceReference: string;
      targetQuotationLineId?: string | null;
      revisedQuotationVersionId?: string | null;
      quotedUnitAmount?: string | null;
      quotedTotalDelta?: string | null;
      currency?: string | null;
      tenantDecisionOutcome?: HandymanScopeVariationTenantDecision | null;
      tenantDecidedByUserId?: string | null;
      tenantDecidedAt?: Date | null;
      qcOutcome?: HandymanScopeVariationQcOutcome | null;
      qcVerifiedByUserId?: string | null;
      qcVerifiedAt?: Date | null;
      finalChargeEligible?: boolean;
    },
  ): Promise<HandymanScopeVariationRecord> {
    const res = await tx.query<VariationRow>(
      `UPDATE handyman_scope_variations
          SET status = $2,
              latest_evidence_reference = $3,
              target_quotation_line_id = COALESCE($4, target_quotation_line_id),
              revised_quotation_version_id = COALESCE($5, revised_quotation_version_id),
              quoted_unit_amount = COALESCE($6::numeric(18,2), quoted_unit_amount),
              quoted_total_delta = COALESCE($7::numeric(18,2), quoted_total_delta),
              currency = COALESCE($8, currency),
              tenant_decision_outcome = COALESCE($9, tenant_decision_outcome),
              tenant_decided_by_user_id = COALESCE($10, tenant_decided_by_user_id),
              tenant_decided_at = COALESCE($11, tenant_decided_at),
              qc_outcome = COALESCE($12, qc_outcome),
              qc_verified_by_user_id = COALESCE($13, qc_verified_by_user_id),
              qc_verified_at = COALESCE($14, qc_verified_at),
              final_charge_eligible = COALESCE($15, final_charge_eligible),
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${VARIATION_COLUMNS}`,
      [
        input.variationId,
        input.status,
        input.latestEvidenceReference,
        input.targetQuotationLineId ?? null,
        input.revisedQuotationVersionId ?? null,
        input.quotedUnitAmount ?? null,
        input.quotedTotalDelta ?? null,
        input.currency ?? null,
        input.tenantDecisionOutcome ?? null,
        input.tenantDecidedByUserId ?? null,
        input.tenantDecidedAt ?? null,
        input.qcOutcome ?? null,
        input.qcVerifiedByUserId ?? null,
        input.qcVerifiedAt ?? null,
        input.finalChargeEligible ?? null,
      ],
    );
    return mapVariationRow(res.rows[0]);
  },

  async findEventByIdempotencyKey(
    tx: DbExecutor,
    variationId: string,
    eventType: HandymanScopeVariationStatus,
    idempotencyKey: string,
  ): Promise<HandymanScopeVariationEventRecord | null> {
    const res = await tx.query<VariationEventRow>(
      `SELECT id, client_id, variation_id, execution_scope_id, event_type,
              from_status, to_status, actor_user_id, actor_role,
              evidence_reference, notes, idempotency_key, metadata, occurred_at
         FROM handyman_scope_variation_events
        WHERE variation_id = $1 AND event_type = $2 AND idempotency_key = $3`,
      [variationId, eventType, idempotencyKey],
    );
    return res.rows[0] ? mapVariationEventRow(res.rows[0]) : null;
  },

  async insertEvent(
    tx: DbExecutor,
    input: {
      id: string;
      clientId: string;
      variationId: string;
      executionScopeId: string;
      eventType: HandymanScopeVariationStatus;
      fromStatus: HandymanScopeVariationStatus | null;
      toStatus: HandymanScopeVariationStatus;
      actorUserId: string;
      actorRole: HandymanScopeVariationActorRole;
      evidenceReference: string;
      notes: string | null;
      idempotencyKey: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<HandymanScopeVariationEventRecord> {
    const res = await tx.query<VariationEventRow>(
      `INSERT INTO handyman_scope_variation_events (
         id, client_id, variation_id, execution_scope_id, event_type,
         from_status, to_status, actor_user_id, actor_role,
         evidence_reference, notes, idempotency_key, metadata
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb
       )
       RETURNING id, client_id, variation_id, execution_scope_id, event_type,
                 from_status, to_status, actor_user_id, actor_role,
                 evidence_reference, notes, idempotency_key, metadata, occurred_at`,
      [
        input.id,
        input.clientId,
        input.variationId,
        input.executionScopeId,
        input.eventType,
        input.fromStatus,
        input.toStatus,
        input.actorUserId,
        input.actorRole,
        input.evidenceReference,
        input.notes,
        input.idempotencyKey,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapVariationEventRow(res.rows[0]);
  },

  async listEventsByExecutionScope(
    executionScopeId: string,
    tx?: DbExecutor,
  ): Promise<HandymanScopeVariationEventRecord[]> {
    const db = tx ?? getPool();
    const res = await db.query<VariationEventRow>(
      `SELECT id, client_id, variation_id, execution_scope_id, event_type,
              from_status, to_status, actor_user_id, actor_role,
              evidence_reference, notes, idempotency_key, metadata, occurred_at
         FROM handyman_scope_variation_events
        WHERE execution_scope_id = $1
        ORDER BY occurred_at ASC, id ASC`,
      [executionScopeId],
    );
    return res.rows.map(mapVariationEventRow);
  },

  async listEventsByVariation(
    variationId: string,
    tx?: DbExecutor,
  ): Promise<HandymanScopeVariationEventRecord[]> {
    const db = tx ?? getPool();
    const res = await db.query<VariationEventRow>(
      `SELECT id, client_id, variation_id, execution_scope_id, event_type,
              from_status, to_status, actor_user_id, actor_role,
              evidence_reference, notes, idempotency_key, metadata, occurred_at
         FROM handyman_scope_variation_events
        WHERE variation_id = $1
        ORDER BY occurred_at ASC, id ASC`,
      [variationId],
    );
    return res.rows.map(mapVariationEventRow);
  },
};
