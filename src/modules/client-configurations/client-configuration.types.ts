/** BE-27A — JSON-safe configuration values accepted by the Client registry. */
export type ClientConfigurationValue =
  | null
  | boolean
  | number
  | string
  | ClientConfigurationValue[]
  | { [key: string]: ClientConfigurationValue };

/**
 * ACTIVE / INACTIVE is record availability for the unversioned BE-27A
 * foundation. It is not the BE-27N/O publish lifecycle.
 */
export const CLIENT_CONFIGURATION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ClientConfigurationStatus =
  (typeof CLIENT_CONFIGURATION_STATUSES)[number];

export function isClientConfigurationStatus(
  value: unknown,
): value is ClientConfigurationStatus {
  return (
    typeof value === 'string' &&
    (CLIENT_CONFIGURATION_STATUSES as readonly string[]).includes(value)
  );
}

export type ClientConfigurationRecord = {
  id: string;
  clientId: string;
  key: string;
  value: ClientConfigurationValue;
  status: ClientConfigurationStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicClientConfiguration = Omit<
  ClientConfigurationRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

export type CreateClientConfigurationInput = {
  clientId: string;
  key: string;
  value: ClientConfigurationValue;
  status?: ClientConfigurationStatus;
};

export type NewClientConfiguration = {
  clientId: string;
  key: string;
  value: ClientConfigurationValue;
  status: ClientConfigurationStatus;
};

export type UpdateClientConfigurationInput = {
  value?: ClientConfigurationValue;
  status?: ClientConfigurationStatus;
};

export type ClientConfigurationFilters = {
  status?: ClientConfigurationStatus;
};

/** Runtime-facing projection: only ACTIVE values, keyed by stable key. */
export type EffectiveClientConfiguration = {
  clientId: string;
  configurations: Record<string, ClientConfigurationValue>;
};
