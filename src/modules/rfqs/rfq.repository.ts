import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  NewRfq,
  NewRfqLine,
  RfqFilters,
  RfqLineRecord,
  RfqRecord,
  RfqStatus,
  UpdateRfqInput,
} from './rfq.types';

type RfqRow = {
  id: string;
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  sourceMode: RfqRecord['sourceMode'];
  rfqNumber: string;
  title: string;
  description: string | null;
  currency: RfqRecord['currency'];
  requiredDate: Date | null;
  responseDeadline: Date | null;
  sourceRequestNumber: string;
  sourceRequestTitle: string;
  sourceRequestStatus: string;
  status: RfqStatus;
  openedAt: Date | null;
  openedByUserId: string | null;
  closedAt: Date | null;
  closedByUserId: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

type RfqLineRow = {
  id: string;
  rfqId: string;
  sourceMode: RfqLineRecord['sourceMode'];
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  lineNumber: number;
  materialRequestId: string | null;
  serviceRequestId: string | null;
  sourceDescription: string;
  sourceItemId: string | null;
  sourceUomId: string | null;
  sourceServiceId: string | null;
  quantitySnapshot: string | number | null;
  sourceRequiredDate: Date | null;
  sourceClaimStatus: 'ACTIVE' | 'RELEASED';
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const RFQ_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  purchase_request_id AS "purchaseRequestId",
  source_mode AS "sourceMode",
  rfq_number AS "rfqNumber",
  title,
  description,
  currency,
  required_date AS "requiredDate",
  response_deadline AS "responseDeadline",
  source_request_number AS "sourceRequestNumber",
  source_request_title AS "sourceRequestTitle",
  source_request_status AS "sourceRequestStatus",
  status,
  opened_at AS "openedAt",
  opened_by_user_id AS "openedByUserId",
  closed_at AS "closedAt",
  closed_by_user_id AS "closedByUserId",
  cancelled_at AS "cancelledAt",
  cancelled_by_user_id AS "cancelledByUserId",
  idempotency_key AS "idempotencyKey",
  idempotency_fingerprint AS "idempotencyFingerprint",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`.trim();

const RFQ_LINE_SELECT = `
  id,
  rfq_id AS "rfqId",
  source_mode AS "sourceMode",
  client_id AS "clientId",
  building_id AS "buildingId",
  purchase_request_id AS "purchaseRequestId",
  line_number AS "lineNumber",
  material_request_id AS "materialRequestId",
  service_request_id AS "serviceRequestId",
  source_description AS "sourceDescription",
  source_item_id AS "sourceItemId",
  source_uom_id AS "sourceUomId",
  source_service_id AS "sourceServiceId",
  quantity_snapshot AS "quantitySnapshot",
  source_required_date AS "sourceRequiredDate",
  source_claim_status AS "sourceClaimStatus",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`.trim();

function mapRfq(row: RfqRow): RfqRecord {
  return row;
}

function mapLine(row: RfqLineRow): RfqLineRecord {
  return {
    ...row,
    quantitySnapshot:
      row.quantitySnapshot === null ? null : Number(row.quantitySnapshot),
  };
}

async function findById(id: string): Promise<RfqRecord | null> {
  const result = await getPool().query<RfqRow>(
    `SELECT ${RFQ_SELECT} FROM rfqs WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRfq(result.rows[0]) : null;
}

async function findByIdForUpdate(
  client: PoolClient,
  id: string,
): Promise<RfqRecord | null> {
  const result = await client.query<RfqRow>(
    `SELECT ${RFQ_SELECT} FROM rfqs WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ? mapRfq(result.rows[0]) : null;
}

async function findByIdempotencyKey(
  client: PoolClient,
  clientId: string,
  idempotencyKey: string,
): Promise<RfqRecord | null> {
  const result = await client.query<RfqRow>(
    `SELECT ${RFQ_SELECT}
       FROM rfqs
      WHERE client_id = $1 AND idempotency_key = $2
      FOR UPDATE`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ? mapRfq(result.rows[0]) : null;
}

async function createIdempotent(
  client: PoolClient,
  input: NewRfq,
): Promise<{ record: RfqRecord; created: boolean }> {
  const result = await client.query<RfqRow>(
    `INSERT INTO rfqs
       (id, client_id, building_id, purchase_request_id, source_mode,
        rfq_number, title, description, currency, required_date,
        response_deadline, source_request_number, source_request_title,
        source_request_status, idempotency_key, idempotency_fingerprint,
        created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (client_id, idempotency_key) DO NOTHING
     RETURNING ${RFQ_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.purchaseRequestId,
      input.sourceMode,
      input.rfqNumber,
      input.title,
      input.description,
      input.currency,
      input.requiredDate,
      input.responseDeadline,
      input.sourceRequestNumber,
      input.sourceRequestTitle,
      input.sourceRequestStatus,
      input.idempotencyKey,
      input.idempotencyFingerprint,
      input.createdByUserId,
    ],
  );

  if (result.rows[0]) {
    return { record: mapRfq(result.rows[0]), created: true };
  }

  const existing = await findByIdempotencyKey(
    client,
    input.clientId,
    input.idempotencyKey,
  );
  if (!existing) {
    // The only expected conflict here is the idempotency key. Leave any
    // unexpected database error to the caller rather than returning a guess.
    throw new Error('RFQ idempotency conflict could not be resolved.');
  }
  return { record: existing, created: false };
}

async function list(
  filters: RfqFilters,
  accessibleBuildingIds: string[],
): Promise<RfqRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];
  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['building_id = ANY($1::uuid[])'];

  if (filters.sourceMode !== undefined) {
    values.push(filters.sourceMode);
    conditions.push(`source_mode = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.buildingId !== undefined) {
    values.push(filters.buildingId);
    conditions.push(`building_id = $${values.length}`);
  }
  if (filters.purchaseRequestId !== undefined) {
    values.push(filters.purchaseRequestId);
    conditions.push(`purchase_request_id = $${values.length}`);
  }

  const result = await getPool().query<RfqRow>(
    `SELECT ${RFQ_SELECT} FROM rfqs
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, id DESC`,
    values,
  );
  return result.rows.map(mapRfq);
}

async function updateDraftWithClient(
  client: PoolClient,
  id: string,
  input: UpdateRfqInput,
): Promise<RfqRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];

  if (input.title !== undefined) {
    values.push(input.title);
    sets.push(`title = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.currency !== undefined) {
    values.push(input.currency);
    sets.push(`currency = $${values.length}`);
  }
  if (input.requiredDate !== undefined) {
    values.push(input.requiredDate);
    sets.push(`required_date = $${values.length}`);
  }
  if (input.responseDeadline !== undefined) {
    values.push(input.responseDeadline);
    sets.push(`response_deadline = $${values.length}`);
  }

  if (sets.length === 0) return findByIdForUpdate(client, id);

  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await client.query<RfqRow>(
    `UPDATE rfqs SET ${sets.join(', ')}
      WHERE id = $${values.length} AND status = 'DRAFT'
      RETURNING ${RFQ_SELECT}`,
    values,
  );
  return result.rows[0] ? mapRfq(result.rows[0]) : null;
}

async function transitionWithClient(
  client: PoolClient,
  id: string,
  from: RfqStatus,
  to: Exclude<RfqStatus, 'DRAFT'>,
  actorUserId: string,
): Promise<RfqRecord | null> {
  const fields: string[] = ['status = $2', 'updated_at = NOW()'];
  const values: unknown[] = [id, to];

  if (to === 'OPEN') {
    fields.push('opened_at = NOW()', 'opened_by_user_id = $3');
    values.push(actorUserId);
  } else if (to === 'CLOSED') {
    fields.push('closed_at = NOW()', 'closed_by_user_id = $3');
    values.push(actorUserId);
  } else if (to === 'CANCELLED') {
    fields.push('cancelled_at = NOW()', 'cancelled_by_user_id = $3');
    values.push(actorUserId);
  }

  const result = await client.query<RfqRow>(
    `UPDATE rfqs SET ${fields.join(', ')}
      WHERE id = $1 AND status = $4
      RETURNING ${RFQ_SELECT}`,
    [...values, from],
  );
  return result.rows[0] ? mapRfq(result.rows[0]) : null;
}

async function countLines(client: PoolClient, rfqId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM rfq_lines WHERE rfq_id = $1',
    [rfqId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function listLinesWithClient(
  client: PoolClient,
  rfqId: string,
): Promise<RfqLineRecord[]> {
  const result = await client.query<RfqLineRow>(
    `SELECT ${RFQ_LINE_SELECT} FROM rfq_lines
      WHERE rfq_id = $1 ORDER BY line_number, id`,
    [rfqId],
  );
  return result.rows.map(mapLine);
}

async function listLines(rfqId: string): Promise<RfqLineRecord[]> {
  const result = await getPool().query<RfqLineRow>(
    `SELECT ${RFQ_LINE_SELECT} FROM rfq_lines
      WHERE rfq_id = $1 ORDER BY line_number, id`,
    [rfqId],
  );
  return result.rows.map(mapLine);
}

async function findLineById(id: string): Promise<RfqLineRecord | null> {
  const result = await getPool().query<RfqLineRow>(
    `SELECT ${RFQ_LINE_SELECT} FROM rfq_lines WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapLine(result.rows[0]) : null;
}

async function releaseSourceClaimsWithClient(
  client: PoolClient,
  rfqId: string,
): Promise<void> {
  await client.query(
    `UPDATE rfq_lines
        SET source_claim_status = 'RELEASED', updated_at = NOW()
      WHERE rfq_id = $1 AND source_claim_status = 'ACTIVE'`,
    [rfqId],
  );
}

async function createLineWithClient(
  client: PoolClient,
  input: NewRfqLine,
): Promise<RfqLineRecord> {
  const next = await client.query<{ lineNumber: number }>(
    `SELECT COALESCE(MAX(line_number), 0) + 1 AS "lineNumber"
       FROM rfq_lines WHERE rfq_id = $1`,
    [input.rfqId],
  );
  const lineNumber = Number(next.rows[0]?.lineNumber ?? 1);

  const result = await client.query<RfqLineRow>(
    `INSERT INTO rfq_lines
       (id, rfq_id, source_mode, client_id, building_id, purchase_request_id,
        line_number, material_request_id, service_request_id,
        source_description, source_item_id, source_uom_id, source_service_id,
        quantity_snapshot, source_required_date, source_claim_status,
        created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING ${RFQ_LINE_SELECT}`,
    [
      randomUUID(),
      input.rfqId,
      input.sourceMode,
      input.clientId,
      input.buildingId,
      input.purchaseRequestId,
      lineNumber,
      input.materialRequestId,
      input.serviceRequestId,
      input.sourceDescription,
      input.sourceItemId,
      input.sourceUomId,
      input.sourceServiceId,
      input.quantitySnapshot,
      input.sourceRequiredDate,
      input.sourceClaimStatus,
      input.createdByUserId,
    ],
  );
  return mapLine(result.rows[0]);
}

export const rfqRepository = {
  countLines,
  createIdempotent,
  createLineWithClient,
  findById,
  findByIdForUpdate,
  findByIdempotencyKey,
  findLineById,
  list,
  listLines,
  listLinesWithClient,
  releaseSourceClaimsWithClient,
  transitionWithClient,
  updateDraftWithClient,
};
