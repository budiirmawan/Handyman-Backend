import { getPool } from '../../database';
import { clientInactiveError, clientNotFoundError, clientRepository } from '../clients';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import {
  utilityMeterUomClientMismatchError,
  utilityMeterUomInactiveError,
  utilityMeterUomNotFoundError,
} from '../utility-meters/utility-meter.errors';
import {
  utilityTypeConfigurationAlreadyExistsError,
  utilityTypeConfigurationInactiveError,
  utilityTypeConfigurationNotFoundError,
  utilityTypeUomAlreadyMappedError,
  utilityTypeUomMappingNotFoundError,
  utilityTypeUomNotAllowedError,
} from './utility-type-configuration.errors';
import { utilityTypeConfigurationRepository } from './utility-type-configuration.repository';
import type {
  AddUtilityTypeUomInput,
  CreateUtilityTypeConfigurationInput,
  PublicUtilityTypeConfiguration,
  PublicUtilityTypeUom,
  UpdateUtilityTypeConfigurationInput,
  UpdateUtilityTypeConfigurationStatusInput,
  UpdateUtilityTypeUomInput,
  UtilityType,
  UtilityTypeConfigurationFilters,
  UtilityTypeConfigurationRecord,
  UtilityTypeUomRecord,
} from './utility-type-configuration.types';

/**
 * BE-18B — Electricity / Water / Gas configuration service.
 *
 * This is configuration data, not a utility engine: it stores which BE-07
 * UOMs are valid per (Client, utility type) and exposes one reusable
 * assertion — `assertMeterUtilityConfiguration` — that BE-18A's Meter Master
 * calls so every Meter carries a valid utility type / UOM combination.
 *
 * Isolation: configurations are Client-scoped, and every operation asserts
 * the actor can access that Client through an explicit BE-02G Building
 * assignment. UOM validation reuses BE-07 `units_of_measure` directly.
 */

type UomContext = {
  id: string;
  code: string;
  name: string;
  symbol: string;
  status: string;
};

async function loadUomContexts(
  uomIds: readonly string[],
): Promise<Map<string, UomContext>> {
  const map = new Map<string, UomContext>();
  const unique = [...new Set(uomIds)];
  if (unique.length === 0) {
    return map;
  }
  const result = await getPool().query<UomContext>(
    'SELECT id, code, name, symbol, status FROM units_of_measure WHERE id = ANY($1)',
    [unique],
  );
  for (const row of result.rows) {
    map.set(row.id, row);
  }
  return map;
}

function toPublicUom(
  record: UtilityTypeUomRecord,
  uom: UomContext | null,
): PublicUtilityTypeUom {
  return {
    id: record.id,
    utilityTypeConfigurationId: record.utilityTypeConfigurationId,
    uomId: record.uomId,
    isDefault: record.isDefault,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    uom: uom
      ? {
          id: uom.id,
          code: uom.code,
          name: uom.name,
          symbol: uom.symbol,
          status: uom.status,
        }
      : null,
  };
}

export function toPublicUtilityTypeConfiguration(
  record: UtilityTypeConfigurationRecord,
  uomRecords: readonly UtilityTypeUomRecord[],
  uomContexts: Map<string, UomContext>,
): PublicUtilityTypeConfiguration {
  const allowedUoms = uomRecords.map((mapping) =>
    toPublicUom(mapping, uomContexts.get(mapping.uomId) ?? null),
  );
  const defaultMapping = uomRecords.find(
    (mapping) => mapping.isDefault && mapping.status === 'ACTIVE',
  );

  return {
    id: record.id,
    clientId: record.clientId,
    utilityType: record.utilityType,
    name: record.name,
    description: record.description,
    decimalPrecision: record.decimalPrecision,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    allowedUoms,
    defaultUomId: defaultMapping?.uomId ?? null,
  };
}

async function present(
  record: UtilityTypeConfigurationRecord,
): Promise<PublicUtilityTypeConfiguration> {
  const uomRecords = await utilityTypeConfigurationRepository.listUoms(record.id);
  const contexts = await loadUomContexts(uomRecords.map((entry) => entry.uomId));
  return toPublicUtilityTypeConfiguration(record, uomRecords, contexts);
}

