/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01B — issuer company bank account types.
 *
 * The receiving bank account an official Handyman document (Quotation, Invoice,
 * Scope Variation) names as its payment destination. Scoped to the provider
 * `clients` row like the issuer profile: never Building-Management money, never
 * tenant money, and never a payment itself - this vocabulary describes where the
 * issuer asks to be paid, and no amount, settlement or ledger concept belongs
 * here.
 *
 * The account number is SENSITIVE: it is absent from every public view type on
 * purpose (only `accountNumberMasked` is exposed) and never enters audit
 * metadata. The full value exists only inside the frozen document snapshot the
 * renderer is handed, because a printed payment instruction is the one place it
 * has to appear.
 */

export const HANDYMAN_DOCUMENT_BANK_ACCOUNT_STATUSES = [
  'PENDING_VERIFICATION',
  'ACTIVE',
  'SUSPENDED',
  'SUPERSEDED',
] as const;
export type HandymanDocumentBankAccountStatus =
  (typeof HANDYMAN_DOCUMENT_BANK_ACCOUNT_STATUSES)[number];

export function isHandymanDocumentBankAccountStatus(
  value: unknown,
): value is HandymanDocumentBankAccountStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_DOCUMENT_BANK_ACCOUNT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The payment-critical content of an account. Every one of these is immutable
 * history once stored: a change appends a new `version` row instead, so a
 * document that already printed these values keeps meaning what it said.
 */
export const HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONTENT_FIELDS = [
  'bankCode',
  'bankName',
  'accountNumber',
  'accountHolderName',
  'currency',
] as const;
export type HandymanDocumentBankAccountContentField =
  (typeof HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONTENT_FIELDS)[number];

export type HandymanDocumentBankAccountContent = {
  /** Short uppercase bank code as configured by the provider (e.g. 'BMRI'). */
  bankCode: string;
  bankName: string;
  /** Stored, never displayed: public reads carry the mask only. */
  accountNumber: string;
  accountHolderName: string;
  /** ISO-4217 alpha-3, FK to the platform `currencies` reference. */
  currency: string;
};

export type HandymanDocumentBankAccountRecord = HandymanDocumentBankAccountContent & {
  /** This version row's identity. */
  id: string;
  /** The logical account: the id of the chain's first version row. */
  bankAccountId: string;
  clientId: string;
  status: HandymanDocumentBankAccountStatus;
  isDefault: boolean;
  version: number;
  verificationReference: string | null;
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
  deactivatedAt: Date | null;
  supersededAt: Date | null;
  effectiveFrom: Date;
  createdByUserId: string;
  createdAt: Date;
};

/** What every read path returns: masked account number, never the stored value. */
export type PublicHandymanDocumentBankAccount = Omit<
  HandymanDocumentBankAccountContent,
  'accountNumber'
> & {
  id: string;
  bankAccountId: string;
  clientId: string;
  accountNumberMasked: string;
  status: HandymanDocumentBankAccountStatus;
  isDefault: boolean;
  version: number;
  /**
   * False on a row that a later version superseded on paper while it is still
   * the live destination (or a draft behind it), so a caller can see the chain
   * position instead of guessing - and an old version is never presented as
   * the current one.
   */
  isLatestVersion: boolean;
  verificationReference: string | null;
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  deactivatedAt: string | null;
  supersededAt: string | null;
  effectiveFrom: string;
  createdByUserId: string;
  createdAt: string;
};

export type CreateHandymanDocumentBankAccountInput = {
  clientId: string;
} & HandymanDocumentBankAccountContent;

export type UpdateHandymanDocumentBankAccountInput = {
  clientId: string;
  bankAccountId: string;
  /** The chain version the writer read; mandatory, like the issuer profile. */
  expectedVersion: number;
} & HandymanDocumentBankAccountContent;

/**
 * The controlled verification act. `confirmAccountNumber` is the operator
 * re-typing the stored number (it must match), and `verificationReference`
 * names the evidence checked (bank letter, teller print, verified document) -
 * the platform records a human confirmation and never claims to have contacted
 * a bank itself.
 */
export type ActivateHandymanDocumentBankAccountInput = {
  clientId: string;
  bankAccountId: string;
  expectedVersion: number;
  confirmAccountNumber: string;
  verificationReference: string;
  /** Default true: a verified destination is normally the currency's default. */
  asDefault: boolean;
  /** Required when another ACTIVE default already holds this currency. */
  authorizeReplacement: boolean;
};

export type DeactivateHandymanDocumentBankAccountInput = {
  clientId: string;
  bankAccountId: string;
  expectedVersion: number;
  reason: string;
  /** Required when retiring this currency's only default destination. */
  confirmLossOfDefault: boolean;
};

export type HandymanDocumentBankAccountUpdateResult =
  PublicHandymanDocumentBankAccount & {
    previousVersion: number;
    changedFields: HandymanDocumentBankAccountContentField[];
    /** True while this version still has to pass the verification act. */
    requiresVerification: boolean;
  };

/**
 * The read-only snapshot future document renderers pin: immutable,
 * versioned and self-digesting, so a later activation or deactivation can
 * neither change nor silently remove what an issued document already printed.
 */
export type HandymanDocumentBankAccountSnapshot = Readonly<
  HandymanDocumentBankAccountContent & {
    bankAccountId: string;
    versionRowId: string;
    clientId: string;
    version: number;
    accountNumberMasked: string;
    verifiedAt: string;
    verifiedByUserId: string;
    verificationReference: string | null;
    payloadChecksum: string;
    checksumAlgorithm: 'SHA-256';
  }
>;

export const HANDYMAN_DOCUMENT_BANK_ACCOUNT_EVENT_TYPES = {
  created: 'HANDYMAN_DOCUMENT_BANK_ACCOUNT_CREATED',
  updated: 'HANDYMAN_DOCUMENT_BANK_ACCOUNT_UPDATED',
  activated: 'HANDYMAN_DOCUMENT_BANK_ACCOUNT_ACTIVATED',
  deactivated: 'HANDYMAN_DOCUMENT_BANK_ACCOUNT_DEACTIVATED',
} as const;

export const HANDYMAN_DOCUMENT_BANK_ACCOUNT_ENTITY_TYPE =
  'HANDYMAN_DOCUMENT_BANK_ACCOUNT';

/**
 * Masks a stored account number to its last four characters with a
 * constant-length prefix, so a read, a log line or an audit row can identify
 * WHICH account is meant without ever carrying the number itself.
 */
export function maskHandymanDocumentAccountNumber(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return '****';
  return `****${trimmed.slice(-4)}`;
}
