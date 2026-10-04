import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  HandymanMaterialAcquisitionMode,
  HandymanMaterialExecutionEventRecord,
  HandymanMaterialExecutionEventType,
  HandymanMaterialExecutionLineHead,
  HandymanMaterialExecutionLineRecord,
  HandymanMaterialExecutionProgressRow,
  HandymanMaterialExecutionStatus,
  HandymanMaterialExecutionUom,
  NewHandymanMaterialExecutionEvent,
  NewHandymanMaterialExecutionLine,
} from './handyman-material-execution.types';

/**
 * CR-HM-09 PART 01 — material execution repository. The ONLY writer
 * of `handyman_material_execution_lines` and
 * `handyman_material_execution_events`. ZERO lifecycle/approval/
 * quantity-decision logic (later PARTs own the command semantics;
 * this layer only persists given server-side input). All timestamps
 * are DB-server clock — callers pass no time. ZERO commercial/
 * financial fields exist to persist at this boundary.
 */

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;

const LINE_SELECT = `
  SELECT id, client_id, execution_scope_id, quotation_version_id,
         quotation_line_id, source_item_id, status, acquisition_mode,
         estimated_qty, approved_qty, issued_qty, purchased_qty,
         used_qty, returned_qty, supplier_reference,
         created_at, updated_at
    FROM handyman_material_execution_lines`;

const EVENT_SELECT = `
  SELECT id, client_id, line_id, execution_scope_id, event_type,
         idempotency_key, actor_user_id, occurred_at, created_at
    FROM handyman_material_execution_events`;

function toQuantity(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function mapLine(row: Row): HandymanMaterialExecutionLineRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    quotationVersionId: row.quotation_version_id,
    quotationLineId: row.quotation_line_id,
    sourceItemId: row.source_item_id,
    status: row.status as HandymanMaterialExecutionStatus,
    acquisitionMode:
      row.acquisition_mode as HandymanMaterialAcquisitionMode | null,
    estimatedQty: toQuantity(row.estimated_qty),
    approvedQty: toQuantity(row.approved_qty),
    issuedQty: toQuantity(row.issued_qty),
    purchasedQty: toQuantity(row.purchased_qty),
    usedQty: toQuantity(row.used_qty),
    returnedQty: toQuantity(row.returned_qty),
    supplierReference: row.supplier_reference,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapEvent(row: Row): HandymanMaterialExecutionEventRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    lineId: row.line_id,
    executionScopeId: row.execution_scope_id,
    eventType: row.event_type as HandymanMaterialExecutionEventType,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Creates one ESTIMATED line anchored to the immutable quotation
 * snapshot references (identity columns are written here and blocked
 * from rewrite by the identity-immutability trigger).
 */
async function createMaterialExecutionLine(
  executor: Executor = getPool(),
  record: NewHandymanMaterialExecutionLine,
): Promise<HandymanMaterialExecutionLineRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_material_execution_lines (
       id, client_id, execution_scope_id, quotation_version_id,
       quotation_line_id, source_item_id, status, acquisition_mode,
       estimated_qty, approved_qty, issued_qty, purchased_qty,
       used_qty, returned_qty, supplier_reference
     ) VALUES ($1, $2, $3, $4, $5, $6,
               'ESTIMATED', NULL, $7, 0, 0, 0, 0, 0, $8)
     RETURNING id, client_id, execution_scope_id,
               quotation_version_id, quotation_line_id,
               source_item_id, status, acquisition_mode, estimated_qty,
               approved_qty, issued_qty, purchased_qty, used_qty,
               returned_qty, supplier_reference, created_at,
               updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.executionScopeId,
      record.quotationVersionId,
      record.quotationLineId,
      record.sourceItemId ?? null,
      record.estimatedQty,
      record.supplierReference ?? null,
    ],
  );
  return mapLine(result.rows[0]);
}

async function findMaterialExecutionLineById(
  executor: Executor = getPool(),
  lineId: string,
): Promise<HandymanMaterialExecutionLineRecord | null> {
  const result = await executor.query(
    `${LINE_SELECT} WHERE id = $1`,
    [lineId],
  );
  return result.rows[0] ? mapLine(result.rows[0]) : null;
}

/** Row-locking read for later-PART serialized commands. */
async function findMaterialExecutionLineByIdForUpdate(
  executor: Executor = getPool(),
  lineId: string,
): Promise<HandymanMaterialExecutionLineRecord | null> {
  const result = await executor.query(
    `${LINE_SELECT} WHERE id = $1 FOR UPDATE`,
    [lineId],
  );
  return result.rows[0] ? mapLine(result.rows[0]) : null;
}

async function listMaterialExecutionLinesByScope(
  executor: Executor = getPool(),
  executionScopeId: string,
): Promise<HandymanMaterialExecutionLineRecord[]> {
  const result = await executor.query(
    `${LINE_SELECT}
      WHERE execution_scope_id = $1
      ORDER BY created_at, id`,
    [executionScopeId],
  );
  return result.rows.map(mapLine);
}

/**
 * Lead progress read with authoritative UOM from the immutable linked
 * quotation line (not from sourceItemId/catalogue metadata). The client
 * join prevents a malformed cross-client unit link from being serialized.
 */