/** BE-02G — Client access is derived from explicit Building assignments. */
async function assertClientAccess(
  actorUserId: string | undefined,
  clientId: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

/** BE-07 reuse: UOM must exist, belong to the same Client, and be ACTIVE. */
async function assertUomForClient(
  uomId: string,
  clientId: string,
): Promise<UomContext> {
  const result = await getPool().query<UomContext & { client_id: string }>(
    'SELECT id, client_id, code, name, symbol, status FROM units_of_measure WHERE id = $1',
    [uomId],
  );
  const row = result.rows[0];
  if (!row) {
    throw utilityMeterUomNotFoundError();
  }
  if (row.client_id !== clientId) {
    throw utilityMeterUomClientMismatchError();
  }
  if (row.status !== 'ACTIVE') {
    throw utilityMeterUomInactiveError();
  }
  return row;
}

export async function createUtilityTypeConfiguration(
  input: CreateUtilityTypeConfigurationInput,
  actorUserId?: string,
): Promise<PublicUtilityTypeConfiguration> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  await assertClientAccess(actorUserId, input.clientId);

  const existing = await utilityTypeConfigurationRepository.findByClientAndType(
    input.clientId,
    input.utilityType,
  );
  if (existing) {
    throw utilityTypeConfigurationAlreadyExistsError();
  }

  // Validate every requested UOM up-front so a rejected mapping never leaves
  // a half-configured utility type behind.
  for (const uomId of input.uomIds ?? []) {
    await assertUomForClient(uomId, input.clientId);
  }

  let record: UtilityTypeConfigurationRecord;
  try {
    record = await utilityTypeConfigurationRepository.createConfiguration({
      clientId: input.clientId,
      utilityType: input.utilityType,
      name: input.name,
      description: input.description ?? null,
      decimalPrecision: input.decimalPrecision ?? null,
      status: input.status ?? 'ACTIVE',
    });
  } catch (error) {
    if (isUniqueViolation(error, 'utility_type_configurations_client_type_unique')) {
      throw utilityTypeConfigurationAlreadyExistsError();
    }
    throw error;
  }

  for (const uomId of input.uomIds ?? []) {
    await utilityTypeConfigurationRepository.addUom({
      utilityTypeConfigurationId: record.id,
      uomId,
      isDefault: input.defaultUomId === uomId,
      status: 'ACTIVE',
    });
  }

  return present(record);
}

export async function getUtilityTypeConfigurationById(
  id: string,
  actorUserId?: string,
): Promise<PublicUtilityTypeConfiguration> {
  const record = await utilityTypeConfigurationRepository.findById(id);
  if (!record) {
    throw utilityTypeConfigurationNotFoundError();
  }
  await assertClientAccess(actorUserId, record.clientId);
  return present(record);
}

export async function listUtilityTypeConfigurations(
  clientId: string,
  filters: UtilityTypeConfigurationFilters,
  actorUserId?: string,
): Promise<PublicUtilityTypeConfiguration[]> {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  await assertClientAccess(actorUserId, clientId);

  const records = await utilityTypeConfigurationRepository.listByClient(
    clientId,
    filters,
  );
  const mappings =
    await utilityTypeConfigurationRepository.listUomsForConfigurations(
      records.map((record) => record.id),
    );
  const contexts = await loadUomContexts(mappings.map((entry) => entry.uomId));

  return records.map((record) =>
    toPublicUtilityTypeConfiguration(
      record,
      mappings.filter(
        (mapping) => mapping.utilityTypeConfigurationId === record.id,
      ),
      contexts,
    ),
  );
}

/** The utility type itself is immutable; only metadata / status change here. */
export async function updateUtilityTypeConfiguration(
  id: string,
  input: UpdateUtilityTypeConfigurationInput,
  actorUserId?: string,
): Promise<PublicUtilityTypeConfiguration> {
  const existing = await utilityTypeConfigurationRepository.findById(id);
  if (!existing) {
    throw utilityTypeConfigurationNotFoundError();
  }
  await assertClientAccess(actorUserId, existing.clientId);

  const updated = await utilityTypeConfigurationRepository.updateConfiguration(
    id,
    input,
  );
  if (!updated) {
    throw utilityTypeConfigurationNotFoundError();
  }
  return present(updated);
}

export async function updateUtilityTypeConfigurationStatus(
  id: string,
  input: UpdateUtilityTypeConfigurationStatusInput,
  actorUserId?: string,
): Promise<PublicUtilityTypeConfiguration> {
  return updateUtilityTypeConfiguration(id, { status: input.status }, actorUserId);
}

