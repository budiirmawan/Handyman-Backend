import {
  buildingConfigurationService,
} from '../building-configurations';
import { clientInactiveError } from '../clients';
import { clientConfigurationService } from '../client-configurations';
import {
  captureConfigurationVersion,
  resolveLifecycleEffectiveSnapshot,
} from '../configuration-versions';
import {
  cmsContentAlreadyExistsError,
  cmsContentNotFoundError,
} from './cms-content.errors';
import { cmsContentRepository } from './cms-content.repository';
import type {
  CmsContentFilters,
  CmsContentRecord,
  CmsContentScope,
  CmsContentType,
  CreateCmsContentInput,
  EffectiveCmsContent,
  NewCmsContent,
  PublicCmsContent,
  UpdateCmsContentInput,
} from './cms-content.types';
import {
  parseCreateCmsContentBody,
  parseUpdateCmsContentBody,
} from './cms-content.validation';

export function toPublicCmsContent(record: CmsContentRecord): PublicCmsContent {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    scopeType: record.scopeType,
    contentType: record.contentType,
    slug: record.slug,
    title: record.title,
    body: record.body,
    status: record.status,
    createdByUserId: record.createdByUserId,
    publishedAt: record.publishedAt?.toISOString() ?? null,
    publishedByUserId: record.publishedByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function versionCmsContent(
  content: PublicCmsContent,
  userId: string,
): Promise<PublicCmsContent> {
  await captureConfigurationVersion(
    {
      sourceType: 'CMS_CONTENT',
      sourceConfigurationId: content.id,
      clientId: content.clientId,
      buildingId: content.buildingId,
      status: content.status,
      snapshot: content,
    },
    userId,
  );
  return content;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === '23505'
  );
}

async function scopeContext(
  scope: CmsContentScope,
  scopeId: string,
  userId: string,
) {
  if (scope === 'CLIENT') {
    const client = await clientConfigurationService.resolveClientConfigurationContext(
      scopeId,
      userId,
    );
    return { clientId: client.id, clientStatus: client.status };
  }
  const context =
    await buildingConfigurationService.resolveBuildingConfigurationContext(
      scopeId,
      userId,
    );
  return { clientId: context.clientId, clientStatus: context.clientStatus };
}

async function requireRecord(
  id: string,
  expectedScope: CmsContentScope,
  userId: string,
): Promise<CmsContentRecord> {
  const record = await cmsContentRepository.findById(id);
  if (!record || record.scopeType !== expectedScope) {
    throw cmsContentNotFoundError();
  }
  await scopeContext(
    record.scopeType,
    record.scopeType === 'CLIENT' ? record.clientId : (record.buildingId as string),
    userId,
  );
  return record;
}

