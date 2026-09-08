import { Buffer } from 'node:buffer';
import { AppError } from '../../shared/errors';
import { permissionDeniedError } from '../auth';
import { recordConfigurationAuditEvent } from '../configuration-audit/configuration-audit.service';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { permissionService } from '../permissions';
import {
  configurationLifecycleInvalidTransitionError,
  configurationValidationFailedError,
  configurationVersionNotFoundError,
} from './configuration-version.errors';
import { configurationVersionRepository } from './configuration-version.repository';
import type {
  CaptureConfigurationVersionInput,
  ConfigurationSnapshot,
  ConfigurationValidationError,
  ConfigurationValidationOutcome,
  ConfigurationValidationRecord,
  ConfigurationVersionRecord,
  ConfigurationVersionSourceType,
  PublicConfigurationValidation,
  PublicConfigurationVersion,
} from './configuration-version.types';

const STATUS = /^[A-Z][A-Z0-9_-]{0,63}$/;
const MAX_SNAPSHOT_BYTES = 1_048_576;

function normalizeSnapshot(value: unknown, depth = 0): ConfigurationSnapshot {
  if (depth > 30) throw AppError.internal('Configuration snapshot is too deep.');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeSnapshot(entry, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const snapshot: Record<string, ConfigurationSnapshot> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) snapshot[key] = normalizeSnapshot(entry, depth + 1);
    }
    return snapshot;
  }
  throw AppError.internal('Configuration snapshot is not JSON-safe.');
}

function normalizeCapture(
  input: CaptureConfigurationVersionInput,
): CaptureConfigurationVersionInput {
  const status = input.status.trim().toUpperCase();
  if (!STATUS.test(status)) {
    throw AppError.internal('Configuration version status is invalid.');
  }
  const snapshot = normalizeSnapshot(input.snapshot);
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw AppError.internal('Configuration snapshot exceeds the size limit.');
  }
  return { ...input, status, snapshot };
}

export function toPublicConfigurationVersion(
  record: ConfigurationVersionRecord,
): PublicConfigurationVersion {
  return { ...record, createdAt: record.createdAt.toISOString() };
}

/** Called by existing owning configuration services after successful writes. */
export async function captureConfigurationVersion(
  input: CaptureConfigurationVersionInput,
  createdByUserId: string,
): Promise<PublicConfigurationVersion> {
  const version = toPublicConfigurationVersion(
    await configurationVersionRepository.createNext(
      normalizeCapture(input),
      createdByUserId,
    ),
  );
  await recordConfigurationAuditEvent({
    configurationId: version.sourceConfigurationId,
    configurationVersionId: version.id,
    sourceType: version.sourceType,
    action:
      version.versionNumber === 1
        ? 'CONFIGURATION_DRAFT_CREATED'
        : 'CONFIGURATION_DRAFT_UPDATED',
    actorUserId: createdByUserId,
    clientId: version.clientId,
    buildingId: version.buildingId,
    previousStatus: null,
    newStatus: 'DRAFT',
    summary:
      version.versionNumber === 1
        ? `Configuration draft version ${version.versionNumber} created.`
        : `Configuration draft version ${version.versionNumber} saved.`,
    versionNumber: version.versionNumber,
    previousVersionId: version.previousVersionId,
  });
  return version;
}

/** Runtime adapters use ACTIVE snapshots; records without versions stay legacy-compatible. */
export async function resolveLifecycleEffectiveSnapshot(
  sourceType: ConfigurationVersionSourceType,
  sourceConfigurationId: string,
  currentSnapshot: unknown,
): Promise<ConfigurationSnapshot | null> {
  const versions = await configurationVersionRepository.listBySource(
    sourceType,
    sourceConfigurationId,
  );
  if (versions.length === 0) return normalizeSnapshot(currentSnapshot);
  return versions.find((version) => version.lifecycleStatus === 'ACTIVE')?.snapshot ?? null;
}

function requiredPermission(
  sourceType: ConfigurationVersionSourceType,
  buildingId: string | null,
  manage = false,
): string {
  const action = manage ? 'manage' : 'read';
  if (sourceType === 'CLIENT_CONFIGURATION') {
    return `client_configuration.${action}`;
  }
  if (sourceType === 'BUILDING_CONFIGURATION') {
    return `building_configuration.${action}`;
  }
  if (sourceType === 'MODULE_CONFIGURATION') {
    return `module_configuration.${action}`;
  }
  if (sourceType === 'FEATURE_ENTITLEMENT_CONFIGURATION') {
    return `feature_entitlement_configuration.${action}`;
  }
  if (sourceType === 'NAVIGATION_ITEM') return `navigation_registry.${action}`;
  if (sourceType === 'WORKSPACE') return `workspace_registry.${action}`;
  if (sourceType === 'DASHBOARD' || sourceType === 'DASHBOARD_WIDGET') {
    return `dashboard_configuration.${action}`;
  }
  return buildingId
    ? `building_configuration.${action}`
    : `client_configuration.${action}`;
}

