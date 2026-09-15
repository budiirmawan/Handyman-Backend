import type {
  ModuleConfigurationScope,
  ModuleConfigurationSource,
} from '../module-configurations';

export const FEATURE_ENTITLEMENT_STATES = ['ENABLED', 'DISABLED'] as const;
export type FeatureEntitlementState =
  (typeof FEATURE_ENTITLEMENT_STATES)[number];

export function isFeatureEntitlementState(
  value: unknown,
): value is FeatureEntitlementState {
  return (
    typeof value === 'string' &&
    (FEATURE_ENTITLEMENT_STATES as readonly string[]).includes(value)
  );
}

export type FeatureEntitlementConfigurationRecord = {
  id: string;
  scopeType: ModuleConfigurationScope;
  clientId: string;
  buildingId: string | null;
  moduleId: string;
  moduleKey: string;
  moduleName: string;
  featureKey: string;
  state: FeatureEntitlementState;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicFeatureEntitlementConfiguration = Omit<
  FeatureEntitlementConfigurationRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

export type CreateFeatureEntitlementConfigurationInput = {
  moduleKey: string;
  featureKey: string;
  state: FeatureEntitlementState;
};

export type UpdateFeatureEntitlementConfigurationInput = {
  state: FeatureEntitlementState;
};

export type NewFeatureEntitlementConfiguration = {
  scopeType: ModuleConfigurationScope;
  clientId: string | null;
  buildingId: string | null;
  moduleId: string;
  featureKey: string;
  state: FeatureEntitlementState;
};

export type EffectiveFeatureEntitlementItem = {
  moduleId: string;
  moduleKey: string;
  moduleName: string;
  featureKey: string;
  configuredState: FeatureEntitlementState;
  moduleEnabled: boolean;
  state: FeatureEntitlementState;
  source: ModuleConfigurationSource;
};

export type EffectiveFeatureEntitlementConfiguration = {
  clientId: string;
  buildingId: string | null;
  features: EffectiveFeatureEntitlementItem[];
};
