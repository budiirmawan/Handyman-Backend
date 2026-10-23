import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanMaterialFundingSource,
  HandymanMaterialPurchaseActorRole,
  HandymanMaterialPurchaseEventRecord,
  HandymanMaterialPurchaseEventType,
  HandymanMaterialPurchaseRecord,
  HandymanMaterialPurchaseStatus,
  HandymanMaterialReimbursementStatus,
  HandymanMaterialReturnDestination,
  HandymanReimbursementDisbursementMethod,
} from './handyman-material-purchasing.types';

type DbExecutor = Pick<PoolClient, 'query'>;

interface PurchaseRow {
  id: string;
  client_id: string;
  execution_scope_id: string;
  work_order_id: string | null;
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
  receipt_sha256_checksum: string | null;
  latest_evidence_reference: string;
  reimbursement_payable_amount: string;
  reimbursement_payee_user_id: string | null;
  reimbursement_status: HandymanMaterialReimbursementStatus;
  reimbursement_finance_approval_reference: string | null;
  reimbursement_finance_approved_by_user_id: string | null;
  reimbursement_finance_approved_at: Date | string | null;
  reimbursement_disbursement_reference: string | null;
  reimbursement_disbursement_method: HandymanReimbursementDisbursementMethod | null;
  reimbursement_disbursed_amount: string;
  reimbursement_disbursed_by_user_id: string | null;
  reimbursement_disbursed_at: Date | string | null;
  reimbursement_rejected_by_user_id: string | null;
  reimbursement_rejected_at: Date | string | null;
  reimbursement_rejection_reason: string | null;
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
  event_type: HandymanMaterialPurchaseEventType;
  from_status: HandymanMaterialPurchaseStatus | null;
  to_status: HandymanMaterialPurchaseStatus;
  actor_user_id: string;
  actor_role: HandymanMaterialPurchaseActorRole;
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
    workOrderId: row.work_order_id ?? null,
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
    receiptSha256Checksum: row.receipt_sha256_checksum ?? null,
    latestEvidenceReference: row.latest_evidence_reference,
    reimbursementPayableAmount: Number(
      row.reimbursement_payable_amount,
    ).toFixed(2),
    reimbursementPayeeUserId: row.reimbursement_payee_user_id,
    reimbursementStatus: row.reimbursement_status,
    reimbursementFinanceApprovalReference:
      row.reimbursement_finance_approval_reference ?? null,
    reimbursementFinanceApprovedByUserId:
      row.reimbursement_finance_approved_by_user_id ?? null,
    reimbursementFinanceApprovedAt: toIso(
      row.reimbursement_finance_approved_at ?? null,
    ),
    reimbursementDisbursementReference:
      row.reimbursement_disbursement_reference ?? null,
    reimbursementDisbursementMethod:
      row.reimbursement_disbursement_method ?? null,
    reimbursementDisbursedAmount: Number(
      row.reimbursement_disbursed_amount ?? 0,
    ).toFixed(2),
    reimbursementDisbursedByUserId:
      row.reimbursement_disbursed_by_user_id ?? null,
    reimbursementDisbursedAt: toIso(row.reimbursement_disbursed_at ?? null),
    reimbursementRejectedByUserId:
      row.reimbursement_rejected_by_user_id ?? null,
    reimbursementRejectedAt: toIso(row.reimbursement_rejected_at ?? null),
    reimbursementRejectionReason: row.reimbursement_rejection_reason ?? null,
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
  id, client_id, execution_scope_id, work_order_id, handyman_request_id,
  tenant_company_id, building_id, material_execution_line_id, source_item_id,
  item_name, uom_id, uom_code, funding_source, status,
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
  receipt_evidence_reference, receipt_sha256_checksum, latest_evidence_reference,
  reimbursement_payable_amount::text AS reimbursement_payable_amount,
  reimbursement_payee_user_id, reimbursement_status,
  reimbursement_finance_approval_reference,
  reimbursement_finance_approved_by_user_id,
  reimbursement_finance_approved_at,
  reimbursement_disbursement_reference,
  reimbursement_disbursement_method,
  reimbursement_disbursed_amount::text AS reimbursement_disbursed_amount,
  reimbursement_disbursed_by_user_id,
  reimbursement_disbursed_at,
  reimbursement_rejected_by_user_id,
  reimbursement_rejected_at,
  reimbursement_rejection_reason,
  tenant_charge_eligible,
  tenant_charge_eligible_qty::text AS tenant_charge_eligible_qty,
  tenant_invoiced, requested_by_user_id, approved_by_user_id,
  reconciled_by_user_id, reconciled_at, create_idempotency_key, version,
  created_at, updated_at
`;

export const handymanMaterialPurchasingRepository = {
  async findById(
    purchaseRecordId: string,
    executionScopeId: string,
    tx?: DbExecutor,
  ): Promise<HandymanMaterialPurchaseRecord | null> {
    const db = tx ?? getPool();
    const res = await db.query<PurchaseRow>(
      `SELECT ${PURCHASE_COLUMNS}
         FROM handyman_material_purchase_records
        WHERE id = $1 AND execution_scope_id = $2`,
      [purchaseRecordId, executionScopeId],
    );
    return res.rows[0] ? mapPurchaseRow(res.rows[0]) : null;
  },

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

  async findDuplicateReceiptOrInvoice(
    tx: DbExecutor,
    input: {
      clientId: string;
      excludeRecordId: string;
      receiptEvidenceReference: string;
      receiptSha256Checksum: string;
      supplierName: string;
      purchaseReference: string;
    },
  ): Promise<{
    id: string;
    executionScopeId: string;
    workOrderId: string | null;
    matchedBy: 'RECEIPT_REFERENCE' | 'RECEIPT_SHA256' | 'SUPPLIER_INVOICE';
  } | null> {
    const res = await tx.query<{
      id: string;
      execution_scope_id: string;
      work_order_id: string | null;
      receipt_evidence_reference: string | null;
      receipt_sha256_checksum: string | null;
    }>(
      `SELECT id,
              execution_scope_id,
              work_order_id,
              receipt_evidence_reference,
              receipt_sha256_checksum
         FROM handyman_material_purchase_records
        WHERE client_id = $1
          AND id <> $2
          AND (
            receipt_evidence_reference = $3
            OR receipt_sha256_checksum = $4
            OR (
              status NOT IN ('REQUEST', 'ISSUED')
              AND supplier_name IS NOT NULL
              AND purchase_reference IS NOT NULL
              AND lower(btrim(supplier_name)) = lower(btrim($5))
              AND lower(btrim(purchase_reference)) = lower(btrim($6))
            )
          )
        LIMIT 1`,
      [
        input.clientId,
        input.excludeRecordId,
        input.receiptEvidenceReference,
        input.receiptSha256Checksum,
        input.supplierName,
        input.purchaseReference,
      ],
    );
    const row = res.rows[0];
    if (!row) return null;
    const matchedBy =
      row.receipt_evidence_reference === input.receiptEvidenceReference
        ? 'RECEIPT_REFERENCE'
        : row.receipt_sha256_checksum === input.receiptSha256Checksum
          ? 'RECEIPT_SHA256'
          : 'SUPPLIER_INVOICE';
    return {
      id: row.id,
      executionScopeId: row.execution_scope_id,
      workOrderId: row.work_order_id ?? null,
      matchedBy,
    };
  },

  async findDuplicateDisbursementReference(
    tx: DbExecutor,
    input: {
      clientId: string;
      excludeRecordId: string;
      disbursementReference: string;
    },
  ): Promise<{ id: string; executionScopeId: string } | null> {
    const res = await tx.query<{ id: string; execution_scope_id: string }>(
      `SELECT id, execution_scope_id
         FROM handyman_material_purchase_records
        WHERE client_id = $1
          AND id <> $2
          AND reimbursement_disbursement_reference IS NOT NULL
          AND lower(btrim(reimbursement_disbursement_reference)) = lower(btrim($3))
        LIMIT 1`,
      [input.clientId, input.excludeRecordId, input.disbursementReference],
    );
    return res.rows[0]
      ? {
          id: res.rows[0].id,
          executionScopeId: res.rows[0].execution_scope_id,
        }
      : null;
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

  async listReimbursementsForFinanceActor(
    actorUserId: string,
    filters: {
      buildingId?: string;
      executionScopeId?: string;
      workOrderId?: string;
      reimbursementStatus?: HandymanMaterialReimbursementStatus;
      limit?: number;
    },
  ): Promise<HandymanMaterialPurchaseRecord[]> {
    const db = getPool();
    const conditions: string[] = [
      `m.funding_source = 'REIMBURSEMENT'`,
      `EXISTS (
        SELECT 1
          FROM user_building_assignments uba
          JOIN buildings b ON b.id = uba.building_id AND b.status = 'ACTIVE'
          JOIN properties p ON p.id = b.property_id AND p.status = 'ACTIVE'
          JOIN clients c ON c.id = p.client_id AND c.status = 'ACTIVE'
          JOIN users u ON u.id = uba.user_id AND u.status = 'ACTIVE'
         WHERE uba.user_id = $1
           AND uba.status = 'ACTIVE'
           AND b.id = m.building_id
           AND c.id = m.client_id
      )`,
    ];
    const params: unknown[] = [actorUserId];
    let idx = 2;

    if (filters.buildingId) {
      conditions.push(`m.building_id = $${idx++}`);
      params.push(filters.buildingId);
    }
    if (filters.executionScopeId) {
      conditions.push(`m.execution_scope_id = $${idx++}`);
      params.push(filters.executionScopeId);
    }
    if (filters.workOrderId) {
      conditions.push(`m.work_order_id = $${idx++}`);
      params.push(filters.workOrderId);
    }
    if (filters.reimbursementStatus) {
      conditions.push(`m.reimbursement_status = $${idx++}`);
      params.push(filters.reimbursementStatus);
    }

    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    params.push(limit);

    const scopedCols = PURCHASE_COLUMNS.trim()
      .split(',')
      .map((col) => {
        const trimmed = col.trim();
        return `m.${trimmed}`;
      })
      .join(',\n        ');

    const res = await db.query<PurchaseRow>(
      `SELECT
        ${scopedCols}
         FROM handyman_material_purchase_records m
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $${idx}`,
      params,
    );
    return res.rows.map(mapPurchaseRow);
  },

  async insertPurchaseRecord(
    tx: DbExecutor,
    input: {
      id: string;
      clientId: string;
      executionScopeId: string;
      workOrderId: string | null;
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
         id, client_id, execution_scope_id, work_order_id, handyman_request_id,
         tenant_company_id, building_id, material_execution_line_id,
         source_item_id, item_name, uom_id, uom_code, funding_source,
         status, requested_quantity, supplier_name, supplier_reference,
         currency, cash_advance_reference, latest_evidence_reference,
         requested_by_user_id, create_idempotency_key, version
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         'REQUEST', $14::numeric(14,3), $15, $16, $17, $18, $19, $20, $21, 1
       )
       RETURNING ${PURCHASE_COLUMNS}`,
      [
        input.id,
        input.clientId,
        input.executionScopeId,
        input.workOrderId,
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
      workOrderId?: string | null;
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
      receiptSha256Checksum?: string | null;
      reimbursementPayableAmount?: string;
      reimbursementPayeeUserId?: string | null;
      clearReimbursementPayee?: boolean;
      reimbursementStatus?: HandymanMaterialReimbursementStatus;
      reimbursementFinanceApprovalReference?: string | null;
      reimbursementFinanceApprovedByUserId?: string | null;
      reimbursementFinanceApprovedAt?: Date | null;
      reimbursementDisbursementReference?: string | null;
      reimbursementDisbursementMethod?: HandymanReimbursementDisbursementMethod | null;
      reimbursementDisbursedAmount?: string;
      reimbursementDisbursedByUserId?: string | null;
      reimbursementDisbursedAt?: Date | null;
      reimbursementRejectedByUserId?: string | null;
      reimbursementRejectedAt?: Date | null;
      reimbursementRejectionReason?: string | null;
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
              work_order_id = COALESCE($4, work_order_id),
              approved_quantity = COALESCE($5::numeric(14,3), approved_quantity),
              issued_quantity = COALESCE($6::numeric(14,3), issued_quantity),
              purchased_quantity = COALESCE($7::numeric(14,3), purchased_quantity),
              used_quantity = COALESCE($8::numeric(14,3), used_quantity),
              returned_quantity = COALESCE($9::numeric(14,3), returned_quantity),
              return_destination = COALESCE($10, return_destination),
              supplier_name = COALESCE($11, supplier_name),
              supplier_reference = COALESCE($12, supplier_reference),
              purchase_reference = COALESCE($13, purchase_reference),
              purchase_date = COALESCE($14, purchase_date),
              currency = COALESCE($15, currency),
              approved_max_unit_price = COALESCE($16::numeric(18,2), approved_max_unit_price),
              actual_unit_price = COALESCE($17::numeric(18,2), actual_unit_price),
              actual_total_expense_amount = COALESCE($18::numeric(18,2), actual_total_expense_amount),
              net_used_expense_amount = COALESCE($19::numeric(18,2), net_used_expense_amount),
              approval_reference = COALESCE($20, approval_reference),
              expenditure_reference = COALESCE($21, expenditure_reference),
              cash_advance_reference = COALESCE($22, cash_advance_reference),
              receipt_evidence_reference = COALESCE($23, receipt_evidence_reference),
              receipt_sha256_checksum = COALESCE($24, receipt_sha256_checksum),
              reimbursement_payable_amount = COALESCE($25::numeric(18,2), reimbursement_payable_amount),
              reimbursement_payee_user_id = CASE
                WHEN $26::boolean THEN NULL
                ELSE COALESCE($27::uuid, reimbursement_payee_user_id)
              END,
              reimbursement_status = COALESCE($28, reimbursement_status),
              reimbursement_finance_approval_reference = COALESCE($29, reimbursement_finance_approval_reference),
              reimbursement_finance_approved_by_user_id = COALESCE($30, reimbursement_finance_approved_by_user_id),
              reimbursement_finance_approved_at = COALESCE($31, reimbursement_finance_approved_at),
              reimbursement_disbursement_reference = COALESCE($32, reimbursement_disbursement_reference),
              reimbursement_disbursement_method = COALESCE($33, reimbursement_disbursement_method),
              reimbursement_disbursed_amount = COALESCE($34::numeric(18,2), reimbursement_disbursed_amount),
              reimbursement_disbursed_by_user_id = COALESCE($35, reimbursement_disbursed_by_user_id),
              reimbursement_disbursed_at = COALESCE($36, reimbursement_disbursed_at),
              reimbursement_rejected_by_user_id = COALESCE($37, reimbursement_rejected_by_user_id),
              reimbursement_rejected_at = COALESCE($38, reimbursement_rejected_at),
              reimbursement_rejection_reason = COALESCE($39, reimbursement_rejection_reason),
              tenant_charge_eligible = COALESCE($40, tenant_charge_eligible),
              tenant_charge_eligible_qty = COALESCE($41::numeric(14,3), tenant_charge_eligible_qty),
              approved_by_user_id = COALESCE($42, approved_by_user_id),
              reconciled_by_user_id = COALESCE($43, reconciled_by_user_id),
              reconciled_at = COALESCE($44, reconciled_at),
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${PURCHASE_COLUMNS}`,
      [
        input.purchaseRecordId,
        input.status,
        input.latestEvidenceReference,
        input.workOrderId ?? null,
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
        input.receiptSha256Checksum ?? null,
        input.reimbursementPayableAmount ?? null,
        Boolean(input.clearReimbursementPayee),
        input.reimbursementPayeeUserId ?? null,
        input.reimbursementStatus ?? null,
        input.reimbursementFinanceApprovalReference ?? null,
        input.reimbursementFinanceApprovedByUserId ?? null,
        input.reimbursementFinanceApprovedAt ?? null,
        input.reimbursementDisbursementReference ?? null,
        input.reimbursementDisbursementMethod ?? null,
        input.reimbursementDisbursedAmount ?? null,
        input.reimbursementDisbursedByUserId ?? null,
        input.reimbursementDisbursedAt ?? null,
        input.reimbursementRejectedByUserId ?? null,
        input.reimbursementRejectedAt ?? null,
        input.reimbursementRejectionReason ?? null,
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
    eventType: HandymanMaterialPurchaseEventType,
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
      eventType: HandymanMaterialPurchaseEventType;
      fromStatus: HandymanMaterialPurchaseStatus | null;
      toStatus: HandymanMaterialPurchaseStatus;
      actorUserId: string;
      actorRole: HandymanMaterialPurchaseActorRole;
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
         quantity_delta, evidence_reference, notes, idempotencyKey, metadata
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10::numeric(14,3), $11, $12, $13, $14::jsonb
       )
       RETURNING id, client_id, purchase_record_id, execution_scope_id, event_type,
                 from_status, to_status, actor_user_id, actor_role,
                 quantity_delta::text AS quantity_delta, evidence_reference,
                 notes, idempotency_key, metadata, occurred_at`.replace(
        'idempotencyKey',
        'idempotency_key',
      ),
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

  async listEventsByRecordIds(
    purchaseRecordIds: string[],
    tx?: DbExecutor,
  ): Promise<HandymanMaterialPurchaseEventRecord[]> {
    if (purchaseRecordIds.length === 0) return [];
    const db = tx ?? getPool();
    const res = await db.query<PurchaseEventRow>(
      `SELECT id, client_id, purchase_record_id, execution_scope_id, event_type,
              from_status, to_status, actor_user_id, actor_role,
              quantity_delta::text AS quantity_delta, evidence_reference,
              notes, idempotency_key, metadata, occurred_at
         FROM handyman_material_purchase_events
        WHERE purchase_record_id = ANY($1::uuid[])
        ORDER BY occurred_at ASC, id ASC`,
      [purchaseRecordIds],
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
