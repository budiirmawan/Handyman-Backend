import type { ClientConfigurationStatus } from '../client-configurations';

export const ORGANIZATION_PRESENTATION_ENTITY_TYPES = [
  'ORGANIZATION',
  'DEPARTMENT',
  'TEAM',
  'POSITION',
] as const;
export type OrganizationPresentationEntityType =
  (typeof ORGANIZATION_PRESENTATION_ENTITY_TYPES)[number];
export type OrganizationPresentationScope = 'CLIENT' | 'BUILDING';
export type OrganizationPresentationStatus = ClientConfigurationStatus;

export type OrganizationPresentationLabels = {
  organization: string | null;
  department: string | null;
  team: string | null;
  position: string | null;
};

export type OrganizationPresentationLabelsInput = Partial<
  OrganizationPresentationLabels
>;

export type OrganizationPresentationItem = {
  entityType: OrganizationPresentationEntityType;
  entityId: string;
  displayName: string | null;
  displayOrder: number;
  visible: boolean;
};

export type OrganizationPresentationPayload = {
  labels: OrganizationPresentationLabels;
  items: OrganizationPresentationItem[];
};

export type PublicOrganizationPresentation =
  OrganizationPresentationPayload & {
    id: string;
    clientId: string;
    buildingId: string | null;
    scopeType: OrganizationPresentationScope;
    status: OrganizationPresentationStatus;
    createdAt: string;
    updatedAt: string;
  };

export type CreateOrganizationPresentationInput = {
  labels: OrganizationPresentationLabels;
  items: OrganizationPresentationItem[];
  status: OrganizationPresentationStatus;
};

export type UpdateOrganizationPresentationInput = {
  labels?: OrganizationPresentationLabelsInput;
  items?: OrganizationPresentationItem[];
  status?: OrganizationPresentationStatus;
};

export type EffectiveOrganizationPresentationItem =
  OrganizationPresentationItem & {
    code: string;
    authoritativeName: string;
    effectiveDisplayName: string;
    organizationId: string;
    departmentId: string | null;
    available: boolean;
  };

export type EffectiveOrganizationPresentation = {
  clientId: string;
  buildingId: string | null;
  labels: {
    organization: string;
    department: string;
    team: string;
    position: string;
  };
  items: EffectiveOrganizationPresentationItem[];
};
