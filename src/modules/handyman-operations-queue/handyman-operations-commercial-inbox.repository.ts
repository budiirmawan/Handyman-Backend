import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanCommercialInboxCounts,
  HandymanCommercialInboxItem,
  HandymanCommercialInboxRecordType,
  HandymanCommercialInboxResponsiblePersona,
  HandymanCommercialInboxQuery,
} from './handyman-operations-commercial-inbox.types';
import {
  HANDYMAN_COMMERCIAL_INBOX_MATERIAL_STATUSES,
  HANDYMAN_COMMERCIAL_INBOX_VARIATION_STATUSES,
} from './handyman-operations-commercial-inbox.types';

/**
 * CR-HM-OPS-INBOX-BE-01 P0-B/P1 — authoritative commercial discovery query.
 *
 * ONE statement per page over the EXISTING commercial tables, so:
 *  - authorization precedes exposure: the same BE-02G Operations wall used by
 *    the Operations queue (explicit ACTIVE Building assignment on the row's
 *    exact Building under the row's Client) is part of the statement;
 *  - the historical requests stay discoverable: filtering is on the commercial
 *    record's own lifecycle, never on the request's recency;
 *  - every eligible execution scope of a request is discovered — the records
 *    carry their own `execution_scope_id`, so older scopes are included;
 *  - keyset (cursor) pagination on the deterministic key
 *    `(created_at DESC, record_type DESC, record_id DESC)` gives stable,
 *    duplicate-free continuation; row identity is the authoritative record id
 *    and no one-to-many join exists anywhere in the projection.
 *
 * Additions during pagination: a newly inserted record has a newer
 * `created_at` and therefore sorts BEFORE the outstanding cursor; a
 * continuation walk never rescans that part of the key order, so additions
 * surface on a fresh first page and can never duplicate or shift rows inside
 * an in-flight continuation.
 */

