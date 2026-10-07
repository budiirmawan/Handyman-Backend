/**
 * BE-12K — Security Key Control domain types.
 *
 * Two tables back this PART:
 *   - `security_keys`           — the controlled key master record
 *   - `security_key_custody`    — append-oriented custody history
 *
 * The Key's `status` is authoritative on the master row. Custody is
 * append-oriented: each issue / return / mark-lost / mark-inactive
 * inserts a new custody row, and historical rows are never overwritten
 * or deleted. The "current custody" is the most recent custody row
 * for a key (i.e. the row with the latest `issued_at` that has no
 * `returned_at`, or the most recent terminal event).
 *
 * No inventory / warehouse / procurement / costing logic. No
 * electronic access-control or smart-lock integration. No Lost &
 * Found logic.
 */

export const SECURITY_KEY_STATUSES = [
  'AVAILABLE',
  'ISSUED',
  'OVERDUE',
  'LOST',
  'INACTIVE',
] as const;

export type SecurityKeyStatus = (typeof SECURITY_KEY_STATUSES)[number];

export function isSecurityKeyStatus(
  value: unknown,
): value is SecurityKeyStatus {
  return (
    typeof value === 'string' &&
    (SECURITY_KEY_STATUSES as readonly string[]).includes(value)
  );
}

export const SECURITY_KEY_CUSTODY_TRANSACTION_TYPES = [
  'ISSUE',
  'RETURN',
  'MARK_LOST',
  'MARK_INACTIVE',
] as const;

export type SecurityKeyCustodyTransactionType =
  (typeof SECURITY_KEY_CUSTODY_TRANSACTION_TYPES)[number];

export function isSecurityKeyCustodyTransactionType(
  value: unknown,
): value is SecurityKeyCustodyTransactionType {
  return (
    typeof value === 'string' &&
    (SECURITY_KEY_CUSTODY_TRANSACTION_TYPES as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ */
/*  Controlled Key master record                                       */
/* ------------------------------------------------------------------ */

export type SecurityKeyRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  code: string;
  name: string;
  description: string | null;
  securityPostId: string | null;
  functionalLocationId: string | null;
  status: SecurityKeyStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicSecurityKey = {
  id: string;
  clientId: string;
  buildingId: string;
  code: string;
  name: string;
  description: string | null;
  securityPostId: string | null;
  functionalLocationId: string | null;
  status: SecurityKeyStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateSecurityKeyInput = {
  buildingId: string;
  code: string;
  name: string;
  description?: string | null;
  securityPostId?: string | null;
  functionalLocationId?: string | null;
  status?: SecurityKeyStatus;
  createdByUserId: string;
};

export type UpdateSecurityKeyInput = {
  name?: string;
  description?: string | null;
  securityPostId?: string | null;
  functionalLocationId?: string | null;
  status?: SecurityKeyStatus;
};

export type SecurityKeyListFilters = {
  buildingId?: string;
  securityPostId?: string;
  status?: SecurityKeyStatus;
};

/* ------------------------------------------------------------------ */
/*  Key Custody transaction                                             */
/* ------------------------------------------------------------------ */

export type SecurityKeyCustodyRecord = {
  id: string;
  keyId: string;
  transactionType: SecurityKeyCustodyTransactionType;
  issuedToWorkforceId: string | null;
  issuedByUserId: string | null;
  issuedAt: Date | null;
  expectedReturnAt: Date | null;
  returnedAt: Date | null;
  returnedToUserId: string | null;
  notes: string | null;
  createdAt: Date;
};

export type PublicSecurityKeyCustody = {
  id: string;
  keyId: string;
  transactionType: SecurityKeyCustodyTransactionType;
  issuedToWorkforceId: string | null;
  issuedByUserId: string | null;
  issuedAt: string | null;
  expectedReturnAt: string | null;
  returnedAt: string | null;
  returnedToUserId: string | null;
  notes: string | null;
  createdAt: string;
};

export type IssueKeyInput = {
  keyId: string;
  issuedToWorkforceId: string;
  expectedReturnAt?: string | null;
  notes?: string | null;
  issuedByUserId: string;
};

export type ReturnKeyInput = {
  keyId: string;
  returnedToUserId: string;
  notes?: string | null;
};
