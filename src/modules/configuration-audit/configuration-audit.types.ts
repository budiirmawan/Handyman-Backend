import type { ConfigurationVersionSourceType } from '../configuration-versions';

export const CONFIGURATION_AUDIT_ACTIONS = [
  'CONFIGURATION_DRAFT_CREATED',
  'CONFIGURATION_DRAFT_UPDATED',
  'CONFIGURATION_VALIDATION_SUCCEEDED',
  'CONFIGURATION_VALIDATION_FAILED',
  'CONFIGURATION_PUBLISHED',
  'CONFIGURATION_ACTIVATED',
  'CONFIGURATION_SUPERSEDED',
  'CONFIGURATION_PREVIEW_CREATED',
  'CONFIGURATION_PREVIEW_ACCESSED',
  'CONFIGURATION_PREVIEW_REVOKED',
] as const;
export type ConfigurationAuditAction =
  (typeof CONFIGURATION_AUDIT_ACTIONS)[number];

export type ConfigurationAuditEvent = {
  id: string;
  configurationId: string;
  configurationVersionId: string | null;
  sourceType: ConfigurationVersionSourceType;
  action: ConfigurationAuditAction;
  actorUserId: string | null;
  clientId: string;
  buildingId: string | null;
  previousStatus: string | null;
  newStatus: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
};

export type RecordConfigurationAuditInput = {
  configurationId: string;
  configurationVersionId?: string | null;
  sourceType: ConfigurationVersionSourceType;
  action: ConfigurationAuditAction;
  actorUserId: string;
  clientId: string;
  buildingId: string | null;
  previousStatus?: string | null;
  newStatus?: string | null;
  summary: string;
  versionNumber?: number;
  previousVersionId?: string | null;
  valid?: boolean;
  validationErrorCodes?: string[];
  previewContextId?: string;
  previewStatus?: string;
};

export type ConfigurationAuditFilters = {
  configurationId?: string;
  configurationVersionId?: string;
  sourceType?: ConfigurationVersionSourceType;
  action?: ConfigurationAuditAction;
  buildingId?: string;
  from?: Date;
  to?: Date;
};
