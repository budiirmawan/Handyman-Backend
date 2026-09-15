/**
 * BE-02A — Company & Client domain types.
 *
 * A Client is the top-level customer/commercial boundary: the company or
 * customer operating/subscribing to Asentra. It is NOT a Tenant, Vendor,
 * Department, or internal Organization. The Client entity represents the
 * Company as a commercial party.
 *
 * No subscription, license, or entitlement state lives here (BE-02B/C).
 */
export const CLIENT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export function isClientStatus(value: unknown): value is ClientStatus {
  return (
    typeof value === 'string' &&
    (CLIENT_STATUSES as readonly string[]).includes(value)
  );
}

export type ClientRecord = {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  description: string | null;
  status: ClientStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicClient = {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  description: string | null;
  status: ClientStatus;
};

export type CreateClientInput = {
  code: string;
  name: string;
  legalName?: string;
  taxId?: string;
  description?: string;
  status?: ClientStatus;
};

/** Fully-resolved client data ready for persistence. */
export type NewClient = {
  code: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  description: string | null;
  status: ClientStatus;
};

export type UpdateClientInput = {
  name?: string;
  legalName?: string;
  taxId?: string;
  description?: string;
  status?: ClientStatus;
};
