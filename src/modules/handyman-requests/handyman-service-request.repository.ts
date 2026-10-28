import { WORKSPACE_OCCUPANCY_CTES } from '../handyman-care-workspace/care-workspace-occupancies.repository';
import type { CareWorkspacePrincipal } from '../handyman-care-workspace/care-workspace.service';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanCustomerCareServiceRequestRecord,
  HandymanServiceRequestListFilters,
  HandymanServiceRequestRecord,
  NewHandymanServiceRequest,
} from './handyman-service-request.types';

/**
 * CR-HM-02 PART 03 — Handyman request repository (executor-first
 * convention, INSERT-once intake foundation; rows are never updated by this
 * PART). The channel_attribution_id UNIQUE constraint enforces one request
 * per immutable attribution.
 */

const REQUEST_SELECT = `
  id,
  client_id AS "clientId",
  channel_attribution_id AS "channelAttributionId",
  tenant_company_id AS "tenantCompanyId",
  tenant_pic_id AS "tenantPicId",
  building_id AS "buildingId",
  space_id AS "spaceId",
  service_catalog_id AS "serviceCatalogId",
  service_variant_id AS "serviceVariantId",
  origin_channel AS "originChannel",
  origin_reference AS "originReference",
  description,
  status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

/**
 * CR-HM-17 GAP PART 01 — Customer Care request read projection SELECT.
 * Joins the immutable `handyman_channel_attributions` row for Backend-resolved
 * attribution/care-actor provenance and left-joins `handyman_execution_scopes`
 * for the execution-scope pointer where present.
 */
const CUSTOMER_CARE_PROJECTION_SELECT = `
  r.id,
  r.client_id AS "clientId",
  r.channel_attribution_id AS "channelAttributionId",
  r.tenant_company_id AS "tenantCompanyId",
  r.tenant_pic_id AS "tenantPicId",
  r.building_id AS "buildingId",
  r.space_id AS "spaceId",
  r.service_catalog_id AS "serviceCatalogId",
  r.service_variant_id AS "serviceVariantId",
  ca.origin_channel AS "originChannel",
  ca.origin_reference AS "originReference",
  r.description,
  r.status,
  ca.created_by_user_id AS "createdByUserId",
  r.created_at AS "createdAt",
  r.updated_at AS "updatedAt",
  ca.actor_type AS "actorType",
  ca.care_actor_id AS "careActorId",
  ca.actor_reference AS "actorReference",
  ca.created_at AS "attributionCreatedAt",
  es.id AS "executionScopeId"
`;

const CUSTOMER_CARE_PROJECTION_FROM = `
  FROM handyman_service_requests r
  JOIN handyman_channel_attributions ca
    ON ca.id = r.channel_attribution_id
   AND ca.client_id = r.client_id
  LEFT JOIN handyman_execution_scopes es
    ON es.handyman_request_id = r.id
   AND es.client_id = r.client_id
   AND es.scope_kind = 'ORIGINAL'
`;

async function insertRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  request: NewHandymanServiceRequest,
): Promise<HandymanServiceRequestRecord> {
  const result = await executor.query<HandymanServiceRequestRecord>(
    `INSERT INTO handyman_service_requests
       (id, client_id, channel_attribution_id, tenant_company_id,
        tenant_pic_id, building_id, space_id, service_catalog_id,
        service_variant_id, origin_channel, origin_reference, description,
        status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'INTAKE', $13)
     RETURNING ${REQUEST_SELECT}`,
    [
      randomUUID(),
      request.clientId,
      request.channelAttributionId,
      request.tenantCompanyId,
      request.tenantPicId,
      request.buildingId,
      request.spaceId,
      request.serviceCatalogId,
      request.serviceVariantId,
      request.originChannel,
      request.originReference,
      request.description,
      request.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanServiceRequestRecord | null> {
  const result = await executor.query<HandymanServiceRequestRecord>(
    `SELECT ${REQUEST_SELECT} FROM handyman_service_requests WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByChannelAttribution(
  executor: Pick<PoolClient, 'query'> = getPool(),
  channelAttributionId: string,
): Promise<HandymanServiceRequestRecord | null> {
  const result = await executor.query<HandymanServiceRequestRecord>(
    `SELECT ${REQUEST_SELECT} FROM handyman_service_requests
      WHERE channel_attribution_id = $1`,
    [channelAttributionId],
  );
  return result.rows[0] ?? null;
}

/**
 * CR-HM-03 PART 01 — bounded F1 projection support. Row-level lock for the
 * atomic "lock request → append triage/journal → project bounded status"
 * transaction (one transition chain per request, ever).
 */
