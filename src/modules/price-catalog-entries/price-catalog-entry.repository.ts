import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  NewPriceCatalogEntry,
  PriceCatalogEntryFilters,
  PriceCatalogEntryRecord,
  UpdatePriceCatalogEntryInput,
} from './price-catalog-entry.types';

/**
 * CR-BE-PRICE-01 PART 01 — Price Authority persistence.
 *
 * All writes run inside a caller-provided transaction so lifecycle commands
 * (activate / deactivate / replace) stay atomic with their audit events.
 * Money travels as `::text` and is converted to a number at this boundary,
 * following the purchase-order-lines convention.
 */

type PriceCatalogEntryRow = {
  id: string;
  clientId: string;
  buildingId: string | null;
  vendorId: string | null;
  sourceMode: PriceCatalogEntryRecord['sourceMode'];
  entryKind: PriceCatalogEntryRecord['entryKind'];
  itemId: string | null;
  uomId: string | null;
  serviceId: string | null;
  currency: PriceCatalogEntryRecord['currency'];
  unitPrice: string | number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: PriceCatalogEntryRecord['status'];
  activatedAt: Date | null;
  activatedByUserId: string | null;
  deactivatedAt: Date | null;
  deactivatedByUserId: string | null;
  replacedByEntryId: string | null;
  sourceType: PriceCatalogEntryRecord['sourceType'];
  sourceReference: string | null;
  notes: string | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const ENTRY_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  vendor_id AS "vendorId",
  source_mode AS "sourceMode",
  entry_kind AS "entryKind",
  item_id AS "itemId",
  uom_id AS "uomId",
  service_id AS "serviceId",
  currency,
  unit_price::text AS "unitPrice",
  effective_from AS "effectiveFrom",
  effective_to AS "effectiveTo",
  status,
  activated_at AS "activatedAt",
  activated_by_user_id AS "activatedByUserId",
  deactivated_at AS "deactivatedAt",
  deactivated_by_user_id AS "deactivatedByUserId",
  replaced_by_entry_id AS "replacedByEntryId",
  source_type AS "sourceType",
  source_reference AS "sourceReference",
  notes,
  approved_by_user_id AS "approvedByUserId",
  approved_at AS "approvedAt",
  idempotency_key AS "idempotencyKey",
  idempotency_fingerprint AS "idempotencyFingerprint",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`.trim();

function mapEntry(row: PriceCatalogEntryRow): PriceCatalogEntryRecord {
  return {
    ...row,
    unitPrice: Number(row.unitPrice),
  };
}

const INSERT_COLUMNS = `
  (id, client_id, building_id, vendor_id, source_mode, entry_kind, item_id,
   uom_id, service_id, currency, unit_price, effective_from, effective_to,
   status, activated_at, activated_by_user_id, source_type, source_reference,
   notes, approved_by_user_id, approved_at, idempotency_key,
   idempotency_fingerprint, created_by_user_id)
`.trim();

function insertValues(input: NewPriceCatalogEntry, activate: boolean): unknown[] {
  return [
    randomUUID(),
    input.clientId,
    input.buildingId,
    input.vendorId,
    input.sourceMode,
    input.entryKind,
    input.itemId,
    input.uomId,
    input.serviceId,
    input.currency,
    input.unitPrice,
    input.effectiveFrom,
    input.effectiveTo,
    activate ? 'ACTIVE' : 'DRAFT',
    activate ? new Date() : null,
    activate ? input.createdByUserId : null,
    'MANUAL',
    input.sourceReference,
    input.notes,
    input.approvedByUserId,
    input.approvedByUserId === null ? null : new Date(),
    input.idempotencyKey,
    input.idempotencyFingerprint,
    input.createdByUserId,
  ];
}

async function insertEntry(
  client: PoolClient,
  input: NewPriceCatalogEntry,
  activate: boolean,
): Promise<{ record: PriceCatalogEntryRecord; created: boolean }> {
  const result = await client.query<PriceCatalogEntryRow>(
    `INSERT INTO price_catalog_entries ${INSERT_COLUMNS}
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     ON CONFLICT (client_id, idempotency_key) DO NOTHING
     RETURNING ${ENTRY_SELECT}`,
    insertValues(input, activate),
  );

  if (result.rows[0]) {
    return { record: mapEntry(result.rows[0]), created: true };
  }

  const existing = await findByIdempotencyKey(
    client,
    input.clientId,
    input.idempotencyKey,
  );
  if (!existing) {
    throw new Error(
      'price_catalog_entries idempotency insert returned no row and no existing record.',
    );
  }
  return { record: existing, created: false };
}

async function findById(id: string): Promise<PriceCatalogEntryRecord | null> {
  const result = await getPool().query<PriceCatalogEntryRow>(
    `SELECT ${ENTRY_SELECT} FROM price_catalog_entries WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapEntry(result.rows[0]) : null;
}

