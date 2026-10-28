/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01C — document settings types.
 *
 * The VOICE of an official Handyman document: numbering prefix, standard terms,
 * payment wording, warranty wording, footer/contact line and the authorized
 * signatory's name and title - one effective configuration per provider Client
 * per document kind per language.
 *
 * What is deliberately missing is the point: no amount, no tax, no discount, no
 * down-payment, no issued number or sequence, no acceptance/consent flag, no
 * warranty start date and no signature image. Prices and totals come from the
 * quotation, acceptance from the BAST record, warranty activation from the
 * warranty record, the payment destination from the verified bank-account master
 * (PART 01B), and a signature is a human act this module cannot represent.
 * Existing renderer kinds retain their frozen vocabulary. PAYMENT_RECEIPT has
 * its own renderer and is added here for its separately approved number policy.
 */
import {
  HANDYMAN_DOCUMENT_KINDS,
  HANDYMAN_DOCUMENT_LOCALES,
} from './handyman-document-pdf.types';

export const HANDYMAN_DOCUMENT_SETTINGS_KINDS = [...HANDYMAN_DOCUMENT_KINDS, 'PAYMENT_RECEIPT'] as const;
export type HandymanDocumentSettingsKind = (typeof HANDYMAN_DOCUMENT_SETTINGS_KINDS)[number];
export const HANDYMAN_DOCUMENT_SETTINGS_LANGUAGES = HANDYMAN_DOCUMENT_LOCALES;
export type HandymanDocumentSettingsLanguage =
  (typeof HANDYMAN_DOCUMENT_SETTINGS_LANGUAGES)[number];

export function isHandymanDocumentSettingsKind(
  value: unknown,
): value is HandymanDocumentSettingsKind {
  return (
    typeof value === 'string' &&
    (HANDYMAN_DOCUMENT_SETTINGS_KINDS as readonly string[]).includes(value)
  );
}

export function isHandymanDocumentSettingsLanguage(
  value: unknown,
): value is HandymanDocumentSettingsLanguage {
  return (
    typeof value === 'string' &&
    (HANDYMAN_DOCUMENT_SETTINGS_LANGUAGES as readonly string[]).includes(value)
  );
}

export const HANDYMAN_DOCUMENT_SETTINGS_STATUSES = ['ACTIVE', 'SUPERSEDED'] as const;
export type HandymanDocumentSettingsStatus =
  (typeof HANDYMAN_DOCUMENT_SETTINGS_STATUSES)[number];

/** The writable content vocabulary. Nothing else may be set, ever. */
export const HANDYMAN_DOCUMENT_SETTINGS_FIELDS = [
  'documentPrefix',
  'termsLines',
  'paymentNote',
  'warrantyNote',
  'footerNote',
  'contactNote',
  'signatoryName',
  'signatoryTitle',
] as const;
export type HandymanDocumentSettingsField =
  (typeof HANDYMAN_DOCUMENT_SETTINGS_FIELDS)[number];

export const HANDYMAN_DOCUMENT_SETTINGS_REQUIRED_FIELDS = [
  'documentPrefix',
  'signatoryName',
  'signatoryTitle',
] as const satisfies readonly HandymanDocumentSettingsField[];

export const HANDYMAN_DOCUMENT_SETTINGS_OPTIONAL_FIELDS = [
  'termsLines',
  'paymentNote',
  'warrantyNote',
  'footerNote',
  'contactNote',
] as const satisfies readonly HandymanDocumentSettingsField[];

export type HandymanDocumentSettingsContent = {
  /** Numbering namespace only: the issued number itself is never set here. */
  documentPrefix: string;
  termsLines: string[];
  paymentNote: string | null;
  warrantyNote: string | null;
  footerNote: string | null;
  contactNote: string | null;
  /** Identity metadata about who signs. Never a signature, never an approval. */
  signatoryName: string;
  signatoryTitle: string;
};

export type HandymanDocumentSettingsRecord = HandymanDocumentSettingsContent & {
  id: string;
  clientId: string;
  documentKind: HandymanDocumentSettingsKind;
  language: HandymanDocumentSettingsLanguage;
  status: HandymanDocumentSettingsStatus;
  version: number;
  effectiveFrom: Date;
  createdByUserId: string;
  createdAt: Date;
  supersededAt: Date | null;
};

export type PublicHandymanDocumentSettings = HandymanDocumentSettingsContent & {
  id: string;
  clientId: string;
  documentKind: HandymanDocumentSettingsKind;
  language: HandymanDocumentSettingsLanguage;
  status: HandymanDocumentSettingsStatus;
  version: number;
  effectiveFrom: string;
  createdByUserId: string;
  createdAt: string;
  supersededAt: string | null;
};

export type HandymanDocumentSettingsUpdateResult = PublicHandymanDocumentSettings & {
  previousVersion: number | null;
  changedFields: HandymanDocumentSettingsField[];
};

/** The body a Manager sends: the content vocabulary plus the version anchor. */
export type HandymanDocumentSettingsUpdateInput = HandymanDocumentSettingsContent & {
  clientId: string;
  documentKind: HandymanDocumentSettingsKind;
  language: HandymanDocumentSettingsLanguage;
  /** `null` for the first configuration of this kind+language, like 0490. */
  expectedVersion: number | null;
};

/**
 * The read-only snapshot a future document render pins. Immutable and
 * self-describing (settings id + version + canonical digest), so a later
 * settings change cannot alter what an issued document said, and the snapshot
 * carries no field that could override a commercial or acceptance fact.
 */
export type HandymanDocumentSettingsSnapshot = Readonly<
  HandymanDocumentSettingsContent & {
    settingsId: string;
    clientId: string;
    documentKind: HandymanDocumentSettingsKind;
    language: HandymanDocumentSettingsLanguage;
    version: number;
    payloadChecksum: string;
    checksumAlgorithm: 'SHA-256';
  }
>;

export const HANDYMAN_DOCUMENT_SETTINGS_EVENT_TYPES = {
  created: 'HANDYMAN_DOCUMENT_SETTINGS_CREATED',
  updated: 'HANDYMAN_DOCUMENT_SETTINGS_UPDATED',
} as const;

export const HANDYMAN_DOCUMENT_SETTINGS_ENTITY_TYPE = 'HANDYMAN_DOCUMENT_SETTINGS';
