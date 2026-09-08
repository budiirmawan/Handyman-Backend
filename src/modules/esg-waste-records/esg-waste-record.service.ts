import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { getPool } from '../../database';
import {
  buildingAccessDeniedError,
  contextAccessService,
  getAccessibleBuildingIds,
} from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { getPool as getDbPool } from '../../database';
import {
  esgWasteRecordBuildingInactiveError,
  esgWasteRecordBuildingNotFoundError,
  esgWasteRecordFlocBuildingMismatchError,
  esgWasteRecordFlocNotFoundError,
  esgWasteRecordNotActiveError,
  esgWasteRecordNotFoundError,
  esgWasteRecordUomClientMismatchError,
  esgWasteRecordUomInactiveError,
  esgWasteRecordUomNotFoundError,
  esgWasteRecordVendorClientMismatchError,
  esgWasteRecordVendorInactiveError,
  esgWasteRecordVendorNotFoundError,
} from './esg-waste-record.errors';
import { esgWasteRecordRepository } from './esg-waste-record.repository';
import type {
  CreateEsgWasteRecordInput,
  EsgWasteRecord,
  EsgWasteRecordFilters,
  NewEsgWasteRecord,
  PublicEsgWasteRecord,
  UpdateEsgWasteRecordInput,
} from './esg-waste-record.types';

type BuildingRow = {
  id: string;
  property_id: string;
  status: string;
};

type PropertyRow = {
  id: string;
  client_id: string;
};

type UomRow = {
  id: string;
  client_id: string;
  code: string;
  name: string;
  symbol: string;
  status: string;
};

type VendorRow = {
  id: string;
  client_id: string;
  vendor_code: string;
  vendor_name: string;
  status: string;
};

type FlocRow = {
  id: string;
  building_id: string;
};

function toPublic(rec: EsgWasteRecord): PublicEsgWasteRecord {
  return {
    id: rec.id,
    clientId: rec.clientId,
    buildingId: rec.buildingId,
    functionalLocationId: rec.functionalLocationId,
    wasteType: rec.wasteType,
    disposalMethod: rec.disposalMethod,
    quantity: Number(rec.quantity),
    uomId: rec.uomId,
    periodDate:
      rec.periodDate instanceof Date
        ? rec.periodDate.toISOString().slice(0, 10)
        : String(rec.periodDate).slice(0, 10),
    sourceType: rec.sourceType,
    vendorId: rec.vendorId,
    notes: rec.notes,
    status: rec.status,
    createdByUserId: rec.createdByUserId,
    createdAt:
      rec.createdAt instanceof Date ? rec.createdAt.toISOString() : String(rec.createdAt),
    updatedAt:
      rec.updatedAt instanceof Date ? rec.updatedAt.toISOString() : String(rec.updatedAt),
  };
}

function metadata(rec: EsgWasteRecord): Record<string, unknown> {
  return {
    buildingId: rec.buildingId,
    wasteType: rec.wasteType,
    disposalMethod: rec.disposalMethod,
    quantity: rec.quantity,
    uomId: rec.uomId,
    periodDate: rec.periodDate,
    sourceType: rec.sourceType,
    vendorId: rec.vendorId,
    status: rec.status,
    clientId: rec.clientId,
  };
}

