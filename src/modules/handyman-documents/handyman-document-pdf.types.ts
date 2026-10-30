/**
 * CR-HM-DOCUMENT-PDF-01 PART 01 — shared official-document PDF layout types.
 *
 * ONE reusable A4 business-document layout for the five customer-facing
 * document types (Quotation, BAST, Invoice, Warranty Certificate, Scope
 * Variation / Change Order). The renderer is a PURE function of a frozen
 * snapshot: `snapshot -> { bytes, filename, checksum }`. It owns no database
 * table, no route, no permission, no storage driver and no business lifecycle.
 *
 * HARD RULES of this layer (frozen by the CR-HM-DOCUMENT-PDF-00 audit):
 *  - NEVER fabricate anything: no logo, no signature graphic, no sign-off
 *    line, no approval, no document number, no date and no price. An optional
 *    field that the caller does not supply is rendered as the neutral "not
 *    supplied" marker or the whole block is omitted.
 *  - Every string is normalized for the WinAnsi alphabet of the Standard PDF
 *    fonts and wrapped/truncated by width, never by character count, so no
 *    input can overflow the page or corrupt the content stream.
 *  - Output is byte-deterministic for identical input: no clock, no locale
 *    service, no randomness, no embedded metadata dates.
 */

/** The five official document kinds this layout serves (frozen vocabulary). */
export const HANDYMAN_DOCUMENT_KINDS = [
  'QUOTATION',
  'BAST',
  'INVOICE',
  'WARRANTY_CERTIFICATE',
  'VARIATION_ORDER',
] as const;
export type HandymanDocumentKind = (typeof HANDYMAN_DOCUMENT_KINDS)[number];

export function isHandymanDocumentKind(value: unknown): value is HandymanDocumentKind {
  return (
    typeof value === 'string' &&
    (HANDYMAN_DOCUMENT_KINDS as readonly string[]).includes(value)
  );
}

export const HANDYMAN_DOCUMENT_LOCALES = ['id', 'en'] as const;
export type HandymanDocumentLocale = (typeof HANDYMAN_DOCUMENT_LOCALES)[number];

/** Fail-closed renderer error vocabulary (no HTTP layer involvement). */
export const HANDYMAN_DOCUMENT_PDF_ERROR_CODES = [
  'INVALID_LAYOUT',
  'UNSUPPORTED_FIELD',
  'INVALID_MONEY_VALUE',
  'INVALID_DATE_VALUE',
  'CONTENT_TOO_LARGE',
  'UNSAFE_FILENAME',
] as const;
export type HandymanDocumentPdfErrorCode =
  (typeof HANDYMAN_DOCUMENT_PDF_ERROR_CODES)[number];

export const HANDYMAN_DOCUMENT_PDF_CONTENT_TYPE = 'application/pdf';
export const HANDYMAN_DOCUMENT_PDF_CHECKSUM_ALGORITHM = 'SHA-256';

/** Layout and content caps: the renderer refuses rather than truncating a page. */
export const HANDYMAN_DOCUMENT_PDF_LIMITS = {
  maxLineItems: 400,
  maxPages: 60,
  maxTermsBlocks: 12,
  maxTermsLines: 60,
  maxTotalsRows: 20,
  maxAddressLines: 6,
  maxKeyValues: 20,
  maxEvidenceRows: 20,
  maxTextLength: 600,
  maxLinesPerField: 24,
} as const;

/** A single label/value pair; `null`/`undefined` renders the "not supplied" marker. */
export type HandymanDocumentKeyValue = {
  label: string;
  value: string | number | boolean | null | undefined;
};

/**
 * A party block (issuer letterhead side or recipient side). Everything here is
 * caller-supplied text from the governing record: this module never derives a
 * company name, address or tax id.
 */
export type HandymanDocumentParty = {
  /** Section label, e.g. "Diterbitkan oleh". Defaults per locale. */
  role?: string | null;
  name: string;
  attention?: string | null;
  addressLines?: string[];
  taxId?: string | null;
  phone?: string | null;
  email?: string | null;
  references?: HandymanDocumentKeyValue[];
};

