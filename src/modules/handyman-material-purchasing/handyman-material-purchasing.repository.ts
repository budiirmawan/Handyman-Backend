import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanMaterialFundingSource,
  HandymanMaterialPurchaseEventRecord,
  HandymanMaterialPurchaseRecord,
  HandymanMaterialPurchaseStatus,
  HandymanMaterialReimbursementStatus,
  HandymanMaterialReturnDestination,
} from './handyman-material-purchasing.types';

type DbExecutor = Pick<PoolClient, 'query'>;

interface PurchaseRow {
  id: string;
  client_id: string;
  execution_scope_id: string;
  handyman_request_id: string;
  tenant_company_id: string;
  building_id: string;
  material_execution_line_id: string | null;
  source_item_id: string | null;
  item_name: string;
  uom_id: string;
  uom_code: string | null;
  funding_source: HandymanMaterialFundingSource;
  status: HandymanMaterialPurchaseStatus;
  requested_quantity: string;
  approved_quantity: string;
  issued_quantity: string;
  purchased_quantity: string;
  used_quantity: string;
  returned_quantity: string;
  return_destination: HandymanMaterialReturnDestination | null;
  supplier_name: string | null;
  supplier_reference: string | null;
  purchase_reference: string | null;
  purchase_date: Date | string | null;
  currency: string;
  approved_max_unit_price: string | null;
  actual_unit_price: string | null;
  actual_total_expense_amount: string;
  net_used_expense_amount: string;
  approval_reference: string | null;
  expenditure_reference: string | null;
  cash_advance_reference: string | null;
  receipt_evidence_reference: string | null;
  latest_evidence_reference: string;
  reimbursement_payable_amount: string;
  reimbursement_payee_user_id: string | null;
  reimbursement_status: HandymanMaterialReimbursementStatus;
  tenant_charge_eligible: boolean;
  tenant_charge_eligible_qty: string;
  tenant_invoiced: boolean;
  requested_by_user_id: string;
  approved_by_user_id: string | null;
  reconciled_by_user_id: string | null;
  reconciled_at: Date | string | null;
  create_idempotency_key: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PurchaseEventRow {
  id: string;
  client_id: string;
  purchase_record_id: string;
  execution_scope_id: string;
  event_type: HandymanMaterialPurchaseStatus;
  from_status: HandymanMaterialPurchaseStatus | null;
  to_status: HandymanMaterialPurchaseStatus;
  actor_user_id: string;
  actor_role: 'PIC_PEKERJAAN' | 'OPERATIONS_MANAGER';
  quantity_delta: string;
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

function mapPurchaseRow(row: PurchaseRow): HandymanMaterialPurchaseRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    handymanRequestId: row.handyman_request_id,
    tenantCompanyId: row.tenant_company_id,
    buildingId: row.building_id,
    materialExecutionLineId: row.material_execution_line_id,
    sourceItemId: row.source_item_id,
    itemName: row.item_name,
    uomId: row.uom_id,
    uomCode: row.uom_code,
    fundingSource: row.funding_source,
    status: row.status,
    requestedQuantity: Number(row.requested_quantity).toFixed(3),
    approvedQuantity: Number(row.approved_quantity).toFixed(3),
    issuedQuantity: Number(row.issued_quantity).toFixed(3),
    purchasedQuantity: Number(row.purchased_quantity).toFixed(3),
    usedQuantity: Number(row.used_quantity).toFixed(3),
    returnedQuantity: Number(row.returned_quantity).toFixed(3),
    returnDestination: row.return_destination,
    supplierName: row.supplier_name,
    supplierReference: row.supplier_reference,
    purchaseReference: row.purchase_reference,
    purchaseDate: toIso(row.purchase_date),
    currency: row.currency,
    approvedMaxUnitPrice:
      row.approved_max_unit_price !== null
        ? Number(row.approved_max_unit_price).toFixed(2)
        : null,
    actualUnitPrice:
      row.actual_unit_price !== null
        ? Number(row.actual_unit_price).toFixed(2)
        : null,
    actualTotalExpenseAmount: Number(row.actual_total_expense_amount).toFixed(
      2,
    ),
    netUsedExpenseAmount: Number(row.net_used_expense_amount).toFixed(2),
    approvalReference: row.approval_reference,
    expenditureReference: row.expenditure_reference,
    cashAdvanceReference: row.cash_advance_reference,
    receiptEvidenceReference: row.receipt_evidence_reference,
    latestEvidenceReference: row.latest_evidence_reference,
    reimbursementPayableAmount: Number(
      row.reimbursement_payable_amount,
    ).toFixed(2),
    reimbursementPayeeUserId: row.reimbursement_payee_user_id,
    reimbursementStatus: row.reimbursement_status,
    tenantChargeEligible: Boolean(row.tenant_charge_eligible),
    tenantChargeEligibleQty: Number(row.tenant_charge_eligible_qty).toFixed(3),
    tenantInvoiced: Boolean(row.tenant_invoiced),
    requestedByUserId: row.requested_by_user_id,
    approvedByUserId: row.approved_by_user_id,
    reconciledByUserId: row.reconciled_by_user_id,
    reconciledAt: toIso(row.reconciled_at),
    createIdempotencyKey: row.create_idempotency_key,
    version: Number(row.version),
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

function mapEventRow(row: PurchaseEventRow): HandymanMaterialPurchaseEventRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    purchaseRecordId: row.purchase_record_id,
    executionScopeId: row.execution_scope_id,
    eventType: row.event_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorUserId: row.actor_user_id,
    actorRole: row.actor_role,
    quantityDelta: Number(row.quantity_delta).toFixed(3),
    evidenceReference: row.evidence_reference,
    notes: row.notes,
    idempotencyKey: row.idempotency_key,
    metadata: row.metadata ?? {},
    occurredAt: toIso(row.occurred_at)!,
  };
}

