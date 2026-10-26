/**
 * CR-HM-DOCUMENT-PDF-01 PART 01 — shared official-document PDF rendering.
 *
 * Bounded on purpose: a layout renderer, its frozen input vocabulary and its
 * pure presentation helpers. No repository, no router, no permission and no
 * storage driver belong here yet - the owning business modules decide WHEN an
 * official document may be produced and persist the artifact.
 */
export { renderHandymanDocumentPdf } from './handyman-document-pdf';
export { HandymanDocumentPdfError } from './handyman-document-pdf.errors';
export {
  formatHandymanDocumentDate,
  formatHandymanDocumentInteger,
  formatHandymanDocumentMoney,
  formatHandymanDocumentQuantity,
  handymanDocumentLines,
  handymanDocumentText,
  HANDYMAN_DOCUMENT_MISSING,
} from './handyman-document-format';
export {
  HANDYMAN_DOCUMENT_KINDS,
  HANDYMAN_DOCUMENT_LOCALES,
  HANDYMAN_DOCUMENT_PDF_CHECKSUM_ALGORITHM,
  HANDYMAN_DOCUMENT_PDF_CONTENT_TYPE,
  HANDYMAN_DOCUMENT_PDF_ERROR_CODES,
  HANDYMAN_DOCUMENT_PDF_LIMITS,
  isHandymanDocumentKind,
} from './handyman-document-pdf.types';
export type {
  HandymanDocumentConsentBlock,
  HandymanDocumentEvidenceRef,
  HandymanDocumentKind,
  HandymanDocumentKeyValue,
  HandymanDocumentLineItem,
  HandymanDocumentLocale,
  HandymanDocumentParty,
  HandymanDocumentPdfErrorCode,
  HandymanDocumentPdfRenderOptions,
  HandymanDocumentPdfRenderResult,
  HandymanDocumentSnapshot,
  HandymanDocumentStatusBlock,
  HandymanDocumentTermsBlock,
  HandymanDocumentTotalRow,
} from './handyman-document-pdf.types';
