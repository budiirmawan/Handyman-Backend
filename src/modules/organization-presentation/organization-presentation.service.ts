import { AppError } from '../../shared/errors';
import {
  buildingConfigurationService,
  type PublicBuildingConfiguration,
} from '../building-configurations';
import {
  clientConfigurationService,
  type ClientConfigurationValue,
  type PublicClientConfiguration,
} from '../client-configurations';
import { departmentRepository } from '../departments';
import { organizationRepository } from '../organizations';
import { positionRepository } from '../positions';
import { teamRepository } from '../teams';
import {
  organizationPresentationNotFoundError,
  organizationPresentationReferenceInvalidError,
} from './organization-presentation.errors';
import {
  type CreateOrganizationPresentationInput,
  type EffectiveOrganizationPresentation,
  type EffectiveOrganizationPresentationItem,
  type OrganizationPresentationEntityType,
  type OrganizationPresentationItem,
  type OrganizationPresentationLabels,
  type OrganizationPresentationPayload,
  type PublicOrganizationPresentation,
  type UpdateOrganizationPresentationInput,
} from './organization-presentation.types';
import { parseCreateOrganizationPresentationBody } from './organization-presentation.validation';

const CONFIGURATION_KEY = 'PRESENTATION.ORGANIZATION';
const DEFAULT_LABELS = {
  organization: 'Organization',
  department: 'Department',
  team: 'Team',
  position: 'Position',
} as const;

