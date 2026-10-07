import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { getPool } from '../../database';
import {
  buildingAccessDeniedError,
  contextAccessService,
  getAccessibleClientIds,
} from '../context-access';
import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import { recordOperationalEvent } from '../operational-events';
import {
  esgMetricDefinitionCodeAlreadyExistsError,
  esgMetricDefinitionNotActiveError,
  esgMetricDefinitionNotFoundError,
  esgMetricDefinitionUomClientMismatchError,
  esgMetricDefinitionUomInactiveError,
  esgMetricDefinitionUomNotFoundError,
} from './esg-metric-definition.errors';
import { esgMetricDefinitionRepository } from './esg-metric-definition.repository';
import type {
  CreateEsgMetricDefinitionInput,
  EsgMetricDefinitionFilters,
  EsgMetricDefinitionRecord,
  NewEsgMetricDefinition,
  PublicEsgMetricDefinition,
  UpdateEsgMetricDefinitionInput,
} from './esg-metric-definition.types';

const UNIQUE_VIOLATION = '23505';
const CLIENT_CODE_CONSTRAINT = 'esg_metric_definitions_client_code_unique';

type UomRow = {
  id: string;
  client_id: string;
  code: string;
  name: string;
  symbol: string;
  status: string;
};

function toPublic(record: EsgMetricDefinitionRecord): PublicEsgMetricDefinition {
  return {
    id: record.id,
    clientId: record.clientId,
    code: record.code,
    name: record.name,
    description: record.description,
    category: record.category,
    uomId: record.uomId,
    calculationMethod: record.calculationMethod,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt:
      record.createdAt instanceof Date
        ? record.createdAt.toISOString()
        : String(record.createdAt),
    updatedAt:
      record.updatedAt instanceof Date
        ? record.updatedAt.toISOString()
        : String(record.updatedAt),
  };
}

async function assertClientAccess(actorUserId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

function metadata(record: EsgMetricDefinitionRecord): Record<string, unknown> {
  return {
    code: record.code,
    name: record.name,
    category: record.category,
    calculationMethod: record.calculationMethod,
    status: record.status,
    clientId: record.clientId,
    uomId: record.uomId,
  };
}

function isCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === UNIQUE_VIOLATION &&
    candidate.constraint === CLIENT_CODE_CONSTRAINT
  );
}

