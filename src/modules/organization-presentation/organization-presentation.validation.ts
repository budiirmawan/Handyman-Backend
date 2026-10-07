import { AppError } from '../../shared/errors';
import {
  CLIENT_CONFIGURATION_STATUSES,
  isClientConfigurationStatus,
} from '../client-configurations';
import { isValidUuid } from '../clients';
import {
  ORGANIZATION_PRESENTATION_ENTITY_TYPES,
  type CreateOrganizationPresentationInput,
  type OrganizationPresentationEntityType,
  type OrganizationPresentationItem,
  type OrganizationPresentationLabels,
  type OrganizationPresentationLabelsInput,
  type OrganizationPresentationStatus,
  type UpdateOrganizationPresentationInput,
} from './organization-presentation.types';

type Detail = { field: string; message: string };
const LABEL_KEYS = ['organization', 'department', 'team', 'position'] as const;
const MAX_ITEMS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return normalized;
}

export const parseOrganizationPresentationClientId = (value: string): string =>
  parseUuid(value, 'clientId');
export const parseOrganizationPresentationBuildingId = (value: string): string =>
  parseUuid(value, 'buildingId');
export const parseOrganizationPresentationId = (value: string): string =>
  parseUuid(value, 'organizationPresentationId');

function readNullableLabel(
  value: unknown,
  field: string,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }
  const normalized = value.trim();
  if (normalized === '' || normalized.length > 160) {
    details.push({
      field,
      message: `${field} must contain 1 to 160 characters, or be null.`,
    });
    return undefined;
  }
  return normalized;
}

function readLabels(
  value: unknown,
  details: Detail[],
  partial: boolean,
): OrganizationPresentationLabels | OrganizationPresentationLabelsInput | undefined {
  if (value === undefined) {
    return partial
      ? undefined
      : { organization: null, department: null, team: null, position: null };
  }
  if (!isRecord(value)) {
    details.push({ field: 'labels', message: 'labels must be a JSON object.' });
    return undefined;
  }
  for (const field of Object.keys(value)) {
    if (!(LABEL_KEYS as readonly string[]).includes(field)) {
      details.push({ field: `labels.${field}`, message: `${field} is not allowed.` });
    }
  }
  if (partial && Object.keys(value).length === 0) {
    details.push({ field: 'labels', message: 'labels must include an override.' });
  }
  const result: OrganizationPresentationLabelsInput = {};
  for (const key of LABEL_KEYS) {
    const label = readNullableLabel(value[key], `labels.${key}`, details);
    if (label !== undefined) result[key] = label;
  }
  if (partial) return result;
  return {
    organization: result.organization ?? null,
    department: result.department ?? null,
    team: result.team ?? null,
    position: result.position ?? null,
  };
}

function readEntityType(
  value: unknown,
  field: string,
  details: Detail[],
): OrganizationPresentationEntityType | undefined {
  if (
    typeof value === 'string' &&
    (ORGANIZATION_PRESENTATION_ENTITY_TYPES as readonly string[]).includes(value)
  ) {
    return value as OrganizationPresentationEntityType;
  }
  details.push({
    field,
    message: `entityType must be one of: ${ORGANIZATION_PRESENTATION_ENTITY_TYPES.join(', ')}.`,
  });
  return undefined;
}

function readItems(
  value: unknown,
  details: Detail[],
): OrganizationPresentationItem[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    details.push({
      field: 'items',
      message: `items must be an array with at most ${MAX_ITEMS} entries.`,
    });
    return undefined;
  }
  const items: OrganizationPresentationItem[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const prefix = `items[${index}]`;
    if (!isRecord(entry)) {
      details.push({ field: prefix, message: 'item must be a JSON object.' });
      return;
    }
    for (const field of Object.keys(entry)) {
      if (
        !['entityType', 'entityId', 'displayName', 'displayOrder', 'visible'].includes(
          field,
        )
      ) {
        details.push({ field: `${prefix}.${field}`, message: `${field} is not allowed.` });
      }
    }
    const entityType = readEntityType(
      entry.entityType,
      `${prefix}.entityType`,
      details,
    );
    let entityId: string | undefined;
    if (typeof entry.entityId !== 'string' || !isValidUuid(entry.entityId.trim())) {
      details.push({
        field: `${prefix}.entityId`,
        message: 'entityId must be a valid UUID.',
      });
    } else {
      entityId = entry.entityId.trim().toLowerCase();
    }
    const displayName = readNullableLabel(
      entry.displayName,
      `${prefix}.displayName`,
      details,
    );
    const displayOrder = entry.displayOrder ?? index;
    if (
      !Number.isInteger(displayOrder) ||
      Number(displayOrder) < 0 ||
      Number(displayOrder) > 1_000_000
    ) {
      details.push({
        field: `${prefix}.displayOrder`,
        message: 'displayOrder must be an integer between 0 and 1000000.',
      });
    }
    const visible = entry.visible ?? true;
    if (typeof visible !== 'boolean') {
      details.push({
        field: `${prefix}.visible`,
        message: 'visible must be boolean.',
      });
    }
    if (entityType && entityId) {
      const identity = `${entityType}:${entityId}`;
      if (seen.has(identity)) {
        details.push({
          field: prefix,
          message: 'Each entity may appear only once.',
        });
      } else {
        seen.add(identity);
        items.push({
          entityType,
          entityId,
          displayName: displayName ?? null,
          displayOrder: Number(displayOrder),
          visible: visible as boolean,
        });
      }
    }
  });
  return items;
}

function readStatus(
  value: unknown,
  details: Detail[],
): OrganizationPresentationStatus | undefined {
  if (value === undefined) return undefined;
  if (!isClientConfigurationStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${CLIENT_CONFIGURATION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

export function parseCreateOrganizationPresentationBody(
  body: unknown,
): CreateOrganizationPresentationInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: Detail[] = [];
  for (const field of Object.keys(body)) {
    if (!['labels', 'items', 'status'].includes(field)) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
  const labels = readLabels(body.labels, details, false);
  const items = readItems(body.items ?? [], details);
  const status = readStatus(body.status, details) ?? 'ACTIVE';
  if (details.length > 0 || !labels || !items) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    labels: labels as OrganizationPresentationLabels,
    items,
    status,
  };
}

export function parseUpdateOrganizationPresentationBody(
  body: unknown,
): UpdateOrganizationPresentationInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: Detail[] = [];
  for (const field of Object.keys(body)) {
    if (!['labels', 'items', 'status'].includes(field)) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
  const labels = readLabels(body.labels, details, true);
  const items = readItems(body.items, details);
  const status = readStatus(body.status, details);
  if (
    body.labels === undefined &&
    body.items === undefined &&
    body.status === undefined &&
    details.length === 0
  ) {
    details.push({ field: 'body', message: 'At least one field is required.' });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    ...(labels === undefined
      ? {}
      : { labels: labels as OrganizationPresentationLabelsInput }),
    ...(items === undefined ? {} : { items }),
    ...(status === undefined ? {} : { status }),
  };
}