async function assertVersionAccess(
  userId: string,
  sourceType: ConfigurationVersionSourceType,
  clientId: string | null,
  buildingId: string | null,
  manage = false,
): Promise<void> {
  const permissions = await permissionService.resolvePermissionsForUser(userId);
  if (!permissions.includes(requiredPermission(sourceType, buildingId, manage))) {
    throw permissionDeniedError();
  }
  if (buildingId) {
    await contextAccessService.assertBuildingAccess(userId, buildingId);
  } else if (clientId) {
    if (!(await contextAccessService.canAccessClient(userId, clientId))) {
      throw buildingAccessDeniedError();
    }
  }
}

export async function listConfigurationVersions(
  sourceType: ConfigurationVersionSourceType,
  sourceConfigurationId: string,
  userId: string,
): Promise<PublicConfigurationVersion[]> {
  const records = await configurationVersionRepository.listBySource(
    sourceType,
    sourceConfigurationId,
  );
  if (records.length === 0) {
    const permissions = await permissionService.resolvePermissionsForUser(userId);
    if (!permissions.includes(requiredPermission(sourceType, null))) {
      throw permissionDeniedError();
    }
    return [];
  }
  await assertVersionAccess(
    userId,
    sourceType,
    records[0].clientId,
    records[0].buildingId,
  );
  return records.map(toPublicConfigurationVersion);
}

export async function getConfigurationVersion(
  id: string,
  userId: string,
): Promise<PublicConfigurationVersion> {
  const record = await configurationVersionRepository.findById(id);
  if (!record) throw configurationVersionNotFoundError();
  await assertVersionAccess(
    userId,
    record.sourceType,
    record.clientId,
    record.buildingId,
  );
  return toPublicConfigurationVersion(record);
}

function toPublicValidation(
  record: ConfigurationValidationRecord,
): PublicConfigurationValidation {
  return { ...record, validatedAt: record.validatedAt.toISOString() };
}

export async function requireVersionForLifecycle(
  id: string,
  userId: string,
): Promise<ConfigurationVersionRecord> {
  const version = await configurationVersionRepository.findById(id);
  if (!version) throw configurationVersionNotFoundError();
  await assertVersionAccess(
    userId,
    version.sourceType,
    version.clientId,
    version.buildingId,
    true,
  );
  return version;
}

function validateVersionSnapshot(
  version: ConfigurationVersionRecord,
  source: { clientId: string; buildingId: string | null } | null,
): ConfigurationValidationError[] {
  const errors: ConfigurationValidationError[] = [];
  if (!source) {
    errors.push({
      code: 'SOURCE_NOT_FOUND',
      field: 'sourceConfigurationId',
      message: 'The authoritative source configuration no longer exists.',
    });
    return errors;
  }
  if (
    source.clientId !== version.clientId ||
    source.buildingId !== version.buildingId
  ) {
    errors.push({
      code: 'SCOPE_MISMATCH',
      field: 'scope',
      message: 'Version scope no longer matches the authoritative source.',
    });
  }
  if (
    typeof version.snapshot !== 'object' ||
    version.snapshot === null ||
    Array.isArray(version.snapshot)
  ) {
    errors.push({
      code: 'SNAPSHOT_INVALID',
      field: 'snapshot',
      message: 'Configuration snapshot must be a JSON object.',
    });
    return errors;
  }
  const snapshot = version.snapshot as Record<string, ConfigurationSnapshot>;
  if (snapshot.id !== version.sourceConfigurationId) {
    errors.push({
      code: 'SNAPSHOT_SOURCE_MISMATCH',
      field: 'snapshot.id',
      message: 'Snapshot id does not match its source configuration reference.',
    });
  }
  if (snapshot.clientId !== version.clientId) {
    errors.push({
      code: 'SNAPSHOT_SCOPE_MISMATCH',
      field: 'snapshot.clientId',
      message: 'Snapshot Client does not match version scope.',
    });
  }
  const snapshotBuilding = snapshot.buildingId ?? null;
  if (snapshotBuilding !== version.buildingId) {
    errors.push({
      code: 'SNAPSHOT_SCOPE_MISMATCH',
      field: 'snapshot.buildingId',
      message: 'Snapshot Building does not match version scope.',
    });
  }
  return errors;
}

