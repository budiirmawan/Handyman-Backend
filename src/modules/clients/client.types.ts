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

/**
 * `code` is deliberately absent: the machine-readable Client code is the
 * stable commercial identity created by POST /clients and is IMMUTABLE after
 * creation (Properties are keyed by `client_id + code`, and downstream
 * configuration/commercial tables reference the Client by id). The update
 * validator rejects a supplied `code` rather than silently ignoring it.
 */
export type UpdateClientInput = {
  name?: string;
  legalName?: string;
  taxId?: string;
  description?: string;
  status?: ClientStatus;
};

/**
 * CR-HM-BE-CLIENT-MASTER-01 — Client registry read reach.
 *
 * `ALL`        — installation-wide (the Owner / PLATFORM_ADMIN);
 * `RESTRICTED` — exactly the Clients reachable through the caller's ACTIVE,
 *                currently-accessible Building assignments; an empty array is
 *                valid and matches NOTHING.
 *
 * Resolution lives in `client.scope.ts` (the only file that depends on the
 * BE-02G context resolver). The pure helpers stay here so the service does not
 * import the context-access module graph.
 */
export type ClientReadScope =
  | { mode: 'ALL' }
  | { mode: 'RESTRICTED'; clientIds: readonly string[] };

/** The repository filter for this scope: `null` means installation-wide. */
export function scopeToClientIds(
  scope: ClientReadScope | undefined,
): readonly string[] | null {
  if (!scope || scope.mode === 'ALL') {
    return null;
  }

  return scope.clientIds;
}

/** True when the scope authorizes the exact Client id. */
export function isClientInScope(
  scope: ClientReadScope | undefined,
  clientId: string,
): boolean {
  if (!scope || scope.mode === 'ALL') {
    return true;
  }

  return scope.clientIds.includes(clientId);
}

/**
 * CR-HM-BE-CLIENT-MASTER-01 — optional registry filters for GET /clients.
 *
 * Filters are additive and never widen authorization: they are applied AFTER
 * the caller's authorized Client reach (see `client.scope.ts`). No filter can
 * be used to discover a Client outside that reach.
 */
export type ClientListFilters = {
  status?: ClientStatus;
  /** Case-insensitive literal substring match over `code` and `name`. */
  search?: string;
};