async function lockById(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanServiceRequestRecord | null> {
  const result = await executor.query<HandymanServiceRequestRecord>(
    `SELECT ${REQUEST_SELECT} FROM handyman_service_requests
      WHERE id = $1
      FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Bounded F1 projection: the ONLY status mutation pathway introduced for
 * the request row. It never touches any other column; business-context
 * snapshot columns are immutable from CR-HM-02 PART 03 onward.
 */
async function updateStatus(
  executor: Pick<PoolClient, 'query'>,
  id: string,
  status: HandymanServiceRequestRecord['status'],
): Promise<HandymanServiceRequestRecord | null> {
  const result = await executor.query<HandymanServiceRequestRecord>(
    `UPDATE handyman_service_requests
        SET status = $2,
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${REQUEST_SELECT}`,
    [id, status],
  );
  return result.rows[0] ?? null;
}

/**
 * C6 read wall, applied in SQL to both list and detail so filtering and the
 * returned projection observe the same database statement. A Building/Client
 * assignment alone is NOT customer authority. A linked ACTIVE PIC may read
 * only its represented tenant's requests while the tenant still has effective
 * building + (when selected) exact unit occupancy. Building-only requests
 * require effective occupancy somewhere in the represented building.
 *
 * The existing PLATFORM_ADMIN role is the explicit operational exception:
 * it may read historical requests, but only in its assigned Building and
 * with the route's tenant_company.read permission. No new role/permission.
 */
function customerRequestReadScope(actorParam: number): string {
  const actor = `$${actorParam}`;
  return `EXISTS (
    SELECT 1 FROM user_building_assignments uba
      JOIN buildings b ON b.id = uba.building_id AND b.status = 'ACTIVE'
      JOIN properties p ON p.id = b.property_id AND p.status = 'ACTIVE'
      JOIN clients c ON c.id = p.client_id AND c.status = 'ACTIVE'
      JOIN users u ON u.id = uba.user_id AND u.status = 'ACTIVE'
    WHERE uba.user_id = ${actor} AND uba.status = 'ACTIVE'
      AND b.id = r.building_id AND c.id = r.client_id
      AND (
        EXISTS (
          SELECT 1 FROM user_role_assignments ura
            JOIN roles role ON role.id = ura.role_id
          WHERE ura.user_id = ${actor} AND ura.status = 'ACTIVE'
            AND role.code = 'PLATFORM_ADMIN' AND role.status = 'ACTIVE'
        )
        OR (
          EXISTS (
            SELECT 1 FROM tenant_pics pic
              JOIN tenant_companies tc ON tc.id = pic.tenant_company_id
            WHERE pic.user_id = ${actor} AND pic.status = 'ACTIVE'
              AND tc.id = r.tenant_company_id AND tc.client_id = r.client_id
              AND tc.status = 'ACTIVE'
          )
          AND EXISTS (
            SELECT 1 FROM tenant_building_contexts tbc
            WHERE tbc.tenant_company_id = r.tenant_company_id
              AND tbc.building_id = r.building_id AND tbc.status = 'ACTIVE'
              AND (tbc.effective_from IS NULL OR tbc.effective_from <= statement_timestamp())
              AND (tbc.effective_until IS NULL OR tbc.effective_until >= statement_timestamp())
          )
          AND EXISTS (
            SELECT 1 FROM tenant_space_relationships tsr
            WHERE tsr.tenant_company_id = r.tenant_company_id
              AND tsr.building_id = r.building_id AND tsr.status = 'ACTIVE'
              AND (tsr.effective_from IS NULL OR tsr.effective_from <= statement_timestamp())
              AND (tsr.effective_until IS NULL OR tsr.effective_until >= statement_timestamp())
              AND (r.space_id IS NULL OR tsr.space_id = r.space_id)
          )
          AND (r.space_id IS NULL OR EXISTS (
            SELECT 1 FROM spaces s
              JOIN rooms room ON room.id = s.room_id
              JOIN areas a ON a.id = room.area_id
              JOIN floors f ON f.id = a.floor_id
            WHERE s.id = r.space_id AND f.building_id = r.building_id
          ))
        )
      )
  )`;
}

async function findCustomerCareProjectionById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
  actorUserId: string,
): Promise<HandymanCustomerCareServiceRequestRecord | null> {
  const result =
    await executor.query<HandymanCustomerCareServiceRequestRecord>(
      `SELECT ${CUSTOMER_CARE_PROJECTION_SELECT}
         ${CUSTOMER_CARE_PROJECTION_FROM}
        WHERE r.id = $1 AND ${customerRequestReadScope(2)}`,
      [id, actorUserId],
    );
  return result.rows[0] ?? null;
}

async function listCustomerCareProjectionsScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  filters: HandymanServiceRequestListFilters,
  actorUserId: string,
  page?: { limit: number; offset: number },
): Promise<HandymanCustomerCareServiceRequestRecord[]> {
  const conditions: string[] = ['r.client_id = $1'];
  const values: unknown[] = [filters.clientId];
  let idx = 2;

  if (filters.tenantCompanyId !== undefined) {
    conditions.push(`r.tenant_company_id = $${idx++}`);
    values.push(filters.tenantCompanyId);
  }
  if (filters.buildingId !== undefined) {
    conditions.push(`r.building_id = $${idx++}`);
    values.push(filters.buildingId);
  }
  if (filters.spaceId !== undefined) {
    conditions.push(`r.space_id = $${idx++}`);
    values.push(filters.spaceId);
  }
  if (filters.channelAttributionId !== undefined) {
    conditions.push(`r.channel_attribution_id = $${idx++}`);
    values.push(filters.channelAttributionId);
  }
  if (filters.status !== undefined) {
    conditions.push(`r.status = $${idx++}`);
    values.push(filters.status);
  }
  conditions.push(customerRequestReadScope(idx));
  values.push(actorUserId);

  let pageClause = '';
  if (page) {
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    values.push(page.limit, page.offset);
    pageClause = ` LIMIT $${limitParameter} OFFSET $${offsetParameter}`;
  }

  const result =
    await executor.query<HandymanCustomerCareServiceRequestRecord>(
      `SELECT ${CUSTOMER_CARE_PROJECTION_SELECT}
         ${CUSTOMER_CARE_PROJECTION_FROM}
        WHERE ${conditions.join(' AND ')}
        ORDER BY r.created_at ASC, r.id ASC${pageClause}`,
      values,
    );
  return result.rows;
}

export type WorkspaceRequestSelection = {
  propertyId: string; tenantCompanyId: string; buildingId: string; spaceId: string | null;
  status: HandymanServiceRequestListFilters['status'] | null;
  channelAttributionId: string | null;
  limit: number; afterId: string | null; afterCreatedAt: string | null;
};

type WorkspaceRequestRow = HandymanCustomerCareServiceRequestRecord & { cursorCreatedAt: string };
type JsonWorkspaceRequestRow = Omit<WorkspaceRequestRow, 'createdAt' | 'updatedAt' | 'attributionCreatedAt'> & {
  createdAt: string; updatedAt: string; attributionCreatedAt: string; items?: unknown[];
};

/** Metadata from the immutable issued document, never a derived settlement. */
export type CareFinalReceiptDiscovery = {
  status: 'ISSUED' | 'NOT_ISSUED';
  finalReceiptId: string | null;
  documentNumber: string | null;
  documentVersion: 1 | null;
  requestId: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  issuedAt: string | null;
  settledAt: string | null;
  currency: string | null;
  grossAmount: string | null;
  settledAmount: string | null;
  sourceSha256: string | null;
  pdfSha256: string | null;
};

/** Issued Payment Receipt metadata. Receipt amounts and invoice references
 * are historical document facts, not an assertion of invoice settlement. */
export type CarePaymentReceiptDiscovery = {
  receiptId: string; documentNumber: string | null; status: 'ISSUED';
  paymentId: string; requestId: string; executionScopeId: string; transactionId: string;
  amount: string; currency: string; obligationStage: 'DP' | 'TERMIN' | 'PELUNASAN';
  issuedAt: string; sourceAsOf: string;
  invoiceAtIssuance: { id: string; number: string; status: string; kind: 'OFFICIAL_HANDYMAN' | 'TENANT_INVOICE' } | null;
  linkedOfficialInvoice: { id: string; number: string; status: 'ISSUED'; linkedAt: string } | null;
  sourceSha256: string; pdfSha256: string; downloadPath: string;
};

/** Workspace read adapter, NOT the local User/PIC/admin read wall. Reuse the
 * exact existing request projection and current occupancy authority. Every row
 * must match the selected tenant/building AND its applicable current occupancy,
 * including when no space filter is provided. Authorization precedes keyset
 * pagination, in the same statement snapshot; no post-page redaction/counts. */
async function listWorkspaceProjectionsScoped(principal: CareWorkspacePrincipal, selection: WorkspaceRequestSelection) {
  const result = await getPool().query<{
    authenticated: boolean; accessible: boolean; evaluatedAt: Date; items: JsonWorkspaceRequestRow[];
  }>(`
    ${WORKSPACE_OCCUPANCY_CTES}, page AS (
      SELECT ${CUSTOMER_CARE_PROJECTION_SELECT},
        to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt"
      ${CUSTOMER_CARE_PROJECTION_FROM}
      WHERE EXISTS (
        SELECT 1 FROM records c WHERE c."clientId" = r.client_id
          AND c."tenantCompanyId" = r.tenant_company_id AND c."buildingId" = r.building_id
          AND c."spaceId" IS NOT DISTINCT FROM r.space_id
      )
        AND ($11::text IS NULL OR r.status = $11)
        AND ($12::uuid IS NULL OR r.channel_attribution_id = $12)
        AND ($5::uuid IS NULL OR (r.created_at, r.id) < ($10::timestamptz, $5::uuid))
      ORDER BY r.created_at DESC, r.id DESC LIMIT $6
    )
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,
      EXISTS(SELECT 1 FROM records) AS accessible,
      statement_timestamp() AS "evaluatedAt",
      COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page."createdAt" DESC, page.id DESC)
        FROM page), '[]'::jsonb) AS items`,
    [principal.sessionId, principal.careActorId, principal.integrationId, selection.propertyId,
      selection.afterId, selection.limit + 1, selection.tenantCompanyId, selection.buildingId,
      selection.spaceId, selection.afterCreatedAt, selection.status, selection.channelAttributionId]);
  const row = result.rows[0];
  // Existing public projector consumes the domain's Date-valued record. The
  // separate cursor key preserves PostgreSQL microseconds (JS Date cannot).
  return { ...row, items: row.items.map(item => ({ ...item,
    createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt),
    attributionCreatedAt: new Date(item.attributionCreatedAt),
  })) };
}

/** Detail and receipt discovery share one authorized statement snapshot. The
 * request ID is never authority. Examine every invoice/receipt connected by
 * request, invoice or execution scope, including inconsistent edges, before
 * returning any document ID. Do not read or recompute payment/ledger totals. */
async function findWorkspaceProjectionById(principal: CareWorkspacePrincipal, requestId: string,
  selection: Pick<WorkspaceRequestSelection, 'propertyId' | 'tenantCompanyId' | 'buildingId' | 'spaceId'>) {
  const result = await getPool().query<{
    authenticated: boolean; item: Omit<JsonWorkspaceRequestRow, 'cursorCreatedAt'> | null;
    finalReceipt: CareFinalReceiptDiscovery | null; receiptConflict: boolean;
    paymentReceipts: CarePaymentReceiptDiscovery[]; paymentReceiptConflict: boolean;
  }>(`
    ${WORKSPACE_OCCUPANCY_CTES}, matched AS (
      SELECT ${CUSTOMER_CARE_PROJECTION_SELECT}
      ${CUSTOMER_CARE_PROJECTION_FROM}
      WHERE r.id = $5 AND EXISTS (
        SELECT 1 FROM records c WHERE c."clientId" = r.client_id
          AND c."tenantCompanyId" = r.tenant_company_id AND c."buildingId" = r.building_id
          AND c."spaceId" IS NOT DISTINCT FROM r.space_id
      ) LIMIT $6
    ), candidate_invoices AS (
      SELECT i.id, i.document_number, i.execution_scope_id, i.transaction_id, i.classification_id,
        i.client_id, i.building_id, i.request_id, i.tenant_company_id,
        i.currency, i.total_amount, i.source_sha256, i.pdf_sha256,
        (i.request_id = m.id AND i.client_id = m."clientId"
          AND i.building_id = m."buildingId" AND i.tenant_company_id = m."tenantCompanyId"
          AND s.handyman_request_id = m.id AND s.client_id = m."clientId"
          AND s.building_id = m."buildingId" AND s.tenant_company_id = m."tenantCompanyId"
          AND s.space_id IS NOT DISTINCT FROM m."spaceId"
          AND s.tenant_pic_id IS NOT DISTINCT FROM m."tenantPicId"
          AND s.channel_attribution_id = m."channelAttributionId" AND s.scope_kind = 'ORIGINAL'
          AND t.execution_scope_id = s.id AND t.client_id = m."clientId"
          AND t.quotation_version_id = s.approved_quotation_version_id AND t.currency = i.currency
          AND claim.official_invoice_id = i.id
          AND i.source_snapshot->>'schema' = 'HANDYMAN_OFFICIAL_INVOICE_V1'
          AND i.source_snapshot->>'status' = 'ISSUED'
          AND i.source_snapshot#>>'{issuance,id}' = i.id::text
          AND i.source_snapshot#>>'{issuance,number}' = i.document_number
          AND i.source_snapshot#>>'{calculation,clientId}' = i.client_id::text
          AND i.source_snapshot#>>'{calculation,requestId}' = i.request_id::text
          AND i.source_snapshot#>>'{calculation,commercialSource,buildingId}' = i.building_id::text
          AND i.source_snapshot#>>'{calculation,commercialSource,tenantCompanyId}' = i.tenant_company_id::text
          AND i.source_snapshot#>>'{calculation,commercialSource,executionScopeId}' = i.execution_scope_id::text
          AND i.source_snapshot#>>'{calculation,commercialSource,transactionId}' = i.transaction_id::text
          AND i.source_snapshot#>>'{calculation,classification,pin,classificationId}' = i.classification_id::text
          AND i.source_snapshot#>>'{calculation,currency}' = i.currency
          AND i.source_snapshot#>>'{calculation,totalIncludingPpn}' = i.total_amount::text) IS TRUE AS valid
      FROM matched m
      JOIN handyman_official_invoices i ON i.request_id = m.id OR i.execution_scope_id IN (
        SELECT id FROM handyman_execution_scopes WHERE handyman_request_id = m.id
      )
      LEFT JOIN handyman_execution_scopes s ON s.id = i.execution_scope_id
      LEFT JOIN handyman_customer_transactions t ON t.id = i.transaction_id
      LEFT JOIN handyman_invoice_scope_claims claim ON claim.execution_scope_id = i.execution_scope_id
    ), candidate_receipts AS (
      SELECT f.id, f.document_number, f.invoice_id, f.issued_at, f.settled_at,
        f.currency, f.invoice_total, f.settled_total, f.source_sha256, f.pdf_sha256,
        i.document_number AS invoice_number,
        (i.valid AND f.status = 'ISSUED' AND f.request_id = m.id
          AND f.client_id = m."clientId" AND f.building_id = m."buildingId"
          AND f.tenant_company_id = m."tenantCompanyId"
          AND f.invoice_id = i.id AND f.transaction_id = i.transaction_id
          AND f.execution_scope_id = i.execution_scope_id AND f.currency = i.currency
          AND f.invoice_total = i.total_amount AND f.settled_total = f.invoice_total AND f.remaining_amount = 0
          AND f.source_snapshot->>'schema' = 'HANDYMAN_FINAL_RECEIPT_V1'
          AND f.source_snapshot->>'status' = 'ISSUED'
          AND f.source_snapshot#>>'{issuance,id}' = f.id::text
          AND f.source_snapshot#>>'{issuance,number}' = f.document_number
          AND f.source_snapshot#>>'{issuance,issuedAt}' = to_char(f.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          AND f.source_snapshot#>>'{invoice,id}' = i.id::text
          AND f.source_snapshot#>>'{invoice,number}' = i.document_number
          AND f.source_snapshot#>>'{invoice,classificationId}' = i.classification_id::text
          AND f.source_snapshot#>>'{invoice,sourceSha256}' = i.source_sha256
          AND f.source_snapshot#>>'{invoice,pdfSha256}' = i.pdf_sha256
          AND f.source_snapshot#>>'{scope,clientId}' = f.client_id::text
          AND f.source_snapshot#>>'{scope,buildingId}' = f.building_id::text
          AND f.source_snapshot#>>'{scope,tenantCompanyId}' = f.tenant_company_id::text
          AND f.source_snapshot#>>'{scope,requestId}' = f.request_id::text
          AND f.source_snapshot#>>'{scope,executionScopeId}' = f.execution_scope_id::text
          AND f.source_snapshot#>>'{scope,transactionId}' = f.transaction_id::text
          AND f.source_snapshot#>>'{settlement,settledAt}' = to_char(f.settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          AND f.source_snapshot#>>'{settlement,currency}' = f.currency
          AND f.source_snapshot#>>'{settlement,invoiceTotal}' = f.invoice_total::text
          AND f.source_snapshot#>>'{settlement,totalSettled}' = f.settled_total::text
          AND f.source_snapshot#>>'{settlement,remaining}' = f.remaining_amount::text) IS TRUE AS valid
      FROM matched m
      JOIN handyman_final_receipts f ON f.request_id = m.id
        OR f.invoice_id IN (SELECT id FROM candidate_invoices)
        OR f.execution_scope_id IN (SELECT id FROM handyman_execution_scopes WHERE handyman_request_id = m.id)
      LEFT JOIN candidate_invoices i ON i.id = f.invoice_id
    ), payment_receipt_candidates AS (
      -- Include inconsistent edges as candidates too: filtering them out would
      -- falsely turn conflicting lineage into a successful empty list. The
      -- only public output comes after the request's matched authority above.
      SELECT pr.id, pr.client_id, pr.document_number, pr.payment_id, pr.request_id, pr.execution_scope_id, pr.transaction_id,
        pr.issued_at, pr.source_as_of, pr.source_sha256, pr.pdf_sha256,
        p.amount, p.currency, p.obligation_stage,
        pr.source_snapshot#>'{reference,invoice}' AS invoice_at_issuance,
        CASE WHEN legacy_invoice.id IS NOT NULL THEN 'TENANT_INVOICE'
          WHEN snapshot_invoice.id IS NOT NULL THEN 'OFFICIAL_HANDYMAN' END AS invoice_kind,
        linked_invoice.id AS linked_invoice_id, linked_invoice.document_number AS linked_invoice_number,
        invoice_link.linked_at,
        (pr.request_id = m.id AND pr.client_id = m."clientId"
          AND pr.building_id = m."buildingId" AND pr.tenant_company_id = m."tenantCompanyId"
          AND s.id = pr.execution_scope_id AND s.handyman_request_id = m.id
          AND s.client_id = m."clientId" AND s.building_id = m."buildingId"
          AND s.tenant_company_id = m."tenantCompanyId" AND s.space_id IS NOT DISTINCT FROM m."spaceId"
          AND s.tenant_pic_id IS NOT DISTINCT FROM m."tenantPicId"
          AND s.channel_attribution_id = m."channelAttributionId" AND s.scope_kind = 'ORIGINAL'
          AND t.id = pr.transaction_id AND t.execution_scope_id = s.id AND t.client_id = m."clientId"
          AND t.quotation_version_id = s.approved_quotation_version_id
          AND p.id = pr.payment_id AND p.transaction_id = t.id AND p.client_id = m."clientId"
          AND p.currency = t.currency AND p.status = 'CONFIRMED'
          AND p.decided_at IS NOT NULL AND p.decided_by_user_id IS NOT NULL
          AND rec.payment_id = p.id AND rec.transaction_id = t.id AND rec.client_id = m."clientId"
          AND rec.event_type = 'RECORD_PAYMENT' AND rec.actor_user_id = p.recorded_by_user_id
          AND conf.payment_id = p.id AND conf.transaction_id = t.id AND conf.client_id = m."clientId"
          AND conf.event_type = 'CONFIRM_PAYMENT' AND conf.actor_user_id = p.decided_by_user_id
          AND (SELECT count(*) FROM handyman_customer_payment_events e
               WHERE e.payment_id = p.id AND e.event_type = 'RECORD_PAYMENT') = 1
          AND (SELECT count(*) FROM handyman_customer_payment_events e
               WHERE e.payment_id = p.id AND e.event_type = 'CONFIRM_PAYMENT') = 1
          AND pr.source_snapshot->>'schema' = 'HANDYMAN_TENANT_PAYMENT_RECEIPT_V1'
          AND pr.source_snapshot->>'status' = 'ISSUED'
          AND pr.source_snapshot->>'clientId' = pr.client_id::text
          AND pr.source_snapshot#>>'{building,id}' = pr.building_id::text
          AND pr.source_snapshot#>>'{payer,tenantCompanyId}' = pr.tenant_company_id::text
          AND pr.source_snapshot#>>'{payer,basis}' = 'EXECUTION_SCOPE_CUSTOMER'
          AND pr.source_snapshot#>>'{payer,remitterIdentity}' = 'NOT_VERIFIED'
          AND pr.source_snapshot#>>'{reference,requestId}' = pr.request_id::text
          AND pr.source_snapshot#>>'{reference,executionScopeId}' = s.id::text
          AND pr.source_snapshot#>>'{reference,transactionId}' = t.id::text
          AND pr.source_snapshot#>>'{reference,quotationVersionId}' = t.quotation_version_id::text
          AND pr.source_snapshot#>>'{reference,spaceId}' IS NOT DISTINCT FROM s.space_id::text
          AND pr.source_snapshot#>>'{issuance,id}' = pr.id::text
          -- Legacy artifacts have no assigned number. Numbered artifacts must
          -- retain the exact approved settings, policy and Jakarta issuance year.
          AND ((pr.document_number IS NULL AND pr.numbering_approval_id IS NULL)
            OR (pr.document_number ~ '^HM-PR-[0-9]{4}-[0-9]{6}$'
              AND substring(pr.document_number, 12, 6) <> '000000'
              AND substring(pr.document_number, 7, 4) = to_char(pr.issued_at AT TIME ZONE 'Asia/Jakarta', 'YYYY')
              AND pr.source_snapshot#>>'{issuance,number}' = pr.document_number
              AND EXISTS (SELECT 1 FROM handyman_payment_receipt_numbering_approvals a
                JOIN handyman_document_issuer_document_settings ds ON ds.id = a.settings_id
                WHERE a.id = pr.numbering_approval_id AND a.client_id = pr.client_id
                  AND a.policy_code = 'HM_PR_ISSUER_YEAR_V1' AND ds.client_id = a.client_id
                  AND ds.document_kind = 'PAYMENT_RECEIPT' AND ds.document_prefix = 'HM-PR'
                  AND ds.version = a.settings_version
                  AND pr.source_snapshot#>>'{numberingPolicy,approvalId}' = a.id::text
                  AND pr.source_snapshot#>>'{numberingPolicy,settingsId}' = ds.id::text
                  AND pr.source_snapshot#>>'{numberingPolicy,settingsVersion}' = ds.version::text
                  AND pr.source_snapshot#>>'{numberingPolicy,language}' = ds.language
                  AND pr.source_snapshot#>>'{numberingPolicy,policyCode}' = a.policy_code
                  AND pr.source_snapshot#>>'{numberingPolicy,format}' = 'HM-PR-{YYYY}-{SEQ:06}'
                  AND pr.source_snapshot#>>'{numberingPolicy,timeZone}' = 'Asia/Jakarta'
                  AND pr.source_snapshot#>>'{numberingPolicy,scope}' = 'ISSUER_CLIENT_CALENDAR_YEAR'
                  AND pr.source_snapshot#>>'{numberingPolicy,calendarYear}' = hm_pr_calendar_year(pr.issued_at)::text)))
          AND pr.source_snapshot#>>'{issuance,issuedByUserId}' = pr.issued_by_user_id::text
          AND pr.source_snapshot#>>'{issuer,profileId}' = pr.issuer_profile_id::text
          AND pr.source_snapshot#>>'{issuance,issuedAt}' = to_char(pr.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          AND pr.source_snapshot->>'asOf' = to_char(pr.source_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          AND pr.source_snapshot#>>'{payment,id}' = p.id::text
          AND pr.source_snapshot#>>'{payment,amount}' = p.amount::text
          AND pr.source_snapshot#>>'{payment,currency}' = p.currency
          AND pr.source_snapshot#>>'{payment,obligationStage}' = p.obligation_stage
          AND pr.source_snapshot#>>'{payment,channel}' = p.channel
          AND pr.source_snapshot#>>'{payment,recordedByUserId}' = p.recorded_by_user_id::text
          AND pr.source_snapshot#>>'{payment,recordEventId}' = rec.id::text
          AND pr.source_snapshot#>>'{payment,recordedAt}' = to_char(p.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          AND pr.source_snapshot#>>'{payment,recordEventOccurredAt}' = to_char(rec.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          AND pr.source_snapshot#>>'{verification,confirmationEventId}' = conf.id::text
          AND pr.source_snapshot#>>'{verification,confirmedByUserId}' = p.decided_by_user_id::text
          AND pr.source_snapshot#>>'{verification,confirmedAt}' = to_char(p.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          AND pr.source_snapshot#>>'{verification,confirmationEventOccurredAt}' = to_char(conf.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          AND CASE jsonb_typeof(pr.source_snapshot#>'{verification,reconciliation}')
            WHEN 'null' THEN TRUE
            WHEN 'object' THEN reconciliation.id::text = pr.source_snapshot#>>'{verification,reconciliation,id}'
              AND reconciliation.client_id = m."clientId"
              AND reconciliation.verified_by_user_id::text = pr.source_snapshot#>>'{verification,reconciliation,verifiedByUserId}'
              AND reconciliation.bank_reference = pr.source_snapshot#>>'{verification,reconciliation,bankReference}'
              AND to_char(reconciliation.actual_received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = pr.source_snapshot#>>'{verification,reconciliation,actualReceivedAt}'
              AND to_char(reconciliation.verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = pr.source_snapshot#>>'{verification,reconciliation,verifiedAt}'
            ELSE FALSE END
          AND ((pr.source_snapshot#>>'{verification,basis}' = 'INDEPENDENT_CONFIRMATION'
                AND p.decided_by_user_id <> p.recorded_by_user_id)
            OR (pr.source_snapshot#>>'{verification,basis}' = 'INDEPENDENT_RECONCILIATION'
                AND p.decided_by_user_id = p.recorded_by_user_id
                AND reconciliation.id::text = pr.source_snapshot#>>'{verification,reconciliation,id}'
                AND reconciliation.client_id = m."clientId" AND reconciliation.verified_by_user_id <> p.recorded_by_user_id))
          -- Issuance snapshots may precede later allocations; validate every
          -- pinned allocation, but never demand today's set equal the as-of set.
          AND jsonb_typeof(pr.source_snapshot->'allocations') = 'array'
          AND jsonb_typeof(pr.source_snapshot->'corrections') = 'array'
          AND (SELECT count(*) = count(DISTINCT a->>'id') FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(pr.source_snapshot->'allocations') = 'array'
              THEN pr.source_snapshot->'allocations' ELSE '[]'::jsonb END) a)
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(pr.source_snapshot->'allocations') = 'array'
              THEN pr.source_snapshot->'allocations' ELSE '[]'::jsonb END) a
            WHERE NOT EXISTS (SELECT 1 FROM handyman_payment_allocations pa
              JOIN handyman_charge_lines cl ON cl.id = pa.charge_line_id AND cl.transaction_id = pa.transaction_id
              WHERE pa.id::text = a->>'id' AND pa.payment_id = p.id AND pa.transaction_id = t.id
                AND pa.client_id = m."clientId" AND cl.client_id = m."clientId"
                AND pa.charge_line_id::text = a->>'chargeLineId' AND pa.line_kind = a->>'lineKind'
                AND pa.line_kind = cl.line_kind AND pa.currency = a->>'currency' AND pa.currency = p.currency
                AND pa.amount::text = a->>'amount' AND pa.allocated_by_user_id::text = a->>'allocatedByUserId'
                AND to_char(pa.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = a->>'occurredAt'))
          -- An explicit official link may be created after a pre-invoice
          -- receipt. It is distinct from what was printed at issuance.
          AND (invoice_link.payment_id IS NULL OR (linked_invoice.valid
            AND linked_invoice.transaction_id = t.id AND linked_invoice.execution_scope_id = s.id
            AND linked_invoice.currency = p.currency))
          AND CASE jsonb_typeof(pr.source_snapshot#>'{reference,invoice}')
            WHEN 'null' THEN TRUE
            WHEN 'object' THEN (
              (legacy_invoice.id IS NOT NULL AND snapshot_invoice.id IS NULL AND invoice_link.payment_id IS NULL
                AND legacy_invoice.client_id = m."clientId" AND legacy_invoice.building_id = m."buildingId"
                AND legacy_invoice.tenant_company_id = m."tenantCompanyId" AND legacy_invoice.handyman_execution_scope_id = s.id
                AND legacy_invoice.space_id IS NOT DISTINCT FROM m."spaceId" AND legacy_invoice.currency_code = p.currency
                AND legacy_invoice.invoice_number = pr.source_snapshot#>>'{reference,invoice,number}'
                AND pr.source_snapshot#>>'{reference,invoice,status}' IN ('DRAFT', 'FINALIZED', 'CANCELLED'))
              OR (legacy_invoice.id IS NULL AND snapshot_invoice.valid AND invoice_link.invoice_id = snapshot_invoice.id
                AND snapshot_invoice.transaction_id = t.id AND snapshot_invoice.execution_scope_id = s.id
                AND snapshot_invoice.document_number = pr.source_snapshot#>>'{reference,invoice,number}'
                AND pr.source_snapshot#>>'{reference,invoice,status}' = 'ISSUED'))
            ELSE FALSE END) IS TRUE AS valid
      FROM matched m
      JOIN handyman_tenant_payment_receipts pr ON pr.request_id = m.id
        OR pr.execution_scope_id IN (SELECT id FROM handyman_execution_scopes WHERE handyman_request_id = m.id)
        OR pr.transaction_id IN (SELECT t.id FROM handyman_customer_transactions t
          JOIN handyman_execution_scopes s ON s.id = t.execution_scope_id WHERE s.handyman_request_id = m.id)
        OR pr.payment_id IN (SELECT p.id FROM handyman_customer_payments p
          JOIN handyman_customer_transactions t ON t.id = p.transaction_id
          JOIN handyman_execution_scopes s ON s.id = t.execution_scope_id WHERE s.handyman_request_id = m.id)
      LEFT JOIN handyman_execution_scopes s ON s.id = pr.execution_scope_id
      LEFT JOIN handyman_customer_transactions t ON t.id = pr.transaction_id
      LEFT JOIN handyman_customer_payments p ON p.id = pr.payment_id
      LEFT JOIN handyman_customer_payment_events rec ON rec.id = pr.record_event_id
      LEFT JOIN handyman_customer_payment_events conf ON conf.id = pr.confirmation_event_id
      LEFT JOIN handyman_payment_reconciliations reconciliation ON reconciliation.payment_id = pr.payment_id
      LEFT JOIN handyman_official_invoice_payment_links invoice_link ON invoice_link.payment_id = pr.payment_id
      LEFT JOIN candidate_invoices linked_invoice ON linked_invoice.id = invoice_link.invoice_id
      LEFT JOIN candidate_invoices snapshot_invoice ON snapshot_invoice.id::text = pr.source_snapshot#>>'{reference,invoice,id}'
      LEFT JOIN tenant_invoices legacy_invoice ON legacy_invoice.id::text = pr.source_snapshot#>>'{reference,invoice,id}'
    ), discovery_state AS (
      SELECT (EXISTS (SELECT 1 FROM candidate_invoices WHERE NOT valid)
        OR EXISTS (SELECT 1 FROM candidate_receipts WHERE NOT valid)
        OR (SELECT count(*) FROM candidate_receipts) > 1) AS conflict,
        (SELECT count(*) FROM candidate_receipts) AS receipt_count,
        (SELECT count(*) FROM candidate_invoices) AS invoice_count
    )
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,
      (SELECT to_jsonb(matched) || jsonb_build_object('items', COALESCE((
        SELECT jsonb_agg(to_jsonb(ri) ORDER BY ri."createdAt", ri.id)
          FROM (
            SELECT id, client_id AS "clientId", handyman_request_id AS "handymanRequestId",
              service_catalog_id AS "serviceCatalogId", service_variant_id AS "serviceVariantId",
              quantity::float8 AS quantity, attribute_values AS "attributeValues",
              inherited_attribute_values AS "inheritedAttributeValues",
              access_condition AS "accessCondition", uom_id AS "uomId",
              item_description AS "itemDescription", status,
              created_by_user_id AS "createdByUserId", created_at AS "createdAt",
              updated_at AS "updatedAt"
              FROM handyman_service_request_items
             WHERE handyman_request_id = matched.id AND client_id = matched."clientId"
               AND status = 'ACTIVE'
          ) ri), '[]'::jsonb)) FROM matched) AS item,
      (SELECT conflict FROM discovery_state) AS "receiptConflict",
      (SELECT CASE WHEN d.conflict THEN NULL
        WHEN d.receipt_count = 1 THEN (SELECT jsonb_build_object(
          'status', 'ISSUED', 'finalReceiptId', f.id, 'documentNumber', f.document_number,
          'documentVersion', 1, 'requestId', m.id, 'invoiceId', f.invoice_id,
          'invoiceNumber', f.invoice_number,
          'issuedAt', to_char(f.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'settledAt', to_char(f.settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'currency', f.currency, 'grossAmount', f.invoice_total::text, 'settledAmount', f.settled_total::text,
          'sourceSha256', f.source_sha256, 'pdfSha256', f.pdf_sha256) FROM candidate_receipts f)
        ELSE jsonb_build_object(
          'status', 'NOT_ISSUED', 'finalReceiptId', NULL, 'documentNumber', NULL,
          'documentVersion', NULL, 'requestId', m.id,
          'invoiceId', CASE WHEN d.invoice_count = 1 THEN (SELECT id FROM candidate_invoices) ELSE NULL END,
          'invoiceNumber', CASE WHEN d.invoice_count = 1 THEN (SELECT document_number FROM candidate_invoices) ELSE NULL END,
          'issuedAt', NULL, 'settledAt', NULL, 'currency', NULL, 'grossAmount', NULL,
          'settledAmount', NULL, 'sourceSha256', NULL, 'pdfSha256', NULL)
        END FROM matched m CROSS JOIN discovery_state d) AS "finalReceipt",
      (EXISTS (SELECT 1 FROM payment_receipt_candidates WHERE NOT valid)
        OR EXISTS (SELECT 1 FROM payment_receipt_candidates GROUP BY payment_id HAVING count(*) > 1)
        OR EXISTS (SELECT 1 FROM payment_receipt_candidates candidate
          JOIN handyman_tenant_payment_receipts duplicate ON duplicate.client_id = candidate.client_id
            AND duplicate.document_number = candidate.document_number AND duplicate.id <> candidate.id
          WHERE candidate.document_number IS NOT NULL)) AS "paymentReceiptConflict",
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'receiptId', pr.id, 'documentNumber', pr.document_number, 'status', 'ISSUED',
        'paymentId', pr.payment_id, 'requestId', pr.request_id, 'executionScopeId', pr.execution_scope_id,
        'transactionId', pr.transaction_id, 'amount', pr.amount::text, 'currency', pr.currency,
        'obligationStage', pr.obligation_stage,
        'issuedAt', to_char(pr.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'sourceAsOf', to_char(pr.source_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'invoiceAtIssuance', CASE WHEN jsonb_typeof(pr.invoice_at_issuance) = 'object'
          THEN pr.invoice_at_issuance || jsonb_build_object('kind', pr.invoice_kind) ELSE NULL END,
        'linkedOfficialInvoice', CASE WHEN pr.linked_invoice_id IS NOT NULL THEN jsonb_build_object(
          'id', pr.linked_invoice_id, 'number', pr.linked_invoice_number, 'status', 'ISSUED',
          'linkedAt', to_char(pr.linked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ELSE NULL END,
        'sourceSha256', pr.source_sha256, 'pdfSha256', pr.pdf_sha256,
        'downloadPath', '/api/v1/handyman/care/requests/' || pr.request_id::text || '/payments/' || pr.payment_id::text || '/receipt.pdf'
        ) ORDER BY pr.issued_at, pr.id) FROM payment_receipt_candidates pr WHERE pr.valid), '[]'::jsonb) AS "paymentReceipts"`,
    [principal.sessionId, principal.careActorId, principal.integrationId, selection.propertyId,
      requestId, 1, selection.tenantCompanyId, selection.buildingId, selection.spaceId]);
  const { authenticated, item, finalReceipt, receiptConflict, paymentReceipts, paymentReceiptConflict } = result.rows[0];
  return { authenticated, receiptConflict, finalReceipt, paymentReceipts, paymentReceiptConflict, item: item ? { ...item,
    createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt),
    attributionCreatedAt: new Date(item.attributionCreatedAt),
  } : null };
}

export const handymanServiceRequestRepository = {
  insertRequest,
  findById,
  findByChannelAttribution,
  lockById,
  updateStatus,
  findCustomerCareProjectionById,
  listCustomerCareProjectionsScoped,
  listWorkspaceProjectionsScoped,
  findWorkspaceProjectionById,
};