export async function validateConfigurationVersion(
  id: string,
  userId: string,
): Promise<ConfigurationValidationOutcome> {
  const version = await requireVersionForLifecycle(id, userId);
  if (version.lifecycleStatus !== 'DRAFT') {
    throw configurationLifecycleInvalidTransitionError(
      'Only a DRAFT configuration version can be validated.',
    );
  }
  const source = await configurationVersionRepository.findSourceContext(
    version.sourceType,
    version.sourceConfigurationId,
  );
  const errors = validateVersionSnapshot(version, source);
  const validation = await configurationVersionRepository.addValidation(
    version.id,
    errors.length === 0,
    errors,
    userId,
  );
  const updated = await configurationVersionRepository.findById(version.id);
  if (!updated) throw configurationVersionNotFoundError();
  await recordConfigurationAuditEvent({
    configurationId: version.sourceConfigurationId,
    configurationVersionId: version.id,
    sourceType: version.sourceType,
    action:
      errors.length === 0
        ? 'CONFIGURATION_VALIDATION_SUCCEEDED'
        : 'CONFIGURATION_VALIDATION_FAILED',
    actorUserId: userId,
    clientId: version.clientId,
    buildingId: version.buildingId,
    previousStatus: 'DRAFT',
    newStatus: errors.length === 0 ? 'VALIDATED' : 'DRAFT',
    summary:
      errors.length === 0
        ? `Configuration version ${version.versionNumber} validated.`
        : `Configuration version ${version.versionNumber} validation failed.`,
    versionNumber: version.versionNumber,
    valid: errors.length === 0,
    validationErrorCodes: errors.map((error) => error.code),
  });
  return {
    version: toPublicConfigurationVersion(updated),
    validation: toPublicValidation(validation),
  };
}

export async function listConfigurationValidations(
  id: string,
  userId: string,
): Promise<PublicConfigurationValidation[]> {
  await getConfigurationVersion(id, userId);
  return (await configurationVersionRepository.listValidations(id)).map(
    toPublicValidation,
  );
}

export async function publishConfigurationVersion(
  id: string,
  userId: string,
): Promise<PublicConfigurationVersion> {
  const version = await requireVersionForLifecycle(id, userId);
  if (version.lifecycleStatus !== 'VALIDATED') {
    throw configurationLifecycleInvalidTransitionError(
      'Only a VALIDATED configuration version can be published.',
    );
  }
  const validations = await configurationVersionRepository.listValidations(id);
  const latest = validations.at(-1);
  if (!latest?.valid) {
    throw configurationValidationFailedError(latest?.errors ?? []);
  }
  const updated = await configurationVersionRepository.transition(
    id,
    'VALIDATED',
    'PUBLISHED',
    userId,
  );
  if (!updated) throw configurationLifecycleInvalidTransitionError();
  await recordConfigurationAuditEvent({
    configurationId: updated.sourceConfigurationId,
    configurationVersionId: updated.id,
    sourceType: updated.sourceType,
    action: 'CONFIGURATION_PUBLISHED',
    actorUserId: userId,
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    previousStatus: 'VALIDATED',
    newStatus: 'PUBLISHED',
    summary: `Configuration version ${updated.versionNumber} published.`,
    versionNumber: updated.versionNumber,
  });
  return toPublicConfigurationVersion(updated);
}

export async function activateConfigurationVersion(
  id: string,
  userId: string,
): Promise<PublicConfigurationVersion> {
  const version = await requireVersionForLifecycle(id, userId);
  if (version.lifecycleStatus !== 'PUBLISHED') {
    throw configurationLifecycleInvalidTransitionError(
      'Only a PUBLISHED configuration version can be activated.',
    );
  }
  const previousActive =
    await configurationVersionRepository.findActiveBySource(
      version.sourceType,
      version.sourceConfigurationId,
    );
  const updated = await configurationVersionRepository.activate(id, userId);
  if (!updated) throw configurationLifecycleInvalidTransitionError();
  if (previousActive && previousActive.id !== updated.id) {
    await recordConfigurationAuditEvent({
      configurationId: previousActive.sourceConfigurationId,
      configurationVersionId: previousActive.id,
      sourceType: previousActive.sourceType,
      action: 'CONFIGURATION_SUPERSEDED',
      actorUserId: userId,
      clientId: previousActive.clientId,
      buildingId: previousActive.buildingId,
      previousStatus: 'ACTIVE',
      newStatus: 'SUPERSEDED',
      summary: `Configuration version ${previousActive.versionNumber} superseded.`,
      versionNumber: previousActive.versionNumber,
    });
  }
  await recordConfigurationAuditEvent({
    configurationId: updated.sourceConfigurationId,
    configurationVersionId: updated.id,
    sourceType: updated.sourceType,
    action: 'CONFIGURATION_ACTIVATED',
    actorUserId: userId,
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    previousStatus: 'PUBLISHED',
    newStatus: 'ACTIVE',
    summary: `Configuration version ${updated.versionNumber} activated.`,
    versionNumber: updated.versionNumber,
    previousVersionId: previousActive?.id ?? null,
  });
  return toPublicConfigurationVersion(updated);
}

export async function createDraftFromConfigurationVersion(
  id: string,
  userId: string,
): Promise<PublicConfigurationVersion> {
  const version = await requireVersionForLifecycle(id, userId);
  return captureConfigurationVersion(
    {
      sourceType: version.sourceType,
      sourceConfigurationId: version.sourceConfigurationId,
      clientId: version.clientId,
      buildingId: version.buildingId,
      status: version.status,
      snapshot: version.snapshot,
    },
    userId,
  );
}

export const configurationVersionService = {
  activateConfigurationVersion,
  captureConfigurationVersion,
  createDraftFromConfigurationVersion,
  getConfigurationVersion,
  listConfigurationValidations,
  listConfigurationVersions,
  publishConfigurationVersion,
  validateConfigurationVersion,
};
