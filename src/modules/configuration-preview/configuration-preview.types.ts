import type { PublicConfigurationVersion } from '../configuration-versions';
import type { EffectiveNavigation } from '../navigation-registry/navigation-registry.types';
import type { EffectiveWorkspaces } from '../workspace-registry/workspace-registry.types';

export type ConfigurationPreviewStoredStatus = 'ACTIVE' | 'REVOKED';
export type ConfigurationPreviewStatus =
  | ConfigurationPreviewStoredStatus
  | 'EXPIRED';

export type ConfigurationPreviewContextRecord = {
  id: string;
  configurationVersionId: string;
  clientId: string;
  buildingId: string | null;
  createdByUserId: string;
  status: ConfigurationPreviewStoredStatus;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  createdAt: Date;
};

export type PublicConfigurationPreviewContext = Omit<
  ConfigurationPreviewContextRecord,
  'status' | 'expiresAt' | 'revokedAt' | 'createdAt'
> & {
  mode: 'PREVIEW';
  status: ConfigurationPreviewStatus;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};

export type CreateConfigurationPreviewInput = {
  expiresInMinutes: number;
};

export type PreviewEffectiveConfiguration = {
  clientId: string;
  buildingId: string | null;
  configurations: Record<string, unknown>;
};

export type EffectiveConfigurationPreview = {
  mode: 'PREVIEW';
  context: PublicConfigurationPreviewContext;
  version: PublicConfigurationVersion;
  sourceSnapshot: unknown;
  configuration: PreviewEffectiveConfiguration | null;
  navigation: EffectiveNavigation | null;
  workspaces: EffectiveWorkspaces | null;
};
