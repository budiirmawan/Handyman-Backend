import { permissionDeniedError } from '../auth';
import { recordConfigurationAuditEvent } from '../configuration-audit/configuration-audit.service';
import { buildingConfigurationService } from '../building-configurations';
import { clientConfigurationService } from '../client-configurations';
import {
  requireVersionForLifecycle,
} from '../configuration-versions';
import { toPublicConfigurationVersion } from '../configuration-versions/configuration-version.service';
import { getPreviewNavigation } from '../navigation-registry';
import { getPreviewWorkspaces } from '../workspace-registry';
import {
  configurationPreviewExpiredError,
  configurationPreviewNotFoundError,
  configurationPreviewRevokedError,
  configurationPreviewVersionNotValidatedError,
} from './configuration-preview.errors';
import { configurationPreviewRepository } from './configuration-preview.repository';
import type {
  ConfigurationPreviewContextRecord,
  CreateConfigurationPreviewInput,
  EffectiveConfigurationPreview,
  PreviewEffectiveConfiguration,
  PublicConfigurationPreviewContext,
} from './configuration-preview.types';

function publicContext(
  record: ConfigurationPreviewContextRecord,
): PublicConfigurationPreviewContext {
  const expired = record.status === 'ACTIVE' && record.expiresAt <= new Date();
  return {
    id: record.id,
    configurationVersionId: record.configurationVersionId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    createdByUserId: record.createdByUserId,
    mode: 'PREVIEW',
    status: expired ? 'EXPIRED' : record.status,
    expiresAt: record.expiresAt.toISOString(),
    revokedAt: record.revokedAt?.toISOString() ?? null,
    revokedByUserId: record.revokedByUserId,
    createdAt: record.createdAt.toISOString(),
  };
}

async function ownedContext(
  id: string,
  userId: string,
): Promise<ConfigurationPreviewContextRecord> {
  const context = await configurationPreviewRepository.findById(id);
  if (!context) throw configurationPreviewNotFoundError();
  if (context.createdByUserId !== userId) throw permissionDeniedError();
  return context;
}

function assertUsable(context: ConfigurationPreviewContextRecord): void {
  if (context.status === 'REVOKED') throw configurationPreviewRevokedError();
  if (context.expiresAt <= new Date()) throw configurationPreviewExpiredError();
}

function assertPreviewable(lifecycleStatus: string): void {
  if (lifecycleStatus !== 'VALIDATED' && lifecycleStatus !== 'PUBLISHED') {
    throw configurationPreviewVersionNotValidatedError();
  }
}

export async function createConfigurationPreview(
  configurationVersionId: string,
  input: CreateConfigurationPreviewInput,
  userId: string,
): Promise<PublicConfigurationPreviewContext> {
  const version = await requireVersionForLifecycle(configurationVersionId, userId);
  assertPreviewable(version.lifecycleStatus);
  const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000);
  const context = await configurationPreviewRepository.create({
    configurationVersionId: version.id,
    clientId: version.clientId,
    buildingId: version.buildingId,
    createdByUserId: userId,
    expiresAt,
  });
  await recordConfigurationAuditEvent({
    configurationId: version.sourceConfigurationId,
    configurationVersionId: version.id,
    sourceType: version.sourceType,
    action: 'CONFIGURATION_PREVIEW_CREATED',
    actorUserId: userId,
    clientId: version.clientId,
    buildingId: version.buildingId,
    previousStatus: null,
    newStatus: 'ACTIVE',
    summary: `Preview context created for configuration version ${version.versionNumber}.`,
    versionNumber: version.versionNumber,
    previewContextId: context.id,
    previewStatus: 'ACTIVE',
  });
  return publicContext(context);
}

export async function getConfigurationPreview(
  id: string,
  userId: string,
): Promise<PublicConfigurationPreviewContext> {
  const context = await ownedContext(id, userId);
  await requireVersionForLifecycle(context.configurationVersionId, userId);
  return publicContext(context);
}