const PURCHASE_COLUMNS = `
  id, client_id, execution_scope_id, handyman_request_id, tenant_company_id,
  building_id, material_execution_line_id, source_item_id, item_name,
  uom_id, uom_code, funding_source, status,
  requested_quantity::text AS requested_quantity,
  approved_quantity::text AS approved_quantity,
  issued_quantity::text AS issued_quantity,
  purchased_quantity::text AS purchased_quantity,
  used_quantity::text AS used_quantity,
  returned_quantity::text AS returned_quantity,
  return_destination, supplier_name, supplier_reference, purchase_reference,
  purchase_date, currency,
  approved_max_unit_price::text AS approved_max_unit_price,
  actual_unit_price::text AS actual_unit_price,
  actual_total_expense_amount::text AS actual_total_expense_amount,
  net_used_expense_amount::text AS net_used_expense_amount,
  approval_reference, expenditure_reference, cash_advance_reference,
  receipt_evidence_reference, latest_evidence_reference,
  reimbursement_payable_amount::text AS reimbursement_payable_amount,
  reimbursement_payee_user_id, reimbursement_status,
  tenant_charge_eligible,
  tenant_charge_eligible_qty::text AS tenant_charge_eligible_qty,
  tenant_invoiced, requested_by_user_id, approved_by_user_id,
  reconciled_by_user_id, reconciled_at, create_idempotency_key, version,
  created_at, updated_at
`;