async function validateUom(
  uomId: string,
  clientId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<UomRow> {
  const result = await executor.query<UomRow>(
    `SELECT id, client_id, code, name, symbol, status FROM units_of_measure WHERE id = $1`,
    [uomId],
  );
  const row = result.rows[0];
  if (!row) {
    throw esgMetricDefinitionUomNotFoundError();
  }
  if (row.client_id !== clientId) {
    throw esgMetricDefinitionUomClientMismatchError();
  }
  if (row.status !== 'ACTIVE') {
    throw esgMetricDefinitionUomInactiveError();
  }
  return row;
}

export async function createEsgMetricDefinition(
  input: CreateEsgMetricDefinitionInput,
  actorUserId: string,
): Promise<PublicEsgMetricDefinition> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  await assertClientAccess(actorUserId, input.clientId);

  const existing = await esgMetricDefinitionRepository.findByCodeForClient(
    undefined,
    input.clientId,
    input.code,
  );
  if (existing) {
    throw esgMetricDefinitionCodeAlreadyExistsError();
  }

  if (input.uomId) {
    await validateUom(input.uomId, input.clientId);
  }

  const newEntry: NewEsgMetricDefinition = {
    clientId: input.clientId,
    code: input.code,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    category: input.category,
    uomId: input.uomId ?? null,
    calculationMethod: input.calculationMethod ?? 'MANUAL',
    createdByUserId: actorUserId,
  };

  try {
    return await withTransaction(async (tx) => {
      const record = await esgMetricDefinitionRepository.insert(tx, newEntry);

      await recordOperationalEvent(
        {
          clientId: record.clientId,
          eventType: 'ESG_METRIC_DEFINITION_CREATED',
          entityType: 'ESG_METRIC_DEFINITION',
          entityId: record.id,
          actorUserId,
          summary: `ESG metric definition ${record.code} created as ACTIVE.`,
          metadata: metadata(record),
        },
        tx,
      );

      return toPublic(record);
    });
  } catch (error) {
    if (isCodeUniqueViolation(error)) {
      throw esgMetricDefinitionCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getEsgMetricDefinition(
  id: string,
  actorUserId: string,
): Promise<PublicEsgMetricDefinition> {
  const record = await esgMetricDefinitionRepository.findById(undefined, id);
  if (!record) {
    throw esgMetricDefinitionNotFoundError();
  }
  await assertClientAccess(actorUserId, record.clientId);
  return toPublic(record);
}

export async function listEsgMetricDefinitions(
  filters: EsgMetricDefinitionFilters,
  actorUserId: string,
): Promise<PublicEsgMetricDefinition[]> {
  const accessibleClientIds = await getAccessibleClientIds(actorUserId);

  if (filters.clientId && !accessibleClientIds.includes(filters.clientId)) {
    return [];
  }

  const records = await esgMetricDefinitionRepository.listScoped(
    undefined,
    accessibleClientIds,
    filters,
  );
  return records.map(toPublic);
}

export async function updateEsgMetricDefinition(
  id: string,
  input: UpdateEsgMetricDefinitionInput,
  actorUserId: string,
): Promise<PublicEsgMetricDefinition> {
  const existing = await esgMetricDefinitionRepository.findById(undefined, id);
  if (!existing) {
    throw esgMetricDefinitionNotFoundError();
  }
  await assertClientAccess(actorUserId, existing.clientId);

  if (input.uomId !== undefined && input.uomId !== null) {
    await validateUom(input.uomId, existing.clientId);
  }

  return withTransaction(async (tx) => {
    const updated = await esgMetricDefinitionRepository.update(tx, id, {
      name: input.name?.trim(),
      category: input.category,
      calculationMethod: input.calculationMethod,
      description:
        input.description === undefined
          ? undefined
          : input.description === null
            ? null
            : input.description.trim() || null,
      uomId: input.uomId,
    });

    if (!updated) {
      throw esgMetricDefinitionNotFoundError();
    }

    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        eventType: 'ESG_METRIC_DEFINITION_UPDATED',
        entityType: 'ESG_METRIC_DEFINITION',
        entityId: updated.id,
        actorUserId,
        summary: `ESG metric definition ${updated.code} updated.`,
        metadata: metadata(updated),
      },
      tx,
    );

    return toPublic(updated);
  });
}

export async function deactivateEsgMetricDefinition(
  id: string,
  actorUserId: string,
): Promise<PublicEsgMetricDefinition> {
  const existing = await esgMetricDefinitionRepository.findById(undefined, id);
  if (!existing) {
    throw esgMetricDefinitionNotFoundError();
  }
  await assertClientAccess(actorUserId, existing.clientId);

  if (existing.status !== 'ACTIVE') {
    throw esgMetricDefinitionNotActiveError();
  }

  return withTransaction(async (tx) => {
    const deactivated = await esgMetricDefinitionRepository.deactivate(tx, id);
    if (!deactivated) {
      throw esgMetricDefinitionNotActiveError();
    }

    await recordOperationalEvent(
      {
        clientId: deactivated.clientId,
        eventType: 'ESG_METRIC_DEFINITION_DEACTIVATED',
        entityType: 'ESG_METRIC_DEFINITION',
        entityId: deactivated.id,
        actorUserId,
        summary: `ESG metric definition ${deactivated.code} deactivated.`,
        metadata: metadata(deactivated),
      },
      tx,
    );

    return toPublic(deactivated);
  });
}

export const esgMetricDefinitionService = {
  createEsgMetricDefinition,
  getEsgMetricDefinition,
  listEsgMetricDefinitions,
  updateEsgMetricDefinition,
  deactivateEsgMetricDefinition,
};