export async function revokeConfigurationPreview(
  id: string,
  userId: string,
): Promise<PublicConfigurationPreviewContext> {
  const context = await ownedContext(id, userId);
  const version = await requireVersionForLifecycle(
    context.configurationVersionId,
    userId,
  );
  if (context.status === 'REVOKED') return publicContext(context);
  const revoked = await configurationPreviewRepository.revoke(id, userId);
  if (!revoked) throw configurationPreviewNotFoundError();
  await recordConfigurationAuditEvent({
    configurationId: version.sourceConfigurationId,
    configurationVersionId: version.id,
    sourceType: version.sourceType,
    action: 'CONFIGURATION_PREVIEW_REVOKED',
    actorUserId: userId,
    clientId: version.clientId,
    buildingId: version.buildingId,
    previousStatus: 'ACTIVE',
    newStatus: 'REVOKED',
    summary: `Preview context revoked for configuration version ${version.versionNumber}.`,
    versionNumber: version.versionNumber,
    previewContextId: revoked.id,
    previewStatus: 'REVOKED',
  });
  return publicContext(revoked);
}

async function previewConfiguration(
  sourceType: string,
  snapshot: unknown,
  clientId: string,
  buildingId: string | null,
  userId: string,
): Promise<PreviewEffectiveConfiguration | null> {
  if (
    sourceType !== 'CLIENT_CONFIGURATION' &&
    sourceType !== 'BUILDING_CONFIGURATION'
  ) {
    return null;
  }
  const effective = buildingId
    ? await buildingConfigurationService.getEffectiveBuildingConfiguration(
        buildingId,
        userId,
        true,
      )
    : await clientConfigurationService.getEffectiveClientConfiguration(
        clientId,
        userId,
        true,
      );
  const configurations: Record<string, unknown> = {
    ...effective.configurations,
  };
  if (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    !Array.isArray(snapshot)
  ) {
    const candidate = snapshot as Record<string, unknown>;
    if (typeof candidate.key === 'string') {
      if (candidate.status === 'ACTIVE') {
        configurations[candidate.key] = candidate.value;
      } else if (sourceType === 'CLIENT_CONFIGURATION') {
        delete configurations[candidate.key];
      }
    }
  }
  return { clientId, buildingId, configurations };
}

export async function getEffectiveConfigurationPreview(
  id: string,
  userId: string,
): Promise<EffectiveConfigurationPreview> {
  const context = await ownedContext(id, userId);
  assertUsable(context);
  const version = await requireVersionForLifecycle(
    context.configurationVersionId,
    userId,
  );
  assertPreviewable(version.lifecycleStatus);
  if (
    version.clientId !== context.clientId ||
    version.buildingId !== context.buildingId
  ) {
    throw configurationPreviewNotFoundError();
  }
  const configuration = await previewConfiguration(
    version.sourceType,
    version.snapshot,
    context.clientId,
    context.buildingId,
    userId,
  );
  const navigation =
    version.sourceType === 'NAVIGATION_ITEM'
      ? await getPreviewNavigation(
          version.sourceConfigurationId,
          version.snapshot,
          context.clientId,
          context.buildingId,
          userId,
        )
      : null;
  const workspaces =
    version.sourceType === 'WORKSPACE'
      ? await getPreviewWorkspaces(
          version.sourceConfigurationId,
          version.snapshot,
          context.clientId,
          context.buildingId,
          userId,
        )
      : null;
  await recordConfigurationAuditEvent({
    configurationId: version.sourceConfigurationId,
    configurationVersionId: version.id,
    sourceType: version.sourceType,
    action: 'CONFIGURATION_PREVIEW_ACCESSED',
    actorUserId: userId,
    clientId: version.clientId,
    buildingId: version.buildingId,
    previousStatus: null,
    newStatus: null,
    summary: `Preview context accessed for configuration version ${version.versionNumber}.`,
    versionNumber: version.versionNumber,
    previewContextId: context.id,
    previewStatus: 'ACTIVE',
  });
  return {
    mode: 'PREVIEW',
    context: publicContext(context),
    version: toPublicConfigurationVersion(version),
    sourceSnapshot: version.snapshot,
    configuration,
    navigation,
    workspaces,
  };
}

export const configurationPreviewService = {
  createConfigurationPreview,
  getConfigurationPreview,
  getEffectiveConfigurationPreview,
  revokeConfigurationPreview,
};