async function listMaterialExecutionProgressRowsByScope(
  executor: Executor = getPool(),
  executionScopeId: string,
): Promise<HandymanMaterialExecutionProgressRow[]> {
  const result = await executor.query(
    `SELECT line.id, line.client_id, line.execution_scope_id,
            line.quotation_version_id, line.quotation_line_id,
            line.source_item_id, line.status, line.acquisition_mode,
            line.estimated_qty, line.approved_qty, line.issued_qty,
            line.purchased_qty, line.used_qty, line.returned_qty,
            line.supplier_reference, line.created_at, line.updated_at,
            quote_line.description AS material_description,
            unit.id AS uom_id, unit.code AS uom_code,
            unit.name AS uom_name, unit.symbol AS uom_symbol,
            unit.category AS uom_category
       FROM handyman_material_execution_lines AS line
       JOIN handyman_quotation_lines AS quote_line
         ON quote_line.id = line.quotation_line_id
        AND quote_line.quotation_version_id = line.quotation_version_id
        AND quote_line.line_type = 'MATERIAL'
       JOIN units_of_measure AS unit
         ON unit.id = quote_line.uom_id
        AND unit.client_id = line.client_id
      WHERE line.execution_scope_id = $1
      ORDER BY line.created_at, line.id`,
    [executionScopeId],
  );
  return result.rows.map((row) => ({
    line: mapLine(row),
    materialDescription: row.material_description,
    uom: {
      id: row.uom_id,
      code: row.uom_code,
      name: row.uom_name,
      symbol: row.uom_symbol,
      category: row.uom_category,
    } as HandymanMaterialExecutionUom,
  }));
}

/**
 * One-link-per-quotation-line lookup: at most ONE execution line may
 * realize a given quotation line (the link is an authority anchor,
 * never a duplicate target).
 */
async function findMaterialExecutionLineByQuotationLine(
  executor: Executor = getPool(),
  quotationLineId: string,
): Promise<HandymanMaterialExecutionLineRecord | null> {
  const result = await executor.query(
    `${LINE_SELECT}
      WHERE quotation_line_id = $1
      ORDER BY created_at, id LIMIT 1`,
    [quotationLineId],
  );
  return result.rows[0] ? mapLine(result.rows[0]) : null;
}

/**
 * Head mutation primitive: updates ONLY the mutable projection head
 * (status/acquisition/quantities/supplier reference) with a fresh
 * server-clock updated_at. Identity columns are not parameters and
 * are blocked from rewrite by the identity-immutability trigger.
 * NO lifecycle evaluation lives here — the caller already decided
 * the new head.
 */
async function updateMaterialExecutionLineHead(
  executor: Executor = getPool(),
  lineId: string,
  head: HandymanMaterialExecutionLineHead,
): Promise<HandymanMaterialExecutionLineRecord | null> {
  const result = await executor.query(
    `UPDATE handyman_material_execution_lines
        SET status = $2,
            acquisition_mode = $3,
            approved_qty = $4,
            issued_qty = $5,
            purchased_qty = $6,
            used_qty = $7,
            returned_qty = $8,
            supplier_reference = $9,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, client_id, execution_scope_id,
                quotation_version_id, quotation_line_id,
                source_item_id, status, acquisition_mode,
                estimated_qty, approved_qty, issued_qty,
                purchased_qty, used_qty, returned_qty,
                supplier_reference, created_at, updated_at`,
    [
      lineId,
      head.status,
      head.acquisitionMode,
      head.approvedQty,
      head.issuedQty,
      head.purchasedQty,
      head.usedQty,
      head.returnedQty,
      head.supplierReference,
    ],
  );
  return result.rows[0] ? mapLine(result.rows[0]) : null;
}

/**
 * Appends an execution event with server-clock occurred_at. The
 * (line, event_type, idempotency_key) unique index backstops
 * replay; a duplicate insert raises 23505 — deciding replay-vs-
 * conflict is a LATER-PART concern; this layer only persists.
 */
async function appendMaterialExecutionEvent(
  executor: Executor = getPool(),
  record: NewHandymanMaterialExecutionEvent,
): Promise<HandymanMaterialExecutionEventRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_material_execution_events (
       id, client_id, line_id, execution_scope_id, event_type,
       idempotency_key, actor_user_id, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     RETURNING id, client_id, line_id, execution_scope_id,
               event_type, idempotency_key, actor_user_id,
               occurred_at, created_at`,
    [
      randomUUID(),
      record.clientId,
      record.lineId,
      record.executionScopeId,
      record.eventType,
      record.idempotencyKey,
      record.actorUserId,
    ],
  );
  return mapEvent(result.rows[0]);
}

async function findMaterialExecutionEventByIdempotency(
  executor: Executor = getPool(),
  lineId: string,
  eventType: HandymanMaterialExecutionEventType,
  idempotencyKey: string,
): Promise<HandymanMaterialExecutionEventRecord | null> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE line_id = $1 AND event_type = $2
        AND idempotency_key = $3`,
    [lineId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

async function listMaterialExecutionEventsByLine(
  executor: Executor = getPool(),
  lineId: string,
): Promise<HandymanMaterialExecutionEventRecord[]> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE line_id = $1 ORDER BY occurred_at, created_at, id`,
    [lineId],
  );
  return result.rows.map(mapEvent);
}

export const handymanMaterialExecutionRepository = {
  createMaterialExecutionLine,
  findMaterialExecutionLineById,
  findMaterialExecutionLineByIdForUpdate,
  findMaterialExecutionLineByQuotationLine,
  listMaterialExecutionLinesByScope,
  listMaterialExecutionProgressRowsByScope,
  updateMaterialExecutionLineHead,
  appendMaterialExecutionEvent,
  findMaterialExecutionEventByIdempotency,
  listMaterialExecutionEventsByLine,
};