type InboxRow = {
  recordId: string;
  recordType: HandymanCommercialInboxRecordType;
  recordStatus: string;
  commercialKind: string;
  executionScopeId: string;
  handymanRequestId: string;
  clientId: string;
  buildingId: string;
  tenantCompanyId: string;
  title: string;
  responsiblePersona: HandymanCommercialInboxResponsiblePersona;
  responsibleAction: string;
  reconciliationException: boolean;
  sourceReference: string;
  revisedQuotationVersionId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Same Operations wall as the queue: ACTIVE assignment of the actor to the
 * row's exact Building under the row's Client. No PIC/occupancy/role branch. */
function operationsBuildingReadScope(alias: string, actorParam: number): string {
  const actor = `$${actorParam}`;
  return `EXISTS (
    SELECT 1 FROM user_building_assignments uba
      JOIN buildings b ON b.id = uba.building_id AND b.status = 'ACTIVE'
      JOIN properties p ON p.id = b.property_id AND p.status = 'ACTIVE'
      JOIN clients c ON c.id = p.client_id AND c.status = 'ACTIVE'
      JOIN users u ON u.id = uba.user_id AND u.status = 'ACTIVE'
    WHERE uba.user_id = ${actor} AND uba.status = 'ACTIVE'
      AND b.id = ${alias}.building_id AND c.id = ${alias}.client_id
  )`;
}

const VARIATION_RESPONSIBLE_SQL = `
  CASE v.status
    WHEN 'FIELD_FINDING' THEN v.origin_actor_role
    WHEN 'PROPOSAL' THEN 'OPERATIONS_MANAGER'
    WHEN 'OPERATIONS_REVIEW' THEN 'OPERATIONS_MANAGER'
    WHEN 'REVISED_QUOTATION' THEN 'TENANT'
    WHEN 'TENANT_DECISION' THEN
      CASE WHEN v.tenant_decision_outcome = 'APPROVED'
        THEN 'OPERATIONS_MANAGER' ELSE 'TENANT' END
    WHEN 'AUTHORIZED_SCOPE' THEN 'OPERATIONS_MANAGER'
  END`;

const VARIATION_ACTION_SQL = `
  CASE v.status
    WHEN 'FIELD_FINDING' THEN 'PROPOSAL'
    WHEN 'PROPOSAL' THEN 'OPERATIONS_REVIEW'
    WHEN 'OPERATIONS_REVIEW' THEN 'REVISED_QUOTATION'
    WHEN 'REVISED_QUOTATION' THEN 'TENANT_DECISION'
    WHEN 'TENANT_DECISION' THEN
      CASE WHEN v.tenant_decision_outcome = 'APPROVED'
        THEN 'AUTHORIZED_SCOPE' ELSE 'TENANT_DECISION' END
    WHEN 'AUTHORIZED_SCOPE' THEN 'EXECUTION'
  END`;

const MATERIAL_RESPONSIBLE_SQL = `
  CASE m.status
    WHEN 'REQUEST' THEN 'OPERATIONS_MANAGER'
    WHEN 'ISSUED' THEN 'PIC_PEKERJAAN'
    WHEN 'PURCHASED' THEN 'PIC_PEKERJAAN'
    WHEN 'USAGE' THEN 'OPERATIONS_MANAGER'
    WHEN 'RETURN' THEN 'OPERATIONS_MANAGER'
  END`;

const MATERIAL_ACTION_SQL = `
  CASE m.status
    WHEN 'REQUEST' THEN 'APPROVAL'
    WHEN 'ISSUED' THEN 'USAGE'
    WHEN 'PURCHASED' THEN 'USAGE'
    WHEN 'USAGE' THEN 'RECONCILIATION'
    WHEN 'RETURN' THEN 'RECONCILIATION'
  END`;

/**
 * Reconciliation exception: the exact facts the existing reconciliation
 * authority rejects (used > 0 AND used + returned = issued + purchased),
 * evaluated over the record's own authoritative quantity columns.
 */
const MATERIAL_RECONCILIATION_EXCEPTION_SQL = `
  (
    m.status IN ('USAGE', 'RETURN')
    AND (
      m.used_quantity <= 0
      OR ROUND(m.used_quantity + m.returned_quantity, 3)
         <> ROUND(m.issued_quantity + m.purchased_quantity, 3)
    )
  )`;

type SharedFilterBind = {
  clientId: string;
  buildingId?: string;
  tenantCompanyId?: string;
  createdFrom?: Date;
  createdTo?: Date;
  actorUserId: string;
};

/**
 * Shared filters bound ONCE for the whole statement: both UNION branches
 * embed the identical predicate list (same parameter indices, same values —
 * only the record alias differs), so the page/counts statements carry one
 * contiguous binding set.
 */
function sharedWhere(
  alias: string,
  shared: SharedFilterBind,
): { conditions: string[]; values: unknown[] } {
  const values: unknown[] = [shared.clientId];
  const conditions: string[] = [`${alias}.client_id = $1`];
  let idx = 2;
  if (shared.buildingId !== undefined) {
    conditions.push(`${alias}.building_id = $${idx++}`);
    values.push(shared.buildingId);
  }
  if (shared.tenantCompanyId !== undefined) {
    conditions.push(`${alias}.tenant_company_id = $${idx++}`);
    values.push(shared.tenantCompanyId);
  }
  if (shared.createdFrom !== undefined) {
    conditions.push(`${alias}.created_at >= $${idx++}`);
    values.push(shared.createdFrom);
  }
  if (shared.createdTo !== undefined) {
    conditions.push(`${alias}.created_at <= $${idx++}`);
    values.push(shared.createdTo);
  }
  conditions.push(operationsBuildingReadScope(alias, idx++));
  values.push(shared.actorUserId);
  return { conditions, values };
}

function variationBranch(conditions: string[]): string {
  const statusList = HANDYMAN_COMMERCIAL_INBOX_VARIATION_STATUSES
    .map((status) => `'${status}'`)
    .join(', ');
  return `
    SELECT v.id AS "recordId",
           'SCOPE_VARIATION' AS "recordType",
           v.status AS "recordStatus",
           v.variation_type AS "commercialKind",
           v.execution_scope_id AS "executionScopeId",
           v.handyman_request_id AS "handymanRequestId",
           v.client_id AS "clientId",
           v.building_id AS "buildingId",
           v.tenant_company_id AS "tenantCompanyId",
           v.title AS "title",
           ${VARIATION_RESPONSIBLE_SQL} AS "responsiblePersona",
           ${VARIATION_ACTION_SQL} AS "responsibleAction",
           FALSE AS "reconciliationException",
           v.latest_evidence_reference AS "sourceReference",
           v.revised_quotation_version_id AS "revisedQuotationVersionId",
           v.version AS "version",
           v.created_at AS "createdAt",
           v.updated_at AS "updatedAt"
      FROM handyman_scope_variations v
     WHERE ${[
       `v.status IN (${statusList})`,
       `NOT (v.status = 'TENANT_DECISION'
             AND v.tenant_decision_outcome = 'REJECTED')`,
       ...conditions,
     ].join('\n       AND ')}`;
}

function materialBranch(conditions: string[]): string {
  const statusList = HANDYMAN_COMMERCIAL_INBOX_MATERIAL_STATUSES
    .map((status) => `'${status}'`)
    .join(', ');
  return `
    SELECT m.id AS "recordId",
           'MATERIAL_PURCHASE' AS "recordType",
           m.status AS "recordStatus",
           m.funding_source AS "commercialKind",
           m.execution_scope_id AS "executionScopeId",
           m.handyman_request_id AS "handymanRequestId",
           m.client_id AS "clientId",
           m.building_id AS "buildingId",
           m.tenant_company_id AS "tenantCompanyId",
           m.item_name AS "title",
           ${MATERIAL_RESPONSIBLE_SQL} AS "responsiblePersona",
           ${MATERIAL_ACTION_SQL} AS "responsibleAction",
           ${MATERIAL_RECONCILIATION_EXCEPTION_SQL} AS "reconciliationException",
           m.latest_evidence_reference AS "sourceReference",
           NULL::uuid AS "revisedQuotationVersionId",
           m.version AS "version",
           m.created_at AS "createdAt",
           m.updated_at AS "updatedAt"
      FROM handyman_material_purchase_records m
     WHERE ${[
       `m.status IN (${statusList})`,
       ...conditions,
     ].join('\n       AND ')}`;
}

type InboxSelection = HandymanCommercialInboxQuery & { actorUserId: string };

function unionSelection(selection: InboxSelection): {
  sql: string;
  values: unknown[];
} {
  const shared: SharedFilterBind = {
    clientId: selection.clientId,
    buildingId: selection.buildingId,
    tenantCompanyId: selection.tenantCompanyId,
    createdFrom: selection.createdFrom,
    createdTo: selection.createdTo,
    actorUserId: selection.actorUserId,
  };
  // Both branches embed the identical shared predicate list with the SAME
  // parameter indices and values — the statement carries one binding set.
  const bind = sharedWhere('v', shared);
  const variation = variationBranch(bind.conditions);
  const material = materialBranch(sharedWhere('m', shared).conditions);
  const values = [...bind.values];
  let idx = values.length + 1;

  const outer: string[] = [];
  if (selection.recordType !== undefined) {
    outer.push(`rows."recordType" = $${idx++}`);
    values.push(selection.recordType);
  }
  if (selection.status !== undefined) {
    outer.push(`rows."recordStatus" = $${idx++}`);
    values.push(selection.status);
  }
  if (selection.responsible !== undefined) {
    outer.push(`rows."responsiblePersona" = $${idx++}`);
    values.push(selection.responsible);
  }
  if (selection.cursor !== undefined) {
    outer.push(
      `(rows."createdAt", rows."recordType", rows."recordId")
         < ($${idx}::timestamptz, $${idx + 1}::text, $${idx + 2}::uuid)`,
    );
    values.push(
      selection.cursor.createdAt,
      selection.cursor.recordType,
      selection.cursor.recordId,
    );
    idx += 3;
  }

  const sql = `SELECT rows.*
     FROM (
${variation}
     UNION ALL
${material}
   ) AS rows
   ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
   ORDER BY rows."createdAt" DESC, rows."recordType" DESC, rows."recordId" DESC`;
  return { sql, values };
}

async function listCommercialInboxPage(
  executor: Pick<PoolClient, 'query'> = getPool(),
  selection: InboxSelection,
  limit: number,
): Promise<{ rows: InboxRow[]; hasMore: boolean }> {
  const { sql, values } = unionSelection(selection);
  const result = await executor.query<InboxRow>(
    `${sql}
      LIMIT $${values.length + 1}`,
    [...values, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  return { rows: result.rows.slice(0, limit), hasMore };
}

/**
 * Authoritative counts over the COMPLETE permitted result set: the same
 * statement shape, the same filters, the same wall — no page clause. A page
 * is never labeled a total.
 */
async function countCommercialInbox(
  executor: Pick<PoolClient, 'query'> = getPool(),
  selection: InboxSelection,
): Promise<HandymanCommercialInboxCounts> {
  const { sql, values } = unionSelection(selection);
  const result = await executor.query<{
    recordType: HandymanCommercialInboxRecordType;
    recordStatus: string;
    responsiblePersona: HandymanCommercialInboxResponsiblePersona;
    count: string;
  }>(
    `SELECT rows."recordType" AS "recordType",
            rows."recordStatus" AS "recordStatus",
            rows."responsiblePersona" AS "responsiblePersona",
            count(*)::text AS "count"
       FROM (
${sql}
       ) AS rows
      GROUP BY rows."recordType", rows."recordStatus", rows."responsiblePersona"`,
    values,
  );

  const counts: HandymanCommercialInboxCounts = {
    total: 0,
    byRecordType: { SCOPE_VARIATION: 0, MATERIAL_PURCHASE: 0 },
    byStatus: {},
    byResponsiblePersona: {},
  };
  for (const row of result.rows) {
    const count = Number(row.count);
    counts.total += count;
    counts.byRecordType[row.recordType] =
      (counts.byRecordType[row.recordType] ?? 0) + count;
    counts.byStatus[row.recordStatus] =
      (counts.byStatus[row.recordStatus] ?? 0) + count;
    counts.byResponsiblePersona[row.responsiblePersona] =
      (counts.byResponsiblePersona[row.responsiblePersona] ?? 0) + count;
  }
  return counts;
}

function toInboxItem(row: InboxRow): HandymanCommercialInboxItem {
  return {
    recordId: row.recordId,
    recordType: row.recordType,
    recordStatus: row.recordStatus as HandymanCommercialInboxItem['recordStatus'],
    commercialKind: row.commercialKind as HandymanCommercialInboxItem['commercialKind'],
    executionScopeId: row.executionScopeId,
    handymanRequestId: row.handymanRequestId,
    clientId: row.clientId,
    buildingId: row.buildingId,
    tenantCompanyId: row.tenantCompanyId,
    title: row.title,
    responsible: {
      persona: row.responsiblePersona,
      action: row.responsibleAction,
    },
    reconciliationException: row.reconciliationException,
    sourceReference: row.sourceReference,
    revisedQuotationVersionId: row.revisedQuotationVersionId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const handymanOperationsCommercialInboxRepository = {
  listCommercialInboxPage,
  countCommercialInbox,
  toInboxItem,
};
