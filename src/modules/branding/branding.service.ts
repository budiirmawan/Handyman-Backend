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
import { brandingConfigurationNotFoundError } from './branding.errors';
import type {
  BrandingProfile,
  CreateBrandingInput,
  EffectiveBranding,
  PublicBrandingConfiguration,
  UpdateBrandingInput,
} from './branding.types';
import {
  parseCreateBrandingBody,
  parseUpdateBrandingBody,
} from './branding.validation';

const CONFIGURATION_KEY = 'BRANDING.PROFILE';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function profileValue(profile: BrandingProfile): ClientConfigurationValue {
  return profile as unknown as ClientConfigurationValue;
}

function validateProfile(value: unknown): BrandingProfile {
  const parsed = parseCreateBrandingBody(
    isRecord(value) ? { ...value, status: 'ACTIVE' } : value,
  );
  return {
    brandName: parsed.brandName,
    logoReference: parsed.logoReference,
    login: parsed.login,
    portal: parsed.portal,
    report: parsed.report,
    theme: parsed.theme,
  };
}

function decodeProfile(value: ClientConfigurationValue): BrandingProfile {
  try {
    return validateProfile(value);
  } catch {
    throw AppError.internal('Branding Configuration is invalid.');
  }
}

function clientPublic(
  record: PublicClientConfiguration,
): PublicBrandingConfiguration {
  if (record.key !== CONFIGURATION_KEY) {
    throw brandingConfigurationNotFoundError();
  }
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: null,
    scopeType: 'CLIENT',
    ...decodeProfile(record.value),
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function buildingPublic(
  record: PublicBuildingConfiguration,
): PublicBrandingConfiguration {
  if (record.key !== CONFIGURATION_KEY) {
    throw brandingConfigurationNotFoundError();
  }
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    scopeType: 'BUILDING',
    ...decodeProfile(record.value),
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function createClientBranding(
  clientId: string,
  input: CreateBrandingInput,
  userId: string,
): Promise<PublicBrandingConfiguration> {
  const validated = parseCreateBrandingBody(input);
  const profile = validateProfile(validated);
  return clientPublic(
    await clientConfigurationService.createClientConfiguration(
      {
        clientId,
        key: CONFIGURATION_KEY,
        value: profileValue(profile),
        status: validated.status,
      },
      userId,
    ),
  );
}

export async function createBuildingBranding(
  buildingId: string,
  input: CreateBrandingInput,
  userId: string,
): Promise<PublicBrandingConfiguration> {
  const validated = parseCreateBrandingBody(input);
  const profile = validateProfile(validated);
  return buildingPublic(
    await buildingConfigurationService.createBuildingConfiguration(
      {
        buildingId,
        key: CONFIGURATION_KEY,
        value: profileValue(profile),
        status: validated.status,
      },
      userId,
    ),
  );
}

export async function getClientBrandingForScope(
  clientId: string,
  userId: string,
): Promise<PublicBrandingConfiguration> {
  const records = await clientConfigurationService.listClientConfigurations(
    clientId,
    {},
    userId,
    true,
  );
  const record = records.find((candidate) => candidate.key === CONFIGURATION_KEY);
  if (!record) throw brandingConfigurationNotFoundError();
  return clientPublic(record);
}

export async function getBuildingBrandingForScope(
  buildingId: string,
  userId: string,
): Promise<PublicBrandingConfiguration> {
  const records = await buildingConfigurationService.listBuildingConfigurations(
    buildingId,
    {},
    userId,
    true,
  );
  const record = records.find((candidate) => candidate.key === CONFIGURATION_KEY);
  if (!record) throw brandingConfigurationNotFoundError();
  return buildingPublic(record);
}

export async function getClientBrandingById(
  id: string,
  userId: string,
): Promise<PublicBrandingConfiguration> {
  return clientPublic(
    await clientConfigurationService.getClientConfigurationById(id, userId, true),
  );
}

export async function getBuildingBrandingById(
  id: string,
  userId: string,
): Promise<PublicBrandingConfiguration> {
  return buildingPublic(
    await buildingConfigurationService.getBuildingConfigurationById(
      id,
      userId,
      true,
    ),
  );
}

function mergeProfile(
  current: BrandingProfile,
  update: UpdateBrandingInput,
): BrandingProfile {
  return validateProfile({
    brandName: update.brandName ?? current.brandName,
    logoReference:
      update.logoReference === undefined
        ? current.logoReference
        : update.logoReference,
    login: { ...current.login, ...update.login },
    portal: { ...current.portal, ...update.portal },
    report: { ...current.report, ...update.report },
    theme: { ...current.theme, ...update.theme },
  });
}

export async function updateClientBranding(
  id: string,
  input: UpdateBrandingInput,
  userId: string,
): Promise<PublicBrandingConfiguration> {
  const validated = parseUpdateBrandingBody(input);
  const current = await getClientBrandingById(id, userId);
  const profile = mergeProfile(current, validated);
  return clientPublic(
    await clientConfigurationService.updateClientConfiguration(
      id,
      {
        ...(Object.keys(validated).some((key) => key !== 'status')
          ? { value: profileValue(profile) }
          : {}),
        ...(validated.status === undefined ? {} : { status: validated.status }),
      },
      userId,
      true,
    ),
  );
}

export async function updateBuildingBranding(
  id: string,
  input: UpdateBrandingInput,
  userId: string,
): Promise<PublicBrandingConfiguration> {
  const validated = parseUpdateBrandingBody(input);
  const current = await getBuildingBrandingById(id, userId);
  const profile = mergeProfile(current, validated);
  return buildingPublic(
    await buildingConfigurationService.updateBuildingConfiguration(
      id,
      {
        ...(Object.keys(validated).some((key) => key !== 'status')
          ? { value: profileValue(profile) }
          : {}),
        ...(validated.status === undefined ? {} : { status: validated.status }),
      },
      userId,
      true,
    ),
  );
}

export async function getEffectiveClientBranding(
  clientId: string,
  userId: string,
): Promise<EffectiveBranding> {
  const effective =
    await clientConfigurationService.getEffectiveClientConfiguration(
      clientId,
      userId,
      true,
    );
  const raw = effective.configurations[CONFIGURATION_KEY];
  return {
    clientId: effective.clientId,
    buildingId: null,
    branding: raw === undefined ? null : decodeProfile(raw),
  };
}

export async function getEffectiveBuildingBranding(
  buildingId: string,
  userId: string,
): Promise<EffectiveBranding> {
  const effective =
    await buildingConfigurationService.getEffectiveBuildingConfiguration(
      buildingId,
      userId,
      true,
    );
  const raw = effective.configurations[CONFIGURATION_KEY];
  return {
    clientId: effective.clientId,
    buildingId: effective.buildingId,
    branding: raw === undefined ? null : decodeProfile(raw),
  };
}

export const brandingService = {
  createBuildingBranding,
  createClientBranding,
  getBuildingBrandingById,
  getBuildingBrandingForScope,
  getClientBrandingById,
  getClientBrandingForScope,
  getEffectiveBuildingBranding,
  getEffectiveClientBranding,
  updateBuildingBranding,
  updateClientBranding,
};