export const handymanMaterialPurchasingRepository = {
  async findByIdForUpdate(
    tx: DbExecutor,
    purchaseRecordId: string,
    executionScopeId: string,
  ): Promise<HandymanMaterialPurchaseRecord | null> {
    const res = await tx.query<PurchaseRow>(
      `SELECT ${PURCHASE_COLUMNS}
         FROM handyman_material_purchase_records
        WHERE id = $1 AND execution_scope_id = $2
        FOR UPDATE`,
      [purchaseRecordId, executionScopeId],
    );
    return res.rows[0] ? mapPurchaseRow(res.rows[0]) : null;
  },

  async findByCreateIdempotencyKey(
    tx: DbExecutor,
    executionScopeId: string,
    createIdempotencyKey: string,
  ): Promise<HandymanMaterialPurchaseRecord | null> {
    const res = await tx.query<PurchaseRow>(
      `SELECT ${PURCHASE_COLUMNS}
         FROM handyman_material_purchase_records
        WHERE execution_scope_id = $1 AND create_idempotency_key = $2`,
      [executionScopeId, createIdempotencyKey],
    );
    return res.rows[0] ? mapPurchaseRow(res.rows[0]) : null;
  },

  async listByExecutionScope(
    executionScopeId: string,
    tx?: DbExecutor,
  ): Promise<HandymanMaterialPurchaseRecord[]> {
    const db = tx ?? getPool();
    const res = await db.query<PurchaseRow>(
      `SELECT ${PURCHASE_COLUMNS}
         FROM handyman_material_purchase_records
        WHERE execution_scope_id = $1
        ORDER BY created_at ASC, id ASC`,
      [executionScopeId],
    );
    return res.rows.map(mapPurchaseRow);
  },

  async insertPurchaseRecord(
    tx: DbExecutor,
    input: {
      id: string;
      clientId: string;
      executionScopeId: string;
      handymanRequestId: string;
      tenantCompanyId: string;
      buildingId: string;
      materialExecutionLineId: string | null;
      sourceItemId: string | null;
      itemName: string;
      uomId: string;
      uomCode: string | null;
      fundingSource: HandymanMaterialFundingSource;
      requestedQuantity: string;
      supplierName: string | null;
      supplierReference: string | null;
      currency: string;
      cashAdvanceReference: string | null;
      latestEvidenceReference: string;
      requestedByUserId: string;
      createIdempotencyKey: string;
    },
  ): Promise<HandymanMaterialPurchaseRecord> {
    const res = await tx.query<PurchaseRow>(
      `INSERT INTO handyman_material_purchase_records (
         id, client_id, execution_scope_id, handyman_request_id,
         tenant_company_id, building_id, material_execution_line_id,
         source_item_id, item_name, uom_id, uom_code, funding_source,
         status, requested_quantity, supplier_name, supplier_reference,
         currency, cash_advance_reference, latest_evidence_reference,
         requested_by_user_id, create_idempotency_key, version
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         'REQUEST', $13::numeric(14,3), $14, $15, $16, $17, $18, $19, $20, 1
       )
       RETURNING ${PURCHASE_COLUMNS}`,
      [
        input.id,
        input.clientId,
        input.executionScopeId,
        input.handymanRequestId,
        input.tenantCompanyId,
        input.buildingId,
        input.materialExecutionLineId,
        input.sourceItemId,
        input.itemName,
        input.uomId,
        input.uomCode,
        input.fundingSource,
        input.requestedQuantity,
        input.supplierName,
        input.supplierReference,
        input.currency,
        input.cashAdvanceReference,
        input.latestEvidenceReference,
        input.requestedByUserId,
        input.createIdempotencyKey,
      ],
    );
    return mapPurchaseRow(res.rows[0]);
  },

  async updatePurchaseRecord(
    tx: DbExecutor,
    input: {
      purchaseRecordId: string;
      status: HandymanMaterialPurchaseStatus;
      latestEvidenceReference: string;
      approvedQuantity?: string;
      issuedQuantity?: string;
      purchasedQuantity?: string;
      usedQuantity?: string;
      returnedQuantity?: string;
      returnDestination?: HandymanMaterialReturnDestination | null;
      supplierName?: string | null;
      supplierReference?: string | null;
      purchaseReference?: string | null;
      purchaseDate?: Date | null;
      currency?: string;
      approvedMaxUnitPrice?: string | null;
      actualUnitPrice?: string | null;
      actualTotalExpenseAmount?: string;
      netUsedExpenseAmount?: string;
      approvalReference?: string | null;
      expenditureReference?: string | null;
      cashAdvanceReference?: string | null;
      receiptEvidenceReference?: string | null;
      reimbursementPayableAmount?: string;
      reimbursementPayeeUserId?: string | null;
      reimbursementStatus?: HandymanMaterialReimbursementStatus;
      tenantChargeEligible?: boolean;
      tenantChargeEligibleQty?: string;
      approvedByUserId?: string | null;
      reconciledByUserId?: string | null;
      reconciledAt?: Date | null;
    },
  ): Promise<HandymanMaterialPurchaseRecord> {
    const res = await tx.query<PurchaseRow>(
      `UPDATE handyman_material_purchase_records
          SET status = $2,
              latest_evidence_reference = $3,
              approved_quantity = COALESCE($4::numeric(14,3), approved_quantity),
              issued_quantity = COALESCE($5::numeric(14,3), issued_quantity),
              purchased_quantity = COALESCE($6::numeric(14,3), purchased_quantity),
              used_quantity = COALESCE($7::numeric(14,3), used_quantity),
              returned_quantity = COALESCE($8::numeric(14,3), returned_quantity),
              return_destination = COALESCE($9, return_destination),
              supplier_name = COALESCE($10, supplier_name),
              supplier_reference = COALESCE($11, supplier_reference),
              purchase_reference = COALESCE($12, purchase_reference),
              purchase_date = COALESCE($13, purchase_date),
              currency = COALESCE($14, currency),
              approved_max_unit_price = COALESCE($15::numeric(18,2), approved_max_unit_price),
              actual_unit_price = COALESCE($16::numeric(18,2), actual_unit_price),
              actual_total_expense_amount = COALESCE($17::numeric(18,2), actual_total_expense_amount),
              net_used_expense_amount = COALESCE($18::numeric(18,2), net_used_expense_amount),
              approval_reference = COALESCE($19, approval_reference),
              expenditure_reference = COALESCE($20, expenditure_reference),
              cash_advance_reference = COALESCE($21, cash_advance_reference),
              receipt_evidence_reference = COALESCE($22, receipt_evidence_reference),
              reimbursement_payable_amount = COALESCE($23::numeric(18,2), reimbursement_payable_amount),
              reimbursement_payee_user_id = COALESCE($24, reimbursement_payee_user_id),
              reimbursement_status = COALESCE($25, reimbursement_status),
              tenant_charge_eligible = COALESCE($26, tenant_charge_eligible),
              tenant_charge_eligible_qty = COALESCE($27::numeric(14,3), tenant_charge_eligible_qty),
              approved_by_user_id = COALESCE($28, approved_by_user_id),
              reconciled_by_user_id = COALESCE($29, reconciled_by_user_id),
              reconciled_at = COALESCE($30, reconciled_at),
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${PURCHASE_COLUMNS}`,
      [
        input.purchaseRecordId,
        input.status,
        input.latestEvidenceReference,
        input.approvedQuantity ?? null,
        input.issuedQuantity ?? null,
        input.purchasedQuantity ?? null,
        input.usedQuantity ?? null,
        input.returnedQuantity ?? null,
        input.returnDestination ?? null,
        input.supplierName ?? null,
        input.supplierReference ?? null,
        input.purchaseReference ?? null,
        input.purchaseDate ?? null,
        input.currency ?? null,
        input.approvedMaxUnitPrice ?? null,
        input.actualUnitPrice ?? null,
        input.actualTotalExpenseAmount ?? null,
        input.netUsedExpenseAmount ?? null,
        input.approvalReference ?? null,
        input.expenditureReference ?? null,
        input.cashAdvanceReference ?? null,
        input.receiptEvidenceReference ?? null,
        input.reimbursementPayableAmount ?? null,
        input.reimbursementPayeeUserId ?? null,
        input.reimbursementStatus ?? null,
        input.tenantChargeEligible ?? null,
        input.tenantChargeEligibleQty ?? null,
        input.approvedByUserId ?? null,
        input.reconciledByUserId ?? null,
        input.reconciledAt ?? null,
      ],
    );
    return mapPurchaseRow(res.rows[0]);
  },

  async findEventByIdempotencyKey(
    tx: DbExecutor,
    purchaseRecordId: string,
    eventType: HandymanMaterialPurchaseStatus,
    idempotencyKey: string,
  ): Promise<HandymanMaterialPurchaseEventRecord | null> {
    const res = await tx.query<PurchaseEventRow>(
      `SELECT id, client_id, purchase_record_id, execution_scope_id, event_type,
              from_status, to_status, actor_user_id, actor_role,
              quantity_delta::text AS quantity_delta, evidence_reference,
              notes, idempotency_key, metadata, occurred_at
         FROM handyman_material_purchase_events
        WHERE purchase_record_id = $1 AND event_type = $2 AND idempotency_key = $3`,
      [purchaseRecordId, eventType, idempotencyKey],
    );
    return res.rows[0] ? mapEventRow(res.rows[0]) : null;
  },

  async insertEvent(
    tx: DbExecutor,
    input: {
      id: string;
      clientId: string;
      purchaseRecordId: string;
      executionScopeId: string;
      eventType: HandymanMaterialPurchaseStatus;
      fromStatus: HandymanMaterialPurchaseStatus | null;
      toStatus: HandymanMaterialPurchaseStatus;
      actorUserId: string;
      actorRole: 'PIC_PEKERJAAN' | 'OPERATIONS_MANAGER';
      quantityDelta: string;
      evidenceReference: string;
      notes: string | null;
      idempotencyKey: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<HandymanMaterialPurchaseEventRecord> {
    const res = await tx.query<PurchaseEventRow>(
      `INSERT INTO handyman_material_purchase_events (
         id, client_id, purchase_record_id, execution_scope_id, event_type,
         from_status, to_status, actor_user_id, actor_role,
         quantity_delta, evidence_reference, notes, idempotency_key, metadata
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10::numeric(14,3), $11, $12, $13, $14::jsonb
       )
       RETURNING id, client_id, purchase_record_id, execution_scope_id, event_type,
                 from_status, to_status, actor_user_id, actor_role,
                 quantity_delta::text AS quantity_delta, evidence_reference,
                 notes, idempotency_key, metadata, occurred_at`,
      [
        input.id,
        input.clientId,
        input.purchaseRecordId,
        input.executionScopeId,
        input.eventType,
        input.fromStatus,
        input.toStatus,
        input.actorUserId,
        input.actorRole,
        input.quantityDelta,
        input.evidenceReference,
        input.notes,
        input.idempotencyKey,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapEventRow(res.rows[0]);
  },

  async listEventsByRecord(
    purchaseRecordId: string,
    tx?: DbExecutor,
  ): Promise<HandymanMaterialPurchaseEventRecord[]> {
    const db = tx ?? getPool();
    const res = await db.query<PurchaseEventRow>(
      `SELECT id, client_id, purchase_record_id, execution_scope_id, event_type,
              from_status, to_status, actor_user_id, actor_role,
              quantity_delta::text AS quantity_delta, evidence_reference,
              notes, idempotency_key, metadata, occurred_at
         FROM handyman_material_purchase_events
        WHERE purchase_record_id = $1
        ORDER BY occurred_at ASC, id ASC`,
      [purchaseRecordId],
    );
    return res.rows.map(mapEventRow);
  },

  async listEventsByExecutionScope(
    executionScopeId: string,
    tx?: DbExecutor,
  ): Promise<HandymanMaterialPurchaseEventRecord[]> {
    const db = tx ?? getPool();
    const res = await db.query<PurchaseEventRow>(
      `SELECT id, client_id, purchase_record_id, execution_scope_id, event_type,
              from_status, to_status, actor_user_id, actor_role,
              quantity_delta::text AS quantity_delta, evidence_reference,
              notes, idempotency_key, metadata, occurred_at
         FROM handyman_material_purchase_events
        WHERE execution_scope_id = $1
        ORDER BY occurred_at ASC, id ASC`,
      [executionScopeId],
    );
    return res.rows.map(mapEventRow);
  },
};