async function create(
  scope: CmsContentScope,
  scopeId: string,
  input: CreateCmsContentInput,
  userId: string,
): Promise<PublicCmsContent> {
  const validated = parseCreateCmsContentBody(input);
  const context = await scopeContext(scope, scopeId, userId);
  if (context.clientStatus !== 'ACTIVE') throw clientInactiveError();
  const publishing = validated.status === 'PUBLISHED';
  const next: NewCmsContent = {
    ...validated,
    scopeType: scope,
    clientId: scope === 'CLIENT' ? context.clientId : null,
    buildingId: scope === 'BUILDING' ? scopeId : null,
    createdByUserId: userId,
    publishedAt: publishing ? new Date() : null,
    publishedByUserId: publishing ? userId : null,
  };
  try {
    return versionCmsContent(
      toPublicCmsContent(await cmsContentRepository.create(next)),
      userId,
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw cmsContentAlreadyExistsError();
    throw error;
  }
}

export const createClientCmsContent = (
  clientId: string,
  input: CreateCmsContentInput,
  userId: string,
) => create('CLIENT', clientId, input, userId);

export const createBuildingCmsContent = (
  buildingId: string,
  input: CreateCmsContentInput,
  userId: string,
) => create('BUILDING', buildingId, input, userId);

async function list(
  scope: CmsContentScope,
  scopeId: string,
  filters: CmsContentFilters,
  userId: string,
): Promise<PublicCmsContent[]> {
  await scopeContext(scope, scopeId, userId);
  return (await cmsContentRepository.listByScope(scope, scopeId, filters)).map(
    toPublicCmsContent,
  );
}

export const listClientCmsContent = (
  clientId: string,
  filters: CmsContentFilters,
  userId: string,
) => list('CLIENT', clientId, filters, userId);

export const listBuildingCmsContent = (
  buildingId: string,
  filters: CmsContentFilters,
  userId: string,
) => list('BUILDING', buildingId, filters, userId);

export async function getClientCmsContentById(
  id: string,
  userId: string,
): Promise<PublicCmsContent> {
  return toPublicCmsContent(await requireRecord(id, 'CLIENT', userId));
}

export async function getBuildingCmsContentById(
  id: string,
  userId: string,
): Promise<PublicCmsContent> {
  return toPublicCmsContent(await requireRecord(id, 'BUILDING', userId));
}

async function update(
  id: string,
  scope: CmsContentScope,
  input: UpdateCmsContentInput,
  userId: string,
): Promise<PublicCmsContent> {
  const validated = parseUpdateCmsContentBody(input);
  const current = await requireRecord(id, scope, userId);
  const nextStatus = validated.status ?? current.status;
  const contentChanged =
    validated.title !== undefined || validated.body !== undefined;
  const publishing =
    nextStatus === 'PUBLISHED' &&
    (contentChanged || validated.status === 'PUBLISHED');
  const updated = await cmsContentRepository.update(id, {
    ...validated,
    ...(publishing
      ? { publishedAt: new Date(), publishedByUserId: userId }
      : {}),
  });
  if (!updated) throw cmsContentNotFoundError();
  return versionCmsContent(toPublicCmsContent(updated), userId);
}

export const updateClientCmsContent = (
  id: string,
  input: UpdateCmsContentInput,
  userId: string,
) => update(id, 'CLIENT', input, userId);

export const updateBuildingCmsContent = (
  id: string,
  input: UpdateCmsContentInput,
  userId: string,
) => update(id, 'BUILDING', input, userId);

async function lifecycleContent(
  record: CmsContentRecord,
): Promise<PublicCmsContent | null> {
  const current = toPublicCmsContent(record);
  const snapshot = await resolveLifecycleEffectiveSnapshot(
    'CMS_CONTENT',
    record.id,
    current,
  );
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    Array.isArray(snapshot) ||
    snapshot.status !== 'PUBLISHED' ||
    typeof snapshot.contentType !== 'string' ||
    typeof snapshot.slug !== 'string'
  ) {
    return null;
  }
  return snapshot as unknown as PublicCmsContent;
}

async function effective(
  clientId: string,
  buildingId: string | null,
  contentType: CmsContentType | undefined,
): Promise<EffectiveCmsContent> {
  const clientRecords = await cmsContentRepository.listByScope('CLIENT', clientId, {
    ...(contentType ? { contentType } : {}),
  });
  const merged = new Map<string, PublicCmsContent>();
  for (const record of clientRecords) {
    const content = await lifecycleContent(record);
    if (content) merged.set(`${content.contentType}:${content.slug}`, content);
  }
  if (buildingId) {
    const buildingRecords = await cmsContentRepository.listByScope(
      'BUILDING',
      buildingId,
      { ...(contentType ? { contentType } : {}) },
    );
    for (const record of buildingRecords) {
      const content = await lifecycleContent(record);
      if (content) merged.set(`${content.contentType}:${content.slug}`, content);
    }
  }
  return {
    clientId,
    buildingId,
    content: [...merged.values()].sort(
      (left, right) =>
        left.contentType.localeCompare(right.contentType) ||
        left.slug.localeCompare(right.slug),
    ),
  };
}

export async function getEffectiveClientCmsContent(
  clientId: string,
  contentType: CmsContentType | undefined,
  userId: string,
): Promise<EffectiveCmsContent> {
  const context = await scopeContext('CLIENT', clientId, userId);
  if (context.clientStatus !== 'ACTIVE') throw clientInactiveError();
  return effective(context.clientId, null, contentType);
}

export async function getEffectiveBuildingCmsContent(
  buildingId: string,
  contentType: CmsContentType | undefined,
  userId: string,
): Promise<EffectiveCmsContent> {
  const context = await scopeContext('BUILDING', buildingId, userId);
  if (context.clientStatus !== 'ACTIVE') throw clientInactiveError();
  return effective(context.clientId, buildingId, contentType);
}

export const cmsContentService = {
  createBuildingCmsContent,
  createClientCmsContent,
  getBuildingCmsContentById,
  getClientCmsContentById,
  getEffectiveBuildingCmsContent,
  getEffectiveClientCmsContent,
  listBuildingCmsContent,
  listClientCmsContent,
  updateBuildingCmsContent,
  updateClientCmsContent,
};