async function resolveBuildingClient(
  buildingId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<{ buildingId: string; clientId: string }> {
  const buildingRes = await executor.query<BuildingRow>(
    `SELECT id, property_id, status FROM buildings WHERE id = $1`,
    [buildingId],
  );
  const building = buildingRes.rows[0];
  if (!building) throw esgWasteRecordBuildingNotFoundError();
  if (building.status !== 'ACTIVE') throw esgWasteRecordBuildingInactiveError();

  const propRes = await executor.query<PropertyRow>(
    `SELECT id, client_id FROM properties WHERE id = $1`,
    [building.property_id],
  );
  const prop = propRes.rows[0];
  if (!prop) throw esgWasteRecordBuildingNotFoundError();

  return { buildingId: building.id, clientId: prop.client_id };
}

async function validateUom(
  uomId: string,
  clientId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<UomRow> {
  const res = await executor.query<UomRow>(
    `SELECT id, client_id, code, name, symbol, status FROM units_of_measure WHERE id = $1`,
    [uomId],
  );
  const row = res.rows[0];
  if (!row) throw esgWasteRecordUomNotFoundError();
  if (row.client_id !== clientId) throw esgWasteRecordUomClientMismatchError();
  if (row.status !== 'ACTIVE') throw esgWasteRecordUomInactiveError();
  return row;
}

async function validateVendor(
  vendorId: string,
  clientId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<VendorRow> {
  const res = await executor.query<VendorRow>(
    `SELECT id, client_id, vendor_code, vendor_name, status FROM vendors WHERE id = $1`,
    [vendorId],
  );
  const row = res.rows[0];
  if (!row) throw esgWasteRecordVendorNotFoundError();
  if (row.client_id !== clientId) throw esgWasteRecordVendorClientMismatchError();
  if (row.status !== 'ACTIVE') throw esgWasteRecordVendorInactiveError();
  return row;
}

async function validateFloc(
  flocId: string,
  buildingId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<FlocRow> {
  const res = await executor.query<FlocRow>(
    `SELECT id, building_id FROM functional_locations WHERE id = $1`,
    [flocId],
  );
  const row = res.rows[0];
  if (!row) throw esgWasteRecordFlocNotFoundError();
  if (row.building_id !== buildingId) throw esgWasteRecordFlocBuildingMismatchError();
  return row;
}

export async function createEsgWasteRecord(
  input: CreateEsgWasteRecordInput,
  actorUserId: string,
): Promise<PublicEsgWasteRecord> {
  // Resolve client via building, and enforce building access
  const { clientId, buildingId } = await resolveBuildingClient(input.buildingId);

  if (!(await contextAccessService.canAccessBuilding(actorUserId, buildingId))) {
    throw buildingAccessDeniedError();
  }

  if (input.functionalLocationId) {
    await validateFloc(input.functionalLocationId, buildingId);
  }

  await validateUom(input.uomId, clientId);

  if (input.vendorId) {
    await validateVendor(input.vendorId, clientId);
  }

  const periodDate = new Date(input.periodDate);
  // periodDate validation already done in parser; ensure not NaN
  if (Number.isNaN(periodDate.getTime())) {
    throw new Error('Invalid periodDate');
  }

  const newRec: NewEsgWasteRecord = {
    clientId,
    buildingId,
    functionalLocationId: input.functionalLocationId ?? null,
    wasteType: input.wasteType,
    disposalMethod: input.disposalMethod,
    quantity: input.quantity,
    uomId: input.uomId,
    periodDate,
    sourceType: input.sourceType ?? 'MANUAL',
    vendorId: input.vendorId ?? null,
    notes: input.notes?.trim() || null,
    createdByUserId: actorUserId,
  };

  return withTransaction(async (tx) => {
    const rec = await esgWasteRecordRepository.insert(tx, newRec);

    await recordOperationalEvent(
      {
        clientId: rec.clientId,
        buildingId: rec.buildingId,
        eventType: 'ESG_WASTE_RECORD_CREATED',
        entityType: 'ESG_WASTE_RECORD',
        entityId: rec.id,
        actorUserId,
        summary: `ESG waste ${rec.wasteType}/${rec.disposalMethod} ${rec.quantity} recorded for building ${rec.buildingId}.`,
        metadata: metadata(rec),
      },
      tx,
    );

    return toPublic(rec);
  });
}

export async function getEsgWasteRecord(
  id: string,
  actorUserId: string,
): Promise<PublicEsgWasteRecord> {
  const rec = await esgWasteRecordRepository.findById(undefined, id);
  if (!rec) throw esgWasteRecordNotFoundError();

  if (!(await contextAccessService.canAccessBuilding(actorUserId, rec.buildingId))) {
    throw buildingAccessDeniedError();
  }

  return toPublic(rec);
}

export async function listEsgWasteRecords(
  filters: EsgWasteRecordFilters,
  actorUserId: string,
): Promise<PublicEsgWasteRecord[]> {
  const accessibleBuildingIds = await getAccessibleBuildingIds(actorUserId);

  if (filters.buildingId && !accessibleBuildingIds.includes(filters.buildingId)) {
    return [];
  }

  // If client filter supplied but none of accessible buildings belong to it,
  // the repository will naturally return empty because building filter already
  // narrowed to accessible set. Additionally check canAccessClient for early empty.
  if (filters.clientId) {
    if (!(await contextAccessService.canAccessClient(actorUserId, filters.clientId))) {
      return [];
    }
  }

  const recs = await esgWasteRecordRepository.listScoped(
    undefined,
    accessibleBuildingIds,
    filters,
  );
  return recs.map(toPublic);
}

export async function updateEsgWasteRecord(
  id: string,
  input: UpdateEsgWasteRecordInput,
  actorUserId: string,
): Promise<PublicEsgWasteRecord> {
  const existing = await esgWasteRecordRepository.findById(undefined, id);
  if (!existing) throw esgWasteRecordNotFoundError();

  if (!(await contextAccessService.canAccessBuilding(actorUserId, existing.buildingId))) {
    throw buildingAccessDeniedError();
  }

  if (existing.status !== 'ACTIVE') {
    throw esgWasteRecordNotActiveError();
  }

  // Validate changed references
  if (input.functionalLocationId !== undefined) {
    if (input.functionalLocationId) {
      await validateFloc(input.functionalLocationId, existing.buildingId);
    }
  }

  if (input.uomId !== undefined) {
    await validateUom(input.uomId, existing.clientId);
  }

  if (input.vendorId !== undefined && input.vendorId !== null) {
    await validateVendor(input.vendorId, existing.clientId);
  }

  const periodDate =
    input.periodDate !== undefined ? new Date(input.periodDate) : undefined;

  return withTransaction(async (tx) => {
    const updated = await esgWasteRecordRepository.update(tx, id, {
      functionalLocationId: input.functionalLocationId,
      wasteType: input.wasteType,
      disposalMethod: input.disposalMethod,
      quantity: input.quantity,
      uomId: input.uomId,
      periodDate,
      sourceType: input.sourceType,
      vendorId: input.vendorId,
      notes:
        input.notes === undefined
          ? undefined
          : input.notes === null
            ? null
            : input.notes.trim() || null,
    });

    if (!updated) throw esgWasteRecordNotFoundError();

    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        buildingId: updated.buildingId,
        eventType: 'ESG_WASTE_RECORD_UPDATED',
        entityType: 'ESG_WASTE_RECORD',
        entityId: updated.id,
        actorUserId,
        summary: `ESG waste record ${updated.id} updated.`,
        metadata: metadata(updated),
      },
      tx,
    );

    return toPublic(updated);
  });
}

export async function deactivateEsgWasteRecord(
  id: string,
  actorUserId: string,
): Promise<PublicEsgWasteRecord> {
  const existing = await esgWasteRecordRepository.findById(undefined, id);
  if (!existing) throw esgWasteRecordNotFoundError();

  if (!(await contextAccessService.canAccessBuilding(actorUserId, existing.buildingId))) {
    throw buildingAccessDeniedError();
  }

  if (existing.status !== 'ACTIVE') throw esgWasteRecordNotActiveError();

  return withTransaction(async (tx) => {
    const deactivated = await esgWasteRecordRepository.deactivate(tx, id);
    if (!deactivated) throw esgWasteRecordNotActiveError();

    await recordOperationalEvent(
      {
        clientId: deactivated.clientId,
        buildingId: deactivated.buildingId,
        eventType: 'ESG_WASTE_RECORD_DEACTIVATED',
        entityType: 'ESG_WASTE_RECORD',
        entityId: deactivated.id,
        actorUserId,
        summary: `ESG waste record ${deactivated.id} deactivated.`,
        metadata: metadata(deactivated),
      },
      tx,
    );

    return toPublic(deactivated);
  });
}

export const esgWasteRecordService = {
  createEsgWasteRecord,
  getEsgWasteRecord,
  listEsgWasteRecords,
  updateEsgWasteRecord,
  deactivateEsgWasteRecord,
};