type ResolvedEntity = {
  entityType: OrganizationPresentationEntityType;
  entityId: string;
  code: string;
  name: string;
  organizationId: string;
  departmentId: string | null;
  available: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadValue(payload: OrganizationPresentationPayload): ClientConfigurationValue {
  return payload as unknown as ClientConfigurationValue;
}

function validatePayload(
  labels: unknown,
  items: unknown,
): OrganizationPresentationPayload {
  const parsed = parseCreateOrganizationPresentationBody({
    labels,
    items,
    status: 'ACTIVE',
  });
  return { labels: parsed.labels, items: parsed.items };
}

function decodePayload(value: ClientConfigurationValue): OrganizationPresentationPayload {
  if (!isRecord(value)) {
    throw AppError.internal('Organization Presentation Configuration is invalid.');
  }
  try {
    return validatePayload(value.labels, value.items);
  } catch {
    throw AppError.internal('Organization Presentation Configuration is invalid.');
  }
}

function clientPublic(
  record: PublicClientConfiguration,
): PublicOrganizationPresentation {
  if (record.key !== CONFIGURATION_KEY) {
    throw organizationPresentationNotFoundError();
  }
  const payload = decodePayload(record.value);
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: null,
    scopeType: 'CLIENT',
    labels: payload.labels,
    items: payload.items,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function buildingPublic(
  record: PublicBuildingConfiguration,
): PublicOrganizationPresentation {
  if (record.key !== CONFIGURATION_KEY) {
    throw organizationPresentationNotFoundError();
  }
  const payload = decodePayload(record.value);
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    scopeType: 'BUILDING',
    labels: payload.labels,
    items: payload.items,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function resolveEntity(
  item: OrganizationPresentationItem,
  clientId: string,
  strict: boolean,
): Promise<ResolvedEntity | null> {
  const invalid = (): null => {
    if (strict) {
      throw organizationPresentationReferenceInvalidError(
        'items',
        'Every entity must exist, match entityType, and belong to the selected Client.',
      );
    }
    return null;
  };

  if (item.entityType === 'ORGANIZATION') {
    const organization = await organizationRepository.findById(item.entityId);
    if (!organization || organization.clientId !== clientId) return invalid();
    return {
      entityType: item.entityType,
      entityId: item.entityId,
      code: organization.code,
      name: organization.name,
      organizationId: organization.id,
      departmentId: null,
      available: organization.status === 'ACTIVE',
    };
  }

  if (item.entityType === 'DEPARTMENT') {
    const department = await departmentRepository.findById(item.entityId);
    if (!department) return invalid();
    const organization = await organizationRepository.findById(
      department.organizationId,
    );
    if (!organization || organization.clientId !== clientId) return invalid();
    return {
      entityType: item.entityType,
      entityId: item.entityId,
      code: department.code,
      name: department.name,
      organizationId: organization.id,
      departmentId: department.id,
      available:
        organization.status === 'ACTIVE' && department.status === 'ACTIVE',
    };
  }

  if (item.entityType === 'TEAM') {
    const team = await teamRepository.findById(item.entityId);
    if (!team) return invalid();
    const department = await departmentRepository.findById(team.departmentId);
    if (!department) return invalid();
    const organization = await organizationRepository.findById(
      department.organizationId,
    );
    if (!organization || organization.clientId !== clientId) return invalid();
    return {
      entityType: item.entityType,
      entityId: item.entityId,
      code: team.code,
      name: team.name,
      organizationId: organization.id,
      departmentId: department.id,
      available:
        organization.status === 'ACTIVE' &&
        department.status === 'ACTIVE' &&
        team.status === 'ACTIVE',
    };
  }

  const position = await positionRepository.findById(item.entityId);
  if (!position) return invalid();
  const organization = await organizationRepository.findById(
    position.organizationId,
  );
  if (!organization || organization.clientId !== clientId) return invalid();
  const department = position.departmentId
    ? await departmentRepository.findById(position.departmentId)
    : null;
  if (
    position.departmentId &&
    (!department || department.organizationId !== organization.id)
  ) {
    return invalid();
  }
  return {
    entityType: item.entityType,
    entityId: item.entityId,
    code: position.code,
    name: position.name,
    organizationId: organization.id,
    departmentId: department?.id ?? null,
    available:
      organization.status === 'ACTIVE' &&
      position.status === 'ACTIVE' &&
      (!department || department.status === 'ACTIVE'),
  };
}

async function validateReferences(
  items: OrganizationPresentationItem[],
  clientId: string,
): Promise<void> {
  for (const item of items) await resolveEntity(item, clientId, true);
}

function mergeLabels(
  current: OrganizationPresentationLabels,
  updates: UpdateOrganizationPresentationInput['labels'],
): OrganizationPresentationLabels {
  return updates ? { ...current, ...updates } : current;
}

export async function createClientOrganizationPresentation(
  clientId: string,
  input: CreateOrganizationPresentationInput,
  userId: string,
): Promise<PublicOrganizationPresentation> {
  await clientConfigurationService.resolveClientConfigurationContext(
    clientId,
    userId,
  );
  const payload = validatePayload(input.labels, input.items);
  await validateReferences(payload.items, clientId);
  return clientPublic(
    await clientConfigurationService.createClientConfiguration(
      {
        clientId,
        key: CONFIGURATION_KEY,
        value: payloadValue(payload),
        status: input.status,
      },
      userId,
    ),
  );
}

export async function createBuildingOrganizationPresentation(
  buildingId: string,
  input: CreateOrganizationPresentationInput,
  userId: string,
): Promise<PublicOrganizationPresentation> {
  const context =
    await buildingConfigurationService.resolveBuildingConfigurationContext(
      buildingId,
      userId,
    );
  const payload = validatePayload(input.labels, input.items);
  await validateReferences(payload.items, context.clientId);
  return buildingPublic(
    await buildingConfigurationService.createBuildingConfiguration(
      {
        buildingId,
        key: CONFIGURATION_KEY,
        value: payloadValue(payload),
        status: input.status,
      },
      userId,
    ),
  );
}

export async function getClientOrganizationPresentationForScope(
  clientId: string,
  userId: string,
): Promise<PublicOrganizationPresentation> {
  const records = await clientConfigurationService.listClientConfigurations(
    clientId,
    {},
    userId,
    true,
  );
  const record = records.find((candidate) => candidate.key === CONFIGURATION_KEY);
  if (!record) throw organizationPresentationNotFoundError();
  return clientPublic(record);
}

export async function getBuildingOrganizationPresentationForScope(
  buildingId: string,
  userId: string,
): Promise<PublicOrganizationPresentation> {
  const records = await buildingConfigurationService.listBuildingConfigurations(
    buildingId,
    {},
    userId,
    true,
  );
  const record = records.find((candidate) => candidate.key === CONFIGURATION_KEY);
  if (!record) throw organizationPresentationNotFoundError();
  return buildingPublic(record);
}

export async function getClientOrganizationPresentationById(
  id: string,
  userId: string,
): Promise<PublicOrganizationPresentation> {
  return clientPublic(
    await clientConfigurationService.getClientConfigurationById(id, userId, true),
  );
}

export async function getBuildingOrganizationPresentationById(
  id: string,
  userId: string,
): Promise<PublicOrganizationPresentation> {
  return buildingPublic(
    await buildingConfigurationService.getBuildingConfigurationById(
      id,
      userId,
      true,
    ),
  );
}

export async function updateClientOrganizationPresentation(
  id: string,
  input: UpdateOrganizationPresentationInput,
  userId: string,
): Promise<PublicOrganizationPresentation> {
  const current = await getClientOrganizationPresentationById(id, userId);
  const payload = validatePayload(
    mergeLabels(current.labels, input.labels),
    input.items ?? current.items,
  );
  await validateReferences(payload.items, current.clientId);
  return clientPublic(
    await clientConfigurationService.updateClientConfiguration(
      id,
      {
        ...(input.labels !== undefined || input.items !== undefined
          ? { value: payloadValue(payload) }
          : {}),
        ...(input.status === undefined ? {} : { status: input.status }),
      },
      userId,
      true,
    ),
  );
}

export async function updateBuildingOrganizationPresentation(
  id: string,
  input: UpdateOrganizationPresentationInput,
  userId: string,
): Promise<PublicOrganizationPresentation> {
  const current = await getBuildingOrganizationPresentationById(id, userId);
  const payload = validatePayload(
    mergeLabels(current.labels, input.labels),
    input.items ?? current.items,
  );
  await validateReferences(payload.items, current.clientId);
  return buildingPublic(
    await buildingConfigurationService.updateBuildingConfiguration(
      id,
      {
        ...(input.labels !== undefined || input.items !== undefined
          ? { value: payloadValue(payload) }
          : {}),
        ...(input.status === undefined ? {} : { status: input.status }),
      },
      userId,
      true,
    ),
  );
}

async function effectiveItems(
  payload: OrganizationPresentationPayload,
  clientId: string,
): Promise<EffectiveOrganizationPresentationItem[]> {
  const items: EffectiveOrganizationPresentationItem[] = [];
  for (const configured of payload.items) {
    const entity = await resolveEntity(configured, clientId, false);
    if (!entity) continue;
    items.push({
      ...configured,
      code: entity.code,
      authoritativeName: entity.name,
      effectiveDisplayName: configured.displayName ?? entity.name,
      organizationId: entity.organizationId,
      departmentId: entity.departmentId,
      available: entity.available,
      visible: configured.visible && entity.available,
    });
  }
  return items.sort(
    (left, right) =>
      left.displayOrder - right.displayOrder ||
      left.entityType.localeCompare(right.entityType) ||
      left.code.localeCompare(right.code),
  );
}

function effectiveLabels(labels: OrganizationPresentationLabels) {
  return {
    organization: labels.organization ?? DEFAULT_LABELS.organization,
    department: labels.department ?? DEFAULT_LABELS.department,
    team: labels.team ?? DEFAULT_LABELS.team,
    position: labels.position ?? DEFAULT_LABELS.position,
  };
}

export async function getEffectiveClientOrganizationPresentation(
  clientId: string,
  userId: string,
): Promise<EffectiveOrganizationPresentation> {
  const effective =
    await clientConfigurationService.getEffectiveClientConfiguration(
      clientId,
      userId,
      true,
    );
  const raw = effective.configurations[CONFIGURATION_KEY];
  const payload = raw
    ? decodePayload(raw)
    : {
        labels: { organization: null, department: null, team: null, position: null },
        items: [],
      };
  return {
    clientId: effective.clientId,
    buildingId: null,
    labels: effectiveLabels(payload.labels),
    items: await effectiveItems(payload, effective.clientId),
  };
}

export async function getEffectiveBuildingOrganizationPresentation(
  buildingId: string,
  userId: string,
): Promise<EffectiveOrganizationPresentation> {
  const effective =
    await buildingConfigurationService.getEffectiveBuildingConfiguration(
      buildingId,
      userId,
      true,
    );
  const raw = effective.configurations[CONFIGURATION_KEY];
  const payload = raw
    ? decodePayload(raw)
    : {
        labels: { organization: null, department: null, team: null, position: null },
        items: [],
      };
  return {
    clientId: effective.clientId,
    buildingId: effective.buildingId,
    labels: effectiveLabels(payload.labels),
    items: await effectiveItems(payload, effective.clientId),
  };
}

export const organizationPresentationService = {
  createBuildingOrganizationPresentation,
  createClientOrganizationPresentation,
  getBuildingOrganizationPresentationById,
  getBuildingOrganizationPresentationForScope,
  getClientOrganizationPresentationById,
  getClientOrganizationPresentationForScope,
  getEffectiveBuildingOrganizationPresentation,
  getEffectiveClientOrganizationPresentation,
  updateBuildingOrganizationPresentation,
  updateClientOrganizationPresentation,
};
