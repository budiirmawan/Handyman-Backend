/**
 * CR-HM-DOCUMENT-PDF-01 PART 01 — the renderer's own error type.
 *
 * Deliberately NOT an `AppError`: this layer sits below HTTP, so it must not
 * invent status codes or error-code registry entries. The caller that owns the
 * document lifecycle maps these codes to its transport.
 */
import type { HandymanDocumentPdfErrorCode } from './handyman-document-pdf.types';

export class HandymanDocumentPdfError extends Error {
  readonly code: HandymanDocumentPdfErrorCode;

  constructor(code: HandymanDocumentPdfErrorCode, message: string) {
    super(message);
    this.name = 'HandymanDocumentPdfError';
    this.code = code;
  }
}