/** One priced line of the document. Amounts stay verbatim: no arithmetic here. */
export type HandymanDocumentLineItem = {
  description: string;
  quantity?: number | null;
  unit?: string | null;
  unitAmount?: number | null;
  discount?: number | null;
  total?: number | null;
  /** Free-text detail rendered under the row (never a second price). */
  note?: string | null;
};

/** A money row of the totals block; `emphasised` is drawn bold under a rule. */
export type HandymanDocumentTotalRow = {
  label: string;
  amount: number;
  emphasised?: boolean;
};

/** Status / verification reference of the underlying immutable record. */
export type HandymanDocumentStatusBlock = {
  label?: string | null;
  /** The owning domain status, verbatim (e.g. 'ISSUED', 'ACCEPTED'). */
  value: string;
  reference?: string | null;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
  lines?: string[];
};

/**
 * Optional consent / evidence reference block: the record that a customer
 * accepted something and the evidence the acceptance is bound to. It cites
 * identifiers and digests only - it never reproduces a signature.
 */
export type HandymanDocumentEvidenceRef = {
  label: string;
  value: string;
  algorithm?: string | null;
  sizeBytes?: number | string | null;
};

export type HandymanDocumentConsentBlock = {
  label?: string | null;
  /** Outcome verbatim from the record, e.g. 'APPROVE', 'ACCEPT', 'REJECT'. */
  outcome: string;
  actorName?: string | null;
  actorRole?: string | null;
  method?: string | null;
  channel?: string | null;
  decidedAt?: string | null;
  reference?: string | null;
  evidence?: HandymanDocumentEvidenceRef[];
};

export type HandymanDocumentTermsBlock = {
  heading?: string | null;
  lines: string[];
};

/** The frozen input of the renderer. Only `document`, `issuer`, `recipient` are required. */
export type HandymanDocumentSnapshot = {
  locale?: HandymanDocumentLocale;
  /**
   * Minutes east of UTC used to present timestamps (e.g. 420 for Asia/Jakarta).
   * The renderer never guesses a zone; the default 0 keeps output stable.
   */
  utcOffsetMinutes?: number;
  document: {
    kind: HandymanDocumentKind;
    /** Display override for the document type label. */
    typeLabel?: string | null;
    /** The issued document number, copied from the record. */
    number: string;
    version?: string | number | null;
    issueDate?: string | Date | null;
    /** ISO-4217 alpha-3 code used for every table amount. */
    currency?: string | null;
    reference?: string | null;
    validUntil?: string | Date | null;
    downPayment?: {
      percentage?: number | null;
      amount?: number | null;
      notes?: string | null;
    } | null;
  };
  issuer: HandymanDocumentParty;
  recipient: HandymanDocumentParty;
  /** Customer site / property panel (optional). */
  property?: {
    label?: string | null;
    name?: string | null;
    lines?: string[];
    references?: HandymanDocumentKeyValue[];
  } | null;
  lineItems?: HandymanDocumentLineItem[];
  totals?: HandymanDocumentTotalRow[];
  terms?: HandymanDocumentTermsBlock[];
  status?: HandymanDocumentStatusBlock | null;
  consent?: HandymanDocumentConsentBlock | null;
  footer?: {
    /** Left footer text on every page (never a generated timestamp). */
    left?: string | null;
    note?: string | null;
  } | null;
};

export type HandymanDocumentPdfRenderOptions = {
  /** Optional display name; it never becomes a storage path or key. */
  filename?: string;
};

export type HandymanDocumentPdfRenderResult = {
  bytes: Buffer;
  contentType: typeof HANDYMAN_DOCUMENT_PDF_CONTENT_TYPE;
  filename: string;
  fileSize: number;
  checksum: string;
  checksumAlgorithm: typeof HANDYMAN_DOCUMENT_PDF_CHECKSUM_ALGORITHM;
  pageCount: number;
};