async function findByIdForUpdate(
  client: PoolClient,
  id: string,
): Promise<PriceCatalogEntryRecord | null> {
  const result = await client.query<PriceCatalogEntryRow>(
    `SELECT ${ENTRY_SELECT} FROM price_catalog_entries WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ? mapEntry(result.rows[0]) : null;
}

async function findByIdempotencyKey(
  client: PoolClient,
  clientId: string,
  idempotencyKey: string,
): Promise<PriceCatalogEntryRecord | null> {
  const result = await client.query<PriceCatalogEntryRow>(
    `SELECT ${ENTRY_SELECT} FROM price_catalog_entries
     WHERE client_id = $1 AND idempotency_key = $2`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ? mapEntry(result.rows[0]) : null;
}

/**
 * CR-BE-PRICE-01 PART 02 — §8 applicability candidates.
 *
 * Every clause of the governed predicate (status ACTIVE, MATERIAL mode, exact
 * item, exact currency, exact UOM, tier applicability for Building/Vendor,
 * half-open window [from, to) at T) is expressed here so the resolver consumes
 * exactly the rows §8 declares applicable — nothing more, nothing less.
 * Reads never lock: the exclusion constraint already guarantees at most one
 * applicable row per tier, and the resolver defensively fails closed if that
 * guarantee is ever observed broken.
 */
async function listResolutionCandidates(input: {
  clientId: string;
  buildingId: string;
  vendorId: string | null;
  currency: PriceCatalogEntryRecord['currency'];
  asOf: Date;
} & (
  | { sourceMode: 'MATERIAL'; itemId: string; uomId: string }
  | { sourceMode: 'SERVICE'; serviceId: string }
)): Promise<PriceCatalogEntryRecord[]> {
  const isMaterial = input.sourceMode === 'MATERIAL';
  const subjectClause = isMaterial
    ? `AND item_id = $2 AND uom_id = $4`
    : `AND service_id = $2`;
  // The placeholder order is shared: $2 subject, $3 currency, $4 uom (MATERIAL
  // only). SERVICE omits the UOM parameter.
  const params = isMaterial
    ? [input.clientId, input.itemId, input.currency, input.uomId, input.buildingId, input.vendorId, input.asOf]
    : [input.clientId, input.serviceId, input.currency, input.buildingId, input.vendorId, input.asOf];
  const result = await getPool().query<PriceCatalogEntryRow>(
    `SELECT ${ENTRY_SELECT} FROM price_catalog_entries
      WHERE client_id = $1
        AND status = 'ACTIVE'
        AND source_mode = '${input.sourceMode}'
        ${subjectClause}
        AND currency = $3
        AND (building_id IS NULL OR building_id = $${isMaterial ? 5 : 4})
        AND (vendor_id IS NULL OR vendor_id = $${isMaterial ? 6 : 5})
        AND effective_from <= $${isMaterial ? 7 : 6}
        AND (effective_to IS NULL OR effective_to > $${isMaterial ? 7 : 6})
      ORDER BY id`,
    params,
  );
  return result.rows.map(mapEntry);
}

/**
 * PART 02 / PART 05 diagnosis set: in-scope, in-window ACTIVE rows for the
 * same subject regardless of UOM/currency (MATERIAL) or currency (SERVICE).
 * Used only after selection found no winner, to classify the fail-closed
 * outcome. SERVICE has no UOM, so its only classification beyond
 * NO_REFERENCE_PRICE is CURRENCY_INCOMPATIBLE. Scope- and window-filtered
 * identical to the selection so an out-of-scope/out-of-window price is never
 * revealed.
 */
async function listResolutionDiagnostics(input: {
  clientId: string;
  buildingId: string;
  vendorId: string | null;
  asOf: Date;
} & (
  | { sourceMode: 'MATERIAL'; itemId: string }
  | { sourceMode: 'SERVICE'; serviceId: string }
)): Promise<{ uomId: string | null; currency: string }[]> {
  const isMaterial = input.sourceMode === 'MATERIAL';
  const subjectClause = isMaterial ? `AND item_id = $2` : `AND service_id = $2`;
  const params = [
    input.clientId,
    isMaterial ? input.itemId : input.serviceId,
    input.buildingId,
    input.vendorId,
    input.asOf,
  ];
  const result = await getPool().query<{ uomId: string | null; currency: string }>(
    `SELECT uom_id AS "uomId", currency
       FROM price_catalog_entries
      WHERE client_id = $1
        AND status = 'ACTIVE'
        AND source_mode = '${input.sourceMode}'
        ${subjectClause}
        AND (building_id IS NULL OR building_id = $3)
        AND (vendor_id IS NULL OR vendor_id = $4)
        AND effective_from <= $5
        AND (effective_to IS NULL OR effective_to > $5)`,
    params,
  );
  return result.rows;
}

const UPDATE_DRAFT_COLUMNS: Readonly<
  Record<keyof UpdatePriceCatalogEntryInput, string>
> = {
  buildingId: 'building_id',
  vendorId: 'vendor_id',
  itemId: 'item_id',
  uomId: 'uom_id',
  serviceId: 'service_id',
  currency: 'currency',
  unitPrice: 'unit_price',
  effectiveFrom: 'effective_from',
  effectiveTo: 'effective_to',
  sourceReference: 'source_reference',
  notes: 'notes',
  approvedByUserId: 'approved_by_user_id',
};

/** DRAFT-only field update; `approved_at` trails `approved_by_user_id`. */
async function updateDraft(
  client: PoolClient,
  id: string,
  input: UpdatePriceCatalogEntryInput,
  entryKind?: PriceCatalogEntryRecord['entryKind'],
): Promise<PriceCatalogEntryRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const key of Object.keys(input) as (keyof UpdatePriceCatalogEntryInput)[]) {
    const column = UPDATE_DRAFT_COLUMNS[key];
    if (!column) continue;
    values.push(input[key]);
    sets.push(`${column} = $${values.length}`);
  }
  // PART 03: `entry_kind` always trails the final Vendor tier key so a DRAFT
  // re-scoped into/out of the Vendor tier stays CHECK-consistent (the kind
  // is derived state, never caller-editable).
  if (entryKind !== undefined) {
    values.push(entryKind);
    sets.push(`entry_kind = $${values.length}`);
  }
  if (sets.length === 0) {
    return findByIdForUpdate(client, id);
  }
  if (input.approvedByUserId !== undefined) {
    values.push(input.approvedByUserId === null ? null : new Date());
    sets.push(`approved_at = $${values.length}`);
  }
  sets.push('updated_at = NOW()');
  values.push(id);

  const result = await client.query<PriceCatalogEntryRow>(
    `UPDATE price_catalog_entries
        SET ${sets.join(', ')}
      WHERE id = $${values.length}
        AND status = 'DRAFT'
      RETURNING ${ENTRY_SELECT}`,
    values,
  );
  return result.rows[0] ? mapEntry(result.rows[0]) : null;
}

async function activate(
  client: PoolClient,
  id: string,
  actorUserId: string,
): Promise<PriceCatalogEntryRecord | null> {
  const result = await client.query<PriceCatalogEntryRow>(
    `UPDATE price_catalog_entries
        SET status = 'ACTIVE',
            activated_at = NOW(),
            activated_by_user_id = $2,
            updated_at = NOW()
      WHERE id = $1 AND status = 'DRAFT'
      RETURNING ${ENTRY_SELECT}`,
    [id, actorUserId],
  );
  return result.rows[0] ? mapEntry(result.rows[0]) : null;
}

async function deactivate(
  client: PoolClient,
  id: string,
  actorUserId: string,
): Promise<PriceCatalogEntryRecord | null> {
  const result = await client.query<PriceCatalogEntryRow>(
    `UPDATE price_catalog_entries
        SET status = 'INACTIVE',
            deactivated_at = NOW(),
            deactivated_by_user_id = $2,
            updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${ENTRY_SELECT}`,
    [id, actorUserId],
  );
  return result.rows[0] ? mapEntry(result.rows[0]) : null;
}

/** Closes a still-ACTIVE predecessor so a replacement can supersede it. */
async function closeForReplacement(
  client: PoolClient,
  predecessorId: string,
  successorId: string,
  actorUserId: string,
): Promise<PriceCatalogEntryRecord | null> {
  const result = await client.query<PriceCatalogEntryRow>(
    `UPDATE price_catalog_entries
        SET status = 'INACTIVE',
            deactivated_at = NOW(),
            deactivated_by_user_id = $3,
            replaced_by_entry_id = $2,
            updated_at = NOW()
      WHERE id = $1
        AND status = 'ACTIVE'
        AND replaced_by_entry_id IS NULL
      RETURNING ${ENTRY_SELECT}`,
    [predecessorId, successorId, actorUserId],
  );
  return result.rows[0] ? mapEntry(result.rows[0]) : null;
}

async function insertWithId(
  client: PoolClient,
  id: string,
  input: NewPriceCatalogEntry,
  activate: boolean,
): Promise<{ record: PriceCatalogEntryRecord; created: boolean }> {
  const values = insertValues(input, activate);
  values[0] = id;
  const result = await client.query<PriceCatalogEntryRow>(
    `INSERT INTO price_catalog_entries ${INSERT_COLUMNS}
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     ON CONFLICT (client_id, idempotency_key) DO NOTHING
     RETURNING ${ENTRY_SELECT}`,
    values,
  );
  if (result.rows[0]) {
    return { record: mapEntry(result.rows[0]), created: true };
  }
  const existing = await findByIdempotencyKey(
    client,
    input.clientId,
    input.idempotencyKey,
  );
  if (!existing) {
    throw new Error(
      'price_catalog_entries idempotency insert returned no row and no existing record.',
    );
  }
  return { record: existing, created: false };
}

async function listScoped(
  accessibleClientIds: readonly string[],
  accessibleBuildingIds: readonly string[],
  filters: PriceCatalogEntryFilters,
): Promise<PriceCatalogEntryRecord[]> {
  const values: unknown[] = [accessibleClientIds, accessibleBuildingIds];
  let clause = `
    (
      (building_id IS NOT NULL AND building_id = ANY($2::uuid[]))
      OR (building_id IS NULL AND client_id = ANY($1::uuid[]))
    )
  `;

  if (filters.clientId) {
    values.push(filters.clientId);
    clause += ` AND client_id = $${values.length}`;
  }
  if (filters.buildingId) {
    values.push(filters.buildingId);
    clause += ` AND building_id = $${values.length}`;
  }
  if (filters.itemId) {
    values.push(filters.itemId);
    clause += ` AND item_id = $${values.length}`;
  }
  if (filters.serviceId) {
    values.push(filters.serviceId);
    clause += ` AND service_id = $${values.length}`;
  }
  if (filters.vendorId) {
    values.push(filters.vendorId);
    clause += ` AND vendor_id = $${values.length}`;
  }
  if (filters.uomId) {
    values.push(filters.uomId);
    clause += ` AND uom_id = $${values.length}`;
  }
  if (filters.currency) {
    values.push(filters.currency);
    clause += ` AND currency = $${values.length}`;
  }
  if (filters.status) {
    values.push(filters.status);
    clause += ` AND status = $${values.length}`;
  }

  const result = await getPool().query<PriceCatalogEntryRow>(
    `SELECT ${ENTRY_SELECT} FROM price_catalog_entries
     WHERE ${clause}
     ORDER BY client_id, effective_from DESC, id`,
    values,
  );
  return result.rows.map(mapEntry);
}

// ---- Reference loaders (same-Client validation, run inside the command txn)

async function loadClient(
  client: PoolClient,
  id: string,
): Promise<{ id: string; status: string } | null> {
  const result = await client.query<{ id: string; status: string }>(
    'SELECT id, status FROM clients WHERE id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}

async function loadItem(
  client: PoolClient,
  id: string,
): Promise<{ id: string; clientId: string; status: string } | null> {
  const result = await client.query<{
    id: string;
    clientId: string;
    status: string;
  }>(
    `SELECT id, client_id AS "clientId", status
       FROM inventory_items WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function loadUom(
  client: PoolClient,
  id: string,
): Promise<{ id: string; clientId: string; status: string } | null> {
  const result = await client.query<{
    id: string;
    clientId: string;
    status: string;
  }>(
    `SELECT id, client_id AS "clientId", status
       FROM units_of_measure WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** CR-BE-SVC-01 PART 05 — SERVICE subject loader (governed service_catalog). */
async function loadService(
  client: PoolClient,
  id: string,
): Promise<{ id: string; clientId: string; status: string } | null> {
  const result = await client.query<{
    id: string;
    clientId: string;
    status: string;
  }>(
    `SELECT id, client_id AS "clientId", status
       FROM service_catalog WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function loadVendor(
  client: PoolClient,
  id: string,
): Promise<{ id: string; clientId: string; status: string } | null> {
  const result = await client.query<{
    id: string;
    clientId: string;
    status: string;
  }>(
    `SELECT id, client_id AS "clientId", status
       FROM vendors WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function loadBuilding(
  client: PoolClient,
  id: string,
): Promise<{ id: string; clientId: string; status: string } | null> {
  const result = await client.query<{
    id: string;
    clientId: string;
    status: string;
  }>(
    `SELECT b.id, p.client_id AS "clientId", b.status
       FROM buildings b
       JOIN properties p ON p.id = b.property_id
      WHERE b.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Pool-based twin for read paths (PART 02 lookup derives Client from Building). */
async function loadBuildingById(
  id: string,
): Promise<{ id: string; clientId: string; status: string } | null> {
  const result = await getPool().query<{
    id: string;
    clientId: string;
    status: string;
  }>(
    `SELECT b.id, p.client_id AS "clientId", b.status
       FROM buildings b
       JOIN properties p ON p.id = b.property_id
      WHERE b.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function loadUser(
  client: PoolClient,
  id: string,
): Promise<{ id: string; status: string } | null> {
  const result = await client.query<{ id: string; status: string }>(
    'SELECT id, status FROM users WHERE id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}

export const priceCatalogEntryRepository = {
  activate,
  closeForReplacement,
  deactivate,
  findById,
  findByIdForUpdate,
  findByIdempotencyKey,
  insertEntry,
  insertWithId,
  listResolutionCandidates,
  listResolutionDiagnostics,
  listScoped,
  loadBuilding,
  loadBuildingById,
  loadClient,
  loadItem,
  loadUom,
  loadService,
  loadUser,
  loadVendor,
  updateDraft,
  randomId: randomUUID,
};
