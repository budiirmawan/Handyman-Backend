import type { ModuleConfigurationScope } from '../module-configurations';

export type NavigationItemRecord = {
  id: string;
  scopeType: ModuleConfigurationScope;
  clientId: string;
  buildingId: string | null;
  navigationKey: string;
  label: string;
  routeReference: string;
  parentNavigationKey: string | null;
  displayOrder: number;
  moduleId: string | null;
  moduleKey: string | null;
  featureKey: string | null;
  permissionId: string | null;
  permissionCode: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicNavigationItem = Omit<
  NavigationItemRecord,
  'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };

export type CreateNavigationItemInput = {
  navigationKey: string;
  label: string;
  routeReference: string;
  parentNavigationKey?: string | null;
  displayOrder: number;
  moduleKey?: string | null;
  featureKey?: string | null;
  permissionCode?: string | null;
  enabled: boolean;
};

export type NewNavigationItem = {
  scopeType: ModuleConfigurationScope;
  clientId: string | null;
  buildingId: string | null;
  navigationKey: string;
  label: string;
  routeReference: string;
  parentNavigationKey: string | null;
  displayOrder: number;
  moduleId: string | null;
  featureKey: string | null;
  permissionId: string | null;
  enabled: boolean;
};

export type UpdateNavigationItemInput = {
  label?: string;
  routeReference?: string;
  displayOrder?: number;
  enabled?: boolean;
};

export type EffectiveNavigationItem = Omit<
  PublicNavigationItem,
  'createdAt' | 'updatedAt'
>;

export type EffectiveNavigation = {
  clientId: string;
  buildingId: string | null;
  items: EffectiveNavigationItem[];
};
