/**
 * BE-26C — Recipient resolution types.
 *
 * Resolves notification recipients to EXISTING User identities (the
 * `notifications.recipient_user_id` from BE-26A) using the backend's own
 * context: Users, Roles/Permissions, Workforce/Teams, Tenant PICs and Vendor
 * PICs. No new identity or audience engine is created — resolution only ever
 * follows links that already exist in the data model.
 */

export const RECIPIENT_KINDS = [
  'USER',
  'ROLE',
  'PERMISSION',
  'WORKFORCE',
  'TEAM',
  'TENANT_PIC',
  'VENDOR_PIC',
] as const;

export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

export function isRecipientKind(value: unknown): value is RecipientKind {
  return (
    typeof value === 'string' &&
    (RECIPIENT_KINDS as readonly string[]).includes(value)
  );
}

/**
 * A single recipient resolution instruction. Exactly one kind with its
 * required reference field.
 */
export type RecipientSpec =
  | { kind: 'USER'; userId: string }
  | { kind: 'ROLE'; roleCode: string }
  | { kind: 'PERMISSION'; permissionCode: string }
  | { kind: 'WORKFORCE'; workforceProfileId: string }
  | { kind: 'TEAM'; teamId: string }
  | { kind: 'TENANT_PIC'; tenantCompanyId?: string; tenantPicId?: string }
  | { kind: 'VENDOR_PIC'; vendorId: string };

/**
 * Client / Building data-scope constraint applied to resolved recipients.
 * When absent, resolution is unscoped (raw membership resolution). When
 * present, only users whose OWN accessible Building context satisfies the
 * scope are kept — this is the BE-02F/BE-02G rule, never a client-supplied
 * shortcut.
 */
export type RecipientScope = {
  /** Keep users with an accessible Building under this Client. */
  clientId?: string;
  /** Keep users with access to at least one of these Buildings. */
  buildingIds?: string[];
};

/** A resolved User recipient with its resolution provenance. */
export type ResolvedRecipient = {
  /** The resolved User identity (BE-01). */
  userId: string;
  /** The resolution source kind that produced this recipient. */
  kind: RecipientKind;
  /** Id/code of the source entity that produced this recipient. */
  sourceId: string;
};

/**
 * A persisted recipient resolution rule: one or more recipient specs plus an
 * optional Client/Building scope. This is the shape stored in BE-26D event
 * subscription records and consumed by `resolveRecipients` at delivery time.
 */
export type RecipientRule = {
  specs: RecipientSpec[];
  scope?: RecipientScope;
};