export async function addUtilityTypeUom(
  configurationId: string,
  input: AddUtilityTypeUomInput,
  actorUserId?: string,
): Promise<PublicUtilityTypeConfiguration> {
  const configuration =
    await utilityTypeConfigurationRepository.findById(configurationId);
  if (!configuration) {
    throw utilityTypeConfigurationNotFoundError();
  }
  await assertClientAccess(actorUserId, configuration.clientId);

  await assertUomForClient(input.uomId, configuration.clientId);

  const existing = await utilityTypeConfigurationRepository.findUomMapping(
    configurationId,
    input.uomId,
  );
  if (existing) {
    throw utilityTypeUomAlreadyMappedError();
  }

  try {
    await utilityTypeConfigurationRepository.addUom({
      utilityTypeConfigurationId: configurationId,
      uomId: input.uomId,
      isDefault: input.isDefault ?? false,
      status: 'ACTIVE',
    });
  } catch (error) {
    if (isUniqueViolation(error, 'utility_type_uoms_configuration_uom_unique')) {
      throw utilityTypeUomAlreadyMappedError();
    }
    throw error;
  }

  return present(configuration);
}

export async function updateUtilityTypeUom(
  configurationId: string,
  uomId: string,
  input: UpdateUtilityTypeUomInput,
  actorUserId?: string,
): Promise<PublicUtilityTypeConfiguration> {
  const configuration =
    await utilityTypeConfigurationRepository.findById(configurationId);
  if (!configuration) {
    throw utilityTypeConfigurationNotFoundError();
  }
  await assertClientAccess(actorUserId, configuration.clientId);

  const mapping = await utilityTypeConfigurationRepository.findUomMapping(
    configurationId,
    uomId,
  );
  if (!mapping) {
    throw utilityTypeUomMappingNotFoundError();
  }

  await utilityTypeConfigurationRepository.updateUom(
    mapping.id,
    configurationId,
    input,
  );

  return present(configuration);
}

/**
 * BE-18B's reusable authority, called by BE-18A's Meter Master.
 *
 * Resolves the (Client, utility type) configuration and asserts that the
 * Meter's UOM is an ACTIVE allowed mapping. When a Client has not configured
 * a utility type yet, BE-18A's own BE-07 UOM validation remains the only
 * constraint — configuration is opt-in, so existing BE-18A behavior is
 * preserved and the platform stays data-driven rather than hardcoded.
 */
export async function assertMeterUtilityConfiguration(
  clientId: string,
  utilityType: UtilityType,
  uomId: string,
): Promise<void> {
  const configuration = await utilityTypeConfigurationRepository.findByClientAndType(
    clientId,
    utilityType,
  );
  if (!configuration) {
    return;
  }
  if (configuration.status !== 'ACTIVE') {
    throw utilityTypeConfigurationInactiveError();
  }

  const mappings = await utilityTypeConfigurationRepository.listUoms(
    configuration.id,
  );
  const active = mappings.filter((mapping) => mapping.status === 'ACTIVE');
  if (active.length === 0) {
    return;
  }

  if (!active.some((mapping) => mapping.uomId === uomId)) {
    throw utilityTypeUomNotAllowedError(
      `The unit of measure is not allowed for utility type ${utilityType}.`,
    );
  }
}

/** Resolves the configured allowed UOMs for a (Client, utility type) pair. */
export async function resolveUtilityTypeConfiguration(
  clientId: string,
  utilityType: UtilityType,
  actorUserId?: string,
): Promise<PublicUtilityTypeConfiguration> {
  await assertClientAccess(actorUserId, clientId);

  const configuration = await utilityTypeConfigurationRepository.findByClientAndType(
    clientId,
    utilityType,
  );
  if (!configuration) {
    throw utilityTypeConfigurationNotFoundError();
  }
  return present(configuration);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

export const utilityTypeConfigurationService = {
  addUtilityTypeUom,
  assertMeterUtilityConfiguration,
  createUtilityTypeConfiguration,
  getUtilityTypeConfigurationById,
  listUtilityTypeConfigurations,
  resolveUtilityTypeConfiguration,
  toPublicUtilityTypeConfiguration,
  updateUtilityTypeConfiguration,
  updateUtilityTypeConfigurationStatus,
  updateUtilityTypeUom,
};
