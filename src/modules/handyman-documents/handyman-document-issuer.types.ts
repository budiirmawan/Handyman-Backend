/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01A — issuer company profile types.
 *
 * The authoritative Handyman SERVICE PROVIDER identity that official customer
 * documents are issued under (Quotation, BAST, Invoice, Warranty Certificate,
 * Scope Variation). Scoped to the provider `clients` row on purpose: this is
 * not Client/Building-Management branding and not tenant (customer) data, and
 * it never reuses the `branding` login/portal/report cosmetics as a document
 * authority.
 */

export const HANDYMAN_DOCUMENT_ISSUER_PROFILE_STATUSES = ['ACTIVE', 'SUPERSEDED'] as const;
export type HandymanDocumentIssuerProfileStatus =
  (typeof HANDYMAN_DOCUMENT_ISSUER_PROFILE_STATUSES)[number];

export function isHandymanDocumentIssuerProfileStatus(
  value: unknown,
): value is HandymanDocumentIssuerProfileStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_DOCUMENT_ISSUER_PROFILE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The frozen content vocabulary of the profile. Every field is provider-supplied
 * master data: no field is derived from a Client/Building record, and none is
 * ever invented by a default. Optional fields stay NULL when unknown.
 */
export const HANDYMAN_DOCUMENT_ISSUER_PROFILE_FIELDS = [
  'legalName',
  'displayName',
  'registeredAddress',
  'businessAddress',
  'city',
  'province',
  'postalCode',
  'email',
  'phone',
  'whatsapp',
  'website',
  'taxId',
  'businessRegistrationId',
  'logoReference',
] as const;
export type HandymanDocumentIssuerProfileField =
  (typeof HANDYMAN_DOCUMENT_ISSUER_PROFILE_FIELDS)[number];

/** Fields that must be present and non-empty. */
export const HANDYMAN_DOCUMENT_ISSUER_PROFILE_REQUIRED_FIELDS = [
  'legalName',
  'displayName',
  'registeredAddress',
  'city',
  'province',
  'postalCode',
  'email',
  'phone',
  'whatsapp',
] as const satisfies readonly HandymanDocumentIssuerProfileField[];

/** Fields that may be omitted / cleared (never fabricated downstream). */
export const HANDYMAN_DOCUMENT_ISSUER_PROFILE_OPTIONAL_FIELDS = [
  'businessAddress',
  'website',
  'taxId',
  'businessRegistrationId',
  'logoReference',
] as const satisfies readonly HandymanDocumentIssuerProfileField[];

export type HandymanDocumentIssuerProfileContent = {
  legalName: string;
  displayName: string;
  registeredAddress: string;
  businessAddress: string | null;
  city: string;
  province: string;
  postalCode: string;
  email: string;
  phone: string;
  whatsapp: string;
  website: string | null;
  /** NPWP (Indonesian taxpayer number), verbatim as configured. */
  taxId: string | null;
  /** NIB (business registration number), verbatim as configured. */
  businessRegistrationId: string | null;
  /** Media reference only - no binary, no upload, no storage write. */
  logoReference: string | null;
};

export type HandymanDocumentIssuerProfileRecord =
  HandymanDocumentIssuerProfileContent & {
    id: string;
    clientId: string;
    status: HandymanDocumentIssuerProfileStatus;
    version: number;
    effectiveFrom: Date;
    createdByUserId: string;
    createdAt: Date;
    supersededAt: Date | null;
  };

export type PublicHandymanDocumentIssuerProfile =
  HandymanDocumentIssuerProfileContent & {
    id: string;
    clientId: string;
    status: HandymanDocumentIssuerProfileStatus;
    version: number;
    effectiveFrom: string;
    createdByUserId: string;
    createdAt: string;
    supersededAt: string | null;
  };

/** The update response additionally reports what actually changed. */
export type HandymanDocumentIssuerProfileUpdateResult =
  PublicHandymanDocumentIssuerProfile & {
    previousVersion: number | null;
    changedFields: HandymanDocumentIssuerProfileField[];
  };

export type UpdateHandymanDocumentIssuerProfileInput =
  HandymanDocumentIssuerProfileContent & {
    clientId: string;
    /**
     * Optimistic concurrency: the version the writer believes is current.
     * `null` is required for the very first profile of a provider Client, so a
     * second manager can never silently overwrite a change it never saw.
     */
    expectedVersion: number | null;
  };

/**
 * The read-only snapshot future PDF rendering consumes. It is immutable and
 * self-describing: it carries the profile identity + version + a canonical
 * payload digest, so a document can pin EXACTLY which issuer identity produced
 * it and a later profile change can never mutate that document retroactively.
 */
export type HandymanDocumentIssuerSnapshot = Readonly<
  HandymanDocumentIssuerProfileContent & {
    profileId: string;
    clientId: string;
    version: number;
    payloadChecksum: string;
    checksumAlgorithm: 'SHA-256';
  }
>;

export const HANDYMAN_DOCUMENT_ISSUER_SNAPSHOT_EVENT_TYPES = {
  created: 'HANDYMAN_DOCUMENT_ISSUER_PROFILE_CREATED',
  updated: 'HANDYMAN_DOCUMENT_ISSUER_PROFILE_UPDATED',
} as const;

export const HANDYMAN_DOCUMENT_ISSUER_SNAPSHOT_ENTITY_TYPE =
  'HANDYMAN_DOCUMENT_ISSUER_PROFILE';
