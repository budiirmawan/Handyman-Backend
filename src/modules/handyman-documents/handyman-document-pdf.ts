/**
 * CR-HM-DOCUMENT-PDF-01 PART 01 — the shared official-business-document PDF
 * renderer (ONE A4 layout for Quotation, BAST, Invoice, Warranty Certificate
 * and Scope Variation / Change Order).
 *
 * WHAT THIS IS
 *   A pure function over a frozen snapshot: `renderHandymanDocumentPdf(snapshot)`
 *   -> `{ bytes, contentType, filename, fileSize, checksum, checksumAlgorithm,
 *   pageCount }`. It renders: letterhead (issuer block), document identity
 *   panel (type, number, version, issue date, validity, currency, reference),
 *   recipient + property blocks, a dynamic line-item table, a totals / down
 *   payment / terms section, a status & verification reference block, an
 *   optional consent + evidence reference block, and a footer with page
 *   numbering on every page. Multi-page flow is safe: rows and blocks re-page
 *   instead of overflowing, and a table re-draws its header on each page.
 *
 * WHAT THIS IS NOT
 *   - Not a persistence layer: no table, no storage key, no route, no
 *     permission and no lifecycle gate. The owning module decides WHEN a
 *     document may be produced and stores the artifact; this layer only turns
 *     the frozen content into bytes.
 *   - Not a data source: it NEVER invents a logo, signature, approval, document
 *     number, date or price. Optional input is rendered as `-` or the block is
 *     omitted, so a missing fact is visible as missing instead of guessed.
 *   - Not a report renderer: `reporting-export/pdf-renderer.ts` stays the
 *     tabular-report seam; this layout shares its proven primitives
 *     (`safeFilename`, `checksumBytes`) and the same PDF conventions instead of
 *     duplicating them.
 *   - Not a calculation engine: totals, discounts, DP and deltas are drawn
 *     exactly as supplied; the renderer performs no arithmetic on amounts.
 *
 * DETERMINISM (required for checksums and idempotent re-issue): identical
 * snapshot in, byte-identical PDF out. No clock, no host locale/ICU, no
 * timezone, no randomness and no embedded document dates; Standard fonts only
 * (no font subsetting that could vary per platform); fixed WinAnsi-safe text
 * normalization.
 */

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import { checksumBytes, CsvRendererError, safeFilename } from '../reporting-export/csv-renderer';
import {
  formatHandymanDocumentDate,
  formatHandymanDocumentInteger,
  formatHandymanDocumentMoney,
  formatHandymanDocumentQuantity,
  handymanDocumentLines,
  handymanDocumentText,
  HANDYMAN_DOCUMENT_MISSING,
} from './handyman-document-format';
import { HandymanDocumentPdfError } from './handyman-document-pdf.errors';
import {
  HANDYMAN_DOCUMENT_KINDS,
  HANDYMAN_DOCUMENT_LOCALES,
  HANDYMAN_DOCUMENT_PDF_CHECKSUM_ALGORITHM,
  HANDYMAN_DOCUMENT_PDF_CONTENT_TYPE,
  HANDYMAN_DOCUMENT_PDF_LIMITS,
  isHandymanDocumentKind,
  type HandymanDocumentConsentBlock,
  type HandymanDocumentKind,
  type HandymanDocumentKeyValue,
  type HandymanDocumentLineItem,
  type HandymanDocumentLocale,
  type HandymanDocumentPdfRenderOptions,
  type HandymanDocumentPdfRenderResult,
  type HandymanDocumentSnapshot,
  type HandymanDocumentStatusBlock,
} from './handyman-document-pdf.types';

// --- geometry / typography (A4 portrait, points) --------------------------
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;
const FOOTER_HEIGHT = 22;
const CONTENT_LEFT = MARGIN;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const CONTENT_TOP = PAGE_HEIGHT - MARGIN;
const CONTENT_BOTTOM = MARGIN + FOOTER_HEIGHT;
const LINE_HEIGHT = 10.5;
const SECTION_GAP = 11;
const CELL_PADDING = 3;
const BOX_PADDING = 7;
const SIZE_TYPE = 14;
const SIZE_NAME = 10;
const SIZE_BODY = 8.5;
const SIZE_LABEL = 7;
const SIZE_SMALL = 6.8;
const SIZE_CELL = 7.6;
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.42, 0.46, 0.52);
const RULE = rgb(0.75, 0.77, 0.81);
const BAND = rgb(0.93, 0.94, 0.96);

type Column = {
  key: string;
  label: string;
  align: 'left' | 'right';
  weight: number;
};

type Labels = Record<string, string>;

const LABELS: Record<HandymanDocumentLocale, Labels> = {
  id: {
    QUOTATION: 'Quotasi Kerja',
    BAST: 'Berita Acara Serah Terima (BAST)',
    INVOICE: 'Invoice',
    WARRANTY_CERTIFICATE: 'Sertifikat Garansi Layanan',
    VARIATION_ORDER: 'Perubahan Lingkup / Change Order',
    issuer: 'Diterbitkan oleh',
    recipient: 'Kepada',
    property: 'Properti / Lokasi',
    documentNumber: 'Nomor dokumen',
    documentDetails: 'Rincian dokumen',
    version: 'Versi',
    issueDate: 'Tanggal terbit',
    validUntil: 'Berlaku sampai',
    reference: 'Referensi',
    currency: 'Mata uang',
    taxId: 'NPWP',
    phone: 'Telepon',
    email: 'Surel',
    attention: 'Up.',
    items: 'Rincian',
    description: 'Uraian',
    quantity: 'Jml',
    unit: 'Satuan',
    unitAmount: 'Harga satuan',
    discount: 'Potongan',
    total: 'Jumlah',
    totals: 'Ringkasan biaya',
    downPayment: 'Uang muka (DP)',
    downPaymentPercent: 'DP',
    downPaymentNotes: 'Ketentuan DP',
    terms: 'Ketentuan',
    notes: 'Catatan',
    status: 'Status dokumen',
    verifiedBy: 'Diverifikasi oleh',
    verifiedAt: 'Diverifikasi pada',
    consent: 'Persetujuan pelanggan',
    outcome: 'Keputusan',
    actor: 'Oleh',
    actorRole: 'Peran',
    method: 'Metode',
    channel: 'Kanale',
    decidedAt: 'Waktu keputusan',
    evidence: 'Bukti terkait',
    checksum: 'Sidik jari',
    size: 'Ukuran',
    bytes: 'byte',
    page: 'Halaman',
    of: 'dari',
    noItems: 'Tidak ada baris pada dokumen ini.',
    continuation: 'lanjutan',
  },
  en: {
    QUOTATION: 'Work Quotation',
    BAST: 'Handover Acceptance Certificate (BAST)',
    INVOICE: 'Invoice',
    WARRANTY_CERTIFICATE: 'Service Warranty Certificate',
    VARIATION_ORDER: 'Scope Variation / Change Order',
    issuer: 'Issued by',
    recipient: 'To',
    property: 'Property / Location',
    documentNumber: 'Document number',
    documentDetails: 'Document details',
    version: 'Version',
    issueDate: 'Issue date',
    validUntil: 'Valid until',
    reference: 'Reference',
    currency: 'Currency',
    taxId: 'Tax id',
    phone: 'Phone',
    email: 'Email',
    attention: 'Attn.',
    items: 'Line items',
    description: 'Description',
    quantity: 'Qty',
    unit: 'Unit',
    unitAmount: 'Unit price',
    discount: 'Discount',
    total: 'Amount',
    totals: 'Summary',
    downPayment: 'Down payment (DP)',
    downPaymentPercent: 'DP',
    downPaymentNotes: 'DP terms',
    terms: 'Terms',
    notes: 'Notes',
    status: 'Document status',
    verifiedBy: 'Verified by',
    verifiedAt: 'Verified at',
    consent: 'Customer consent',
    outcome: 'Decision',
    actor: 'By',
    actorRole: 'Role',
    method: 'Method',
    channel: 'Channel',
    decidedAt: 'Decision time',
    evidence: 'Linked evidence',
    checksum: 'Digest',
    size: 'Size',
    bytes: 'bytes',
    page: 'Page',
    of: 'of',
    noItems: 'This document carries no line items.',
    continuation: 'continued',
  },
};

/** The five kinds share ONE layout; only the title and the table shape differ. */
const KIND_TITLE_KEY: Record<HandymanDocumentKind, string> = {
  QUOTATION: 'QUOTATION',
  BAST: 'BAST',
  INVOICE: 'INVOICE',
  WARRANTY_CERTIFICATE: 'WARRANTY_CERTIFICATE',
  VARIATION_ORDER: 'VARIATION_ORDER',
};

/** A measured label/value panel row (the ONLY primitive the sections share). */
type PanelRow = { label: string; value: string; emphasised?: boolean };

/** A neutral marker for a field the caller did not supply. */
function field(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return HANDYMAN_DOCUMENT_MISSING;
  const text = handymanDocumentText(value).trim();
  return text === '' ? HANDYMAN_DOCUMENT_MISSING : text;
}

type Ctx = {
  document: PDFDocument;
  pages: PDFPage[];
  page: PDFPage;
  y: number;
  footerLeft: string;
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  locale: HandymanDocumentLocale;
  t: Labels;
  currency: string;
  continuationLabel: string;
};

// ---------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------

export async function renderHandymanDocumentPdf(
  snapshot: HandymanDocumentSnapshot,
  options: HandymanDocumentPdfRenderOptions = {},
): Promise<HandymanDocumentPdfRenderResult> {
  const input = validateSnapshot(snapshot);
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const italic = await document.embedFont(StandardFonts.HelveticaOblique);
  const t = LABELS[input.locale];
  const ctx: Ctx = {
    document,
    pages: [] as PDFPage[],
    page: document.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: CONTENT_TOP,
    regular,
    bold,
    italic,
    locale: input.locale,
    t,
    currency: input.document.currency,
    footerLeft: input.footer?.left ?? '',
    continuationLabel: `${t[KIND_TITLE_KEY[input.document.kind]]} - ${input.document.number}`,
  };

  // Page 1 is created with the context, so it is tracked explicitly: page
  // numbering and the page cap must see every page that exists.
  ctx.pages.push(ctx.page);

  drawLetterhead(ctx, input);
  drawPartiesPanel(ctx, input);
  drawLineItems(ctx, input);
  drawTotals(ctx, input);
  drawTerms(ctx, input);
  drawStatusBlock(ctx, input);
  drawConsentBlock(ctx, input);
  drawClosingNote(ctx, input);
  drawFooters(ctx);

  const bytes = Buffer.from(await document.save());
  let filename: string;
  try {
    filename = safeFilename(
      options.filename,
      input.document.kind.toLowerCase(),
      'document',
      'pdf',
    );
  } catch (error) {
    if (error instanceof CsvRendererError && error.code === 'UNSAFE_FILENAME') {
      throw new HandymanDocumentPdfError('UNSAFE_FILENAME', error.message);
    }
    throw error;
  }
  return {
    bytes,
    contentType: HANDYMAN_DOCUMENT_PDF_CONTENT_TYPE,
    filename,
    fileSize: bytes.length,
    checksum: checksumBytes(bytes),
    checksumAlgorithm: HANDYMAN_DOCUMENT_PDF_CHECKSUM_ALGORITHM,
    pageCount: ctx.pages.length,
  };
}


// ---------------------------------------------------------------------------
// layout engine (flow cursor + measured panels)
// ---------------------------------------------------------------------------

const PANEL_PAD = 7;
const PANEL_GAP = 8;
const MAX_VALUE_LINES = 8;

function newPage(ctx: Ctx, continuation = true): void {
  if (ctx.pages.length >= HANDYMAN_DOCUMENT_PDF_LIMITS.maxPages) {
    throw new HandymanDocumentPdfError(
      'CONTENT_TOO_LARGE',
      `A business document must not exceed ${HANDYMAN_DOCUMENT_PDF_LIMITS.maxPages} pages.`,
    );
  }
  const created = ctx.document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  ctx.pages.push(created);
  ctx.page = created;
  ctx.y = CONTENT_TOP;
  if (continuation) {
    ctx.page.drawText(ctx.continuationLabel, {
      x: CONTENT_LEFT,
      y: ctx.y - SIZE_SMALL,
      size: SIZE_SMALL,
      font: ctx.italic,
      color: MUTED,
    });
    ctx.y -= LINE_HEIGHT + 3;
  }
}

/** Reserves vertical space, starting a new page when the block would overflow. */
function ensure(ctx: Ctx, height: number): void {
  if (ctx.y - height < CONTENT_BOTTOM) newPage(ctx);
}

function wrap(
  value: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const text = value ?? '';
  if (!text) return [''];
  const width = Math.max(18, maxWidth);
  const lines: string[] = [];
  let current = '';
  for (const character of Array.from(text)) {
    const candidate = current + character;
    if (current === '' || font.widthOfTextAtSize(candidate, size) <= width) {
      current = candidate;
    } else {
      lines.push(current);
      current = character;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.join('').length < text.length) {
    const lastIndex = Math.min(lines.length, maxLines) - 1;
    lines[lastIndex] = fitWithEllipsis(lines[lastIndex] ?? '', font, size, width);
  }
  return lines.slice(0, maxLines).map((line) => line.trimEnd());
}

function fitWithEllipsis(value: string, font: PDFFont, size: number, maxWidth: number): string {
  let result = value;
  while (result.length > 0 && font.widthOfTextAtSize(`${result}...`, size) > Math.max(18, maxWidth)) {
    result = result.slice(0, -1);
  }
  return `${result}...`;
}

/** Flows one text value into the current cursor, re-paging between lines. */
function flowValue(
  ctx: Ctx,
  value: string,
  options: {
    font?: PDFFont;
    size?: number;
    color?: ReturnType<typeof rgb>;
    width?: number;
    indent?: number;
    maxLines?: number;
  } = {},
): void {
  const font = options.font ?? ctx.regular;
  const size = options.size ?? SIZE_BODY;
  const indent = options.indent ?? 0;
  const width = Math.max(24, (options.width ?? CONTENT_WIDTH) - indent);
  const lines = wrap(
    value,
    font,
    size,
    width,
    options.maxLines ?? HANDYMAN_DOCUMENT_PDF_LIMITS.maxLinesPerField,
  );
  for (const line of lines) {
    ensure(ctx, LINE_HEIGHT);
    if (line) {
      ctx.page.drawText(line, {
        x: CONTENT_LEFT + indent,
        y: ctx.y - size,
        size,
        font,
        color: options.color ?? INK,
      });
    }
    ctx.y -= LINE_HEIGHT;
  }
}

function sectionTitle(ctx: Ctx, label: string): void {
  ensure(ctx, LINE_HEIGHT * 2);
  ctx.page.drawText(label.toUpperCase(), {
    x: CONTENT_LEFT,
    y: ctx.y - SIZE_LABEL,
    size: SIZE_LABEL,
    font: ctx.bold,
    color: MUTED,
  });
  ctx.y -= LINE_HEIGHT + 1;
}

function drawRule(ctx: Ctx, gap = 5): void {
  ctx.y -= gap;
  ensure(ctx, 3);
  ctx.page.drawLine({
    start: { x: CONTENT_LEFT, y: ctx.y },
    end: { x: CONTENT_RIGHT, y: ctx.y },
    thickness: 0.7,
    color: RULE,
  });
  ctx.y -= gap;
}

function panelLabelWidth(ctx: Ctx, rows: PanelRow[], inner: number): number {
  let widest = 0;
  for (const row of rows) {
    widest = Math.max(widest, ctx.bold.widthOfTextAtSize(row.label, SIZE_LABEL));
  }
  return Math.max(48, Math.min(inner * 0.42, widest + 6));
}

function measurePanel(ctx: Ctx, rows: PanelRow[], width: number): { height: number; inner: number; labelWidth: number } {
  const inner = Math.max(60, width - PANEL_PAD * 2);
  const labelWidth = panelLabelWidth(ctx, rows, inner);
  let lines = 1; // the panel title
  for (const row of rows) {
    lines += wrap(
      row.value,
      row.emphasised ? ctx.bold : ctx.regular,
      row.emphasised ? SIZE_BODY : SIZE_CELL + 0.4,
      inner - labelWidth - 6,
      MAX_VALUE_LINES,
    ).length;
  }
  return { height: PANEL_PAD * 2 + lines * LINE_HEIGHT, inner, labelWidth };
}

/** Draws a bordered panel at an absolute position; never overflows the page. */
function drawPanelAt(
  ctx: Ctx,
  x: number,
  top: number,
  width: number,
  title: string,
  rows: PanelRow[],
): number {
  const { height, inner, labelWidth } = measurePanel(ctx, rows, width);
  ctx.page.drawRectangle({
    x,
    y: top - height,
    width,
    height,
    color: BAND,
    borderColor: RULE,
    borderWidth: 0.6,
  });
  let y = top - PANEL_PAD;
  ctx.page.drawText(title.toUpperCase(), {
    x: x + PANEL_PAD,
    y: y - SIZE_LABEL,
    size: SIZE_LABEL,
    font: ctx.bold,
    color: MUTED,
  });
  y -= LINE_HEIGHT;
  for (const row of rows) {
    const valueFont = row.emphasised ? ctx.bold : ctx.regular;
    const valueSize = row.emphasised ? SIZE_BODY : SIZE_CELL + 0.4;
    const lines = wrap(row.value, valueFont, valueSize, inner - labelWidth - 6, MAX_VALUE_LINES);
    lines.forEach((line, index) => {
      if (index === 0) {
        ctx.page.drawText(fitWithEllipsis(row.label, ctx.bold, SIZE_LABEL, labelWidth), {
          x: x + PANEL_PAD,
          y: y - SIZE_LABEL,
          size: SIZE_LABEL,
          font: ctx.bold,
          color: MUTED,
        });
      }
      if (line) {
        ctx.page.drawText(line, {
          x: x + PANEL_PAD + labelWidth + 6,
          y: y - valueSize,
          size: valueSize,
          font: valueFont,
          color: INK,
        });
      }
      y -= LINE_HEIGHT;
    });
  }
  return height;
}

/** Panel in the flow: kept whole when it fits, degraded to plain text when it does not. */
function drawPanelFlow(
  ctx: Ctx,
  title: string,
  rows: PanelRow[],
  options: { width?: number; x?: number } = {},
): void {
  if (rows.length === 0) return;
  const width = options.width ?? CONTENT_WIDTH;
  const x = options.x ?? CONTENT_LEFT;
  const { height } = measurePanel(ctx, rows, width);
  const pageBudget = CONTENT_TOP - CONTENT_BOTTOM;
  if (height + LINE_HEIGHT * 2 > pageBudget) {
    sectionTitle(ctx, title);
    for (const row of rows) {
      flowValue(ctx, `${row.label}: ${row.value}`, { size: SIZE_BODY });
    }
    ctx.y -= SECTION_GAP - 4;
    return;
  }
  ensure(ctx, height + PANEL_GAP);
  drawPanelAt(ctx, x, ctx.y, width, title, rows);
  ctx.y -= height + PANEL_GAP;
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

/** Letterhead: issuer identity (left) and the document identity panel (right). */
function drawLetterhead(ctx: Ctx, input: ValidatedSnapshot): void {
  const title = input.document.typeLabel ?? ctx.t[KIND_TITLE_KEY[input.document.kind]];
  const issuer = input.issuer;
  const leftWidth = CONTENT_WIDTH * 0.5;
  const rightWidth = CONTENT_WIDTH - leftWidth - 14;

  const issuerLines: string[] = [];
  issuerLines.push(...handymanDocumentLines(issuer.name).slice(0, 2));
  for (const line of issuer.addressLines ?? []) issuerLines.push(...handymanDocumentLines(line));
  if (issuer.attention) issuerLines.push(`${ctx.t.attention}: ${issuer.attention}`);
  if (issuer.taxId) issuerLines.push(`${ctx.t.taxId}: ${issuer.taxId}`);
  const contact: string[] = [];
  if (issuer.phone) contact.push(`${ctx.t.phone}: ${issuer.phone}`);
  if (issuer.email) contact.push(`${ctx.t.email}: ${issuer.email}`);
  if (contact.length > 0) issuerLines.push(contact.join('  |  '));
  for (const row of issuer.references) {
    issuerLines.push(`${row.label}: ${row.value ?? HANDYMAN_DOCUMENT_MISSING}`);
  }

  const identityRows: PanelRow[] = [
    { label: ctx.t.documentNumber, value: input.document.number },
    { label: ctx.t.version, value: field(input.document.version) },
    { label: ctx.t.issueDate, value: input.document.issueDateDisplay ?? HANDYMAN_DOCUMENT_MISSING },
    { label: ctx.t.validUntil, value: input.document.validUntilDisplay ?? HANDYMAN_DOCUMENT_MISSING },
    { label: ctx.t.reference, value: field(input.document.reference) },
    { label: ctx.t.currency, value: input.document.currency },
  ];
  const identity = measurePanel(ctx, identityRows, rightWidth);
  const leftHeight = Math.max(
    SIZE_TYPE + 4 + issuerLines.length * (LINE_HEIGHT - 1),
    identity.height,
  );

  ensure(ctx, leftHeight + 8);
  const top = ctx.y;
  ctx.page.drawText(fitWithEllipsis(title, ctx.bold, SIZE_TYPE, leftWidth), {
    x: CONTENT_LEFT,
    y: top - SIZE_TYPE,
    size: SIZE_TYPE,
    font: ctx.bold,
    color: INK,
  });
  let y = top - SIZE_TYPE - LINE_HEIGHT;
  for (const line of issuerLines) {
    ctx.page.drawText(fitWithEllipsis(line, ctx.regular, SIZE_SMALL, leftWidth), {
      x: CONTENT_LEFT,
      y: y - SIZE_SMALL,
      size: SIZE_SMALL,
      font: ctx.regular,
      color: MUTED,
    });
    y -= LINE_HEIGHT - 1;
  }
  drawPanelAt(ctx, CONTENT_LEFT + leftWidth + 14, top, rightWidth, ctx.t.documentDetails, identityRows);
  ctx.y = top - Math.max(leftHeight, identity.height) - 3;
  drawRule(ctx, 4);
}

/** Recipient + property, side by side when both exist. */
function drawPartiesPanel(ctx: Ctx, input: ValidatedSnapshot): void {
  const recipient = input.recipient;
  const recipientRows: PanelRow[] = [
    { label: recipient.role ?? ctx.t.recipient, value: recipient.name, emphasised: true },
  ];
  for (const line of recipient.addressLines ?? []) {
    recipientRows.push({ label: ' ', value: line });
  }
  if (recipient.attention) recipientRows.push({ label: ctx.t.attention, value: recipient.attention });
  if (recipient.taxId) recipientRows.push({ label: ctx.t.taxId, value: recipient.taxId });
  const contact: string[] = [];
  if (recipient.phone) contact.push(`${ctx.t.phone}: ${recipient.phone}`);
  if (recipient.email) contact.push(`${ctx.t.email}: ${recipient.email}`);
  if (contact.length > 0) recipientRows.push({ label: ' ', value: contact.join('  |  ') });
  for (const row of recipient.references) {
    recipientRows.push({
      label: row.label,
      value: row.value === null || row.value === undefined ? HANDYMAN_DOCUMENT_MISSING : handymanDocumentText(row.value),
    });
  }

  const propertyRows: PanelRow[] = [];
  const property = input.property;
  if (property) {
    if (property.name) propertyRows.push({ label: ctx.t.property, value: property.name, emphasised: true });
    for (const line of property.lines ?? []) propertyRows.push({ label: ' ', value: line });
    for (const row of property.references) {
      propertyRows.push({
        label: row.label,
        value: row.value === null || row.value === undefined ? HANDYMAN_DOCUMENT_MISSING : handymanDocumentText(row.value),
      });
    }
  }

  if (propertyRows.length > 0) {
    const width = (CONTENT_WIDTH - 14) / 2;
    const left = measurePanel(ctx, recipientRows, width).height;
    const right = measurePanel(ctx, propertyRows, width).height;
    const height = Math.max(left, right);
    ensure(ctx, height + PANEL_GAP);
    const top = ctx.y;
    drawPanelAt(ctx, CONTENT_LEFT, top, width, recipient.role ?? ctx.t.recipient, recipientRows);
    drawPanelAt(ctx, CONTENT_LEFT + width + 14, top, width, property?.label ?? ctx.t.property, propertyRows);
    ctx.y = top - height - PANEL_GAP;
    return;
  }
  drawPanelFlow(ctx, recipient.role ?? ctx.t.recipient, recipientRows);
}

/** Dynamic line-item table: only the columns the data actually carries. */
function tableColumns(items: HandymanDocumentLineItem[], t: Labels): Column[] {
  const has = (pick: (item: HandymanDocumentLineItem) => unknown) =>
    items.some((item) => {
      const value = pick(item);
      return value !== null && value !== undefined && value !== '';
    });
  const columns: Column[] = [
    { key: 'description', label: t.description, align: 'left', weight: 34 },
  ];
  if (has((item) => item.quantity !== null)) {
    columns.push({ key: 'quantity', label: t.quantity, align: 'right', weight: 8 });
  }
  if (has((item) => item.unit)) {
    columns.push({ key: 'unit', label: t.unit, align: 'left', weight: 10 });
  }
  if (has((item) => item.unitAmount !== null)) {
    columns.push({ key: 'unitAmount', label: t.unitAmount, align: 'right', weight: 16 });
  }
  if (has((item) => item.discount !== null)) {
    columns.push({ key: 'discount', label: t.discount, align: 'right', weight: 14 });
  }
  if (has((item) => item.total !== null)) {
    columns.push({ key: 'total', label: t.total, align: 'right', weight: 17 });
  }
  if (has((item) => item.note)) {
    columns.push({ key: 'note', label: t.notes, align: 'left', weight: 16 });
  }
  return columns;
}

function columnWidths(columns: Column[]): number[] {
  const totalWeight = columns.reduce((sum, column) => sum + column.weight, 0);
  const raw = columns.map((column) => (CONTENT_WIDTH * column.weight) / totalWeight);
  const min = columns.length > 4 ? 26 : 40;
  return raw.map((width) => Math.max(min, width));
}

function cellValue(
  item: HandymanDocumentLineItem,
  key: string,
  currency: string,
  locale: HandymanDocumentLocale,
): string {
  switch (key) {
    case 'description':
      return item.description;
    case 'quantity':
      return item.quantity == null ? HANDYMAN_DOCUMENT_MISSING : formatHandymanDocumentQuantity(item.quantity, locale);
    case 'unit':
      return item.unit ?? HANDYMAN_DOCUMENT_MISSING;
    case 'unitAmount':
      return item.unitAmount == null ? HANDYMAN_DOCUMENT_MISSING : formatHandymanDocumentMoney(item.unitAmount, currency, locale);
    case 'discount':
      return item.discount == null ? HANDYMAN_DOCUMENT_MISSING : formatHandymanDocumentMoney(item.discount, currency, locale);
    case 'total':
      return item.total == null ? HANDYMAN_DOCUMENT_MISSING : formatHandymanDocumentMoney(item.total, currency, locale);
    case 'note':
      return item.note ?? HANDYMAN_DOCUMENT_MISSING;
    default:
      return HANDYMAN_DOCUMENT_MISSING;
  }
}

function drawLineItems(ctx: Ctx, input: ValidatedSnapshot): void {
  const items = input.lineItems;
  if (items === null) return; // no table requested at all (e.g. a certificate)
  sectionTitle(ctx, ctx.t.items);
  if (items.length === 0) {
    flowValue(ctx, ctx.t.noItems, { font: ctx.italic, size: SIZE_BODY, color: MUTED });
    ctx.y -= SECTION_GAP - 4;
    return;
  }
  const columns = tableColumns(items, ctx.t);
  const widths = columnWidths(columns);

  const drawHeader = (): void => {
    ensure(ctx, LINE_HEIGHT + CELL_PADDING * 2 + 2);
    const top = ctx.y;
    ctx.page.drawRectangle({
      x: CONTENT_LEFT,
      y: top - (LINE_HEIGHT + CELL_PADDING * 2),
      width: CONTENT_WIDTH,
      height: LINE_HEIGHT + CELL_PADDING * 2,
      color: BAND,
    });
    let x = CONTENT_LEFT;
    columns.forEach((column, index) => {
      const label = fitWithEllipsis(column.label.toUpperCase(), ctx.bold, SIZE_CELL, widths[index] - 6);
      const labelY = top - CELL_PADDING - SIZE_CELL;
      ctx.page.drawText(label, {
        x:
          column.align === 'right'
            ? x + widths[index] - CELL_PADDING - ctx.bold.widthOfTextAtSize(label, SIZE_CELL)
            : x + CELL_PADDING,
        y: labelY,
        size: SIZE_CELL,
        font: ctx.bold,
        color: MUTED,
      });
      x += widths[index];
    });
    ctx.y = top - (LINE_HEIGHT + CELL_PADDING * 2);
  };

  drawHeader();
  for (const item of items) {
    const cellLines = columns.map((column, index) =>
      wrap(
        cellValue(item, column.key, ctx.currency, ctx.locale),
        ctx.regular,
        SIZE_CELL,
        widths[index] - CELL_PADDING * 2,
        MAX_VALUE_LINES,
      ),
    );
    const lineCount = Math.max(...cellLines.map((lines) => lines.length));
    const height = lineCount * LINE_HEIGHT + CELL_PADDING;
    if (ctx.y - height < CONTENT_BOTTOM) {
      newPage(ctx);
      drawHeader();
    }
    const top = ctx.y;
    let x = CONTENT_LEFT;
    columns.forEach((column, index) => {
      const lines = cellLines[index] ?? [''];
      lines.forEach((line, lineIndex) => {
        if (!line) return;
        ctx.page.drawText(line, {
          x:
            column.align === 'right'
              ? x + widths[index] - CELL_PADDING - ctx.regular.widthOfTextAtSize(line, SIZE_CELL)
              : x + CELL_PADDING,
          y: top - CELL_PADDING - SIZE_CELL - lineIndex * LINE_HEIGHT,
          size: SIZE_CELL,
          font: ctx.regular,
          color: INK,
        });
      });
      x += widths[index];
    });
    ctx.y = top - height;
    ctx.page.drawLine({
      start: { x: CONTENT_LEFT, y: ctx.y },
      end: { x: CONTENT_RIGHT, y: ctx.y },
      thickness: 0.4,
      color: RULE,
    });
  }
  ctx.y -= SECTION_GAP - 3;
}

/** Totals + down payment block, right aligned under the table. */
function drawTotals(ctx: Ctx, input: ValidatedSnapshot): void {
  const rows: PanelRow[] = input.totals.map((row) => ({
    label: row.label,
    value: formatHandymanDocumentMoney(row.amount, row.currency, ctx.locale),
    emphasised: row.emphasised,
  }));
  const dp = input.document.downPayment;
  if (dp) rows.push(...dp);
  if (rows.length === 0) return;
  const width = Math.min(CONTENT_WIDTH * 0.52, 300);
  const { height } = measurePanel(ctx, rows, width);
  ensure(ctx, height + PANEL_GAP);
  drawPanelAt(ctx, CONTENT_RIGHT - width, ctx.y, width, ctx.t.totals, rows);
  ctx.y -= height + PANEL_GAP;
}

function drawTerms(ctx: Ctx, input: ValidatedSnapshot): void {
  if (input.terms.length === 0) return;
  for (const block of input.terms) {
    sectionTitle(ctx, block.heading ?? ctx.t.terms);
    for (const line of block.lines) {
      flowValue(ctx, line, { size: SIZE_BODY });
    }
    ctx.y -= SECTION_GAP - 4;
  }
}

function drawStatusBlock(ctx: Ctx, input: ValidatedSnapshot): void {
  const status = input.status;
  if (!status) return;
  const rows: PanelRow[] = [
    { label: ctx.t.status, value: status.value, emphasised: true },
    { label: ctx.t.reference, value: status.reference ?? HANDYMAN_DOCUMENT_MISSING },
    { label: ctx.t.verifiedBy, value: status.verifiedBy ?? HANDYMAN_DOCUMENT_MISSING },
    { label: ctx.t.verifiedAt, value: status.verifiedAt ?? HANDYMAN_DOCUMENT_MISSING },
  ];
  for (const line of status.lines ?? []) rows.push({ label: ' ', value: line });
  drawPanelFlow(ctx, status.label ?? ctx.t.status, rows);
}

/** Consent + evidence references. No signature is ever drawn or implied. */
function drawConsentBlock(ctx: Ctx, input: ValidatedSnapshot): void {
  const consent = input.consent;
  if (!consent) return;
  const rows: PanelRow[] = [
    { label: ctx.t.outcome, value: consent.outcome, emphasised: true },
    { label: ctx.t.actor, value: consent.actorName ?? HANDYMAN_DOCUMENT_MISSING },
    { label: ctx.t.actorRole, value: consent.actorRole ?? HANDYMAN_DOCUMENT_MISSING },
    { label: ctx.t.method, value: consent.method ?? HANDYMAN_DOCUMENT_MISSING },
    { label: ctx.t.channel, value: consent.channel ?? HANDYMAN_DOCUMENT_MISSING },
    { label: ctx.t.decidedAt, value: consent.decidedAt ?? HANDYMAN_DOCUMENT_MISSING },
    { label: ctx.t.reference, value: consent.reference ?? HANDYMAN_DOCUMENT_MISSING },
  ];
  drawPanelFlow(ctx, consent.label ?? ctx.t.consent, rows);
  const evidence = consent.evidence ?? [];
  if (evidence.length === 0) return;
  const evidenceRows: PanelRow[] = evidence.map((entry) => {
    const parts = [entry.value];
    if (entry.algorithm) parts.push(entry.algorithm.toUpperCase());
    if (entry.sizeBytes !== null && entry.sizeBytes !== undefined) {
      parts.push(`${formatHandymanDocumentInteger(entry.sizeBytes, ctx.locale)} ${ctx.t.bytes}`);
    }
    return { label: entry.label, value: parts.join(' - ') };
  });
  drawPanelFlow(ctx, ctx.t.evidence, evidenceRows);
}

function drawClosingNote(ctx: Ctx, input: ValidatedSnapshot): void {
  const note = input.footer?.note;
  if (!note) return;
  ctx.y -= 2;
  flowValue(ctx, note, { font: ctx.italic, size: SIZE_SMALL, color: MUTED });
}

/** Rule + left text + page numbering on every page, drawn after the content. */
function drawFooters(ctx: Ctx): void {
  const total = ctx.pages.length;
  const left = ctx.footerLeft;
  ctx.pages.forEach((page, index) => {
    page.drawLine({
      start: { x: CONTENT_LEFT, y: MARGIN - 10 },
      end: { x: CONTENT_RIGHT, y: MARGIN - 10 },
      thickness: 0.5,
      color: RULE,
    });
    const label = `${ctx.t.page} ${index + 1} ${ctx.t.of} ${total}`;
    page.drawText(label, {
      x: CONTENT_RIGHT - ctx.regular.widthOfTextAtSize(label, SIZE_SMALL),
      y: MARGIN - 20,
      size: SIZE_SMALL,
      font: ctx.regular,
      color: MUTED,
    });
    if (left) {
      page.drawText(fitWithEllipsis(left, ctx.regular, SIZE_SMALL, CONTENT_WIDTH - 90), {
        x: CONTENT_LEFT,
        y: MARGIN - 20,
        size: SIZE_SMALL,
        font: ctx.regular,
        color: MUTED,
      });
    }
  });
}


type ValidatedSnapshot = ReturnType<typeof validateSnapshot>;

function validateSnapshot(snapshot: HandymanDocumentSnapshot) {
  if (!isPlainObject(snapshot)) {
    throw new HandymanDocumentPdfError(
      'INVALID_LAYOUT',
      'A business document snapshot must be a plain object.',
    );
  }
  assertKeys(snapshot, [
    'locale',
    'utcOffsetMinutes',
    'document',
    'issuer',
    'recipient',
    'property',
    'lineItems',
    'totals',
    'terms',
    'status',
    'consent',
    'footer',
  ], '');
  const locale = readLocale(snapshot.locale);
  const t = LABELS[locale];
  const offset = readOffset(snapshot.utcOffsetMinutes);
  const documentBlock = readDocument(snapshot.document, t, locale, offset);
  const issuer = readParty(snapshot.issuer, 'issuer', t);
  const recipient = readParty(snapshot.recipient, 'recipient', t);
  const property = readProperty(snapshot.property, t);
  const lineItems = readLineItems(snapshot.lineItems, documentBlock.currency);
  const totals = readTotals(snapshot.totals, documentBlock.currency);
  const terms = readTerms(snapshot.terms, t);
  const status = readStatus(snapshot.status, t, offset);
  const consent = readConsent(snapshot.consent, t, offset);
  const footer = readFooter(snapshot.footer);
  return {
    locale,
    utcOffsetMinutes: offset,
    document: documentBlock,
    issuer,
    recipient,
    property,
    lineItems,
    totals,
    terms,
    status,
    consent,
    footer,
  };
}

function readLocale(value: unknown): HandymanDocumentLocale {
  if (value === undefined || value === null) return 'id';
  if (
    typeof value !== 'string' ||
    !(HANDYMAN_DOCUMENT_LOCALES as readonly string[]).includes(value)
  ) {
    throw new HandymanDocumentPdfError(
      'INVALID_LAYOUT',
      `Locale must be one of ${HANDYMAN_DOCUMENT_LOCALES.join(', ')}.`,
    );
  }
  return value as HandymanDocumentLocale;
}

function readOffset(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > 840) {
    throw new HandymanDocumentPdfError(
      'INVALID_LAYOUT',
      'utcOffsetMinutes must be an integer number of minutes within +/-14 hours.',
    );
  }
  return value;
}

function readDocument(value: unknown, t: Labels, locale: HandymanDocumentLocale, offset: number) {
  if (!isPlainObject(value)) {
    throw new HandymanDocumentPdfError('INVALID_LAYOUT', 'A document block is required.');
  }
  assertKeys(value, ['kind', 'typeLabel', 'number', 'version', 'issueDate', 'currency', 'reference', 'validUntil', 'downPayment'], 'document');
  const block = value as Record<string, unknown>;
  const kind = block.kind;
  if (!isHandymanDocumentKind(kind)) {
    throw new HandymanDocumentPdfError(
      'UNSUPPORTED_FIELD',
      `Document kind must be one of ${HANDYMAN_DOCUMENT_KINDS.join(', ')}.`,
    );
  }
  const number = requireText(block.number, 'document.number', 80);
  const currency = readCurrency(block.currency, 'document.currency');
  const version =
    block.version === undefined || block.version === null
      ? null
      : typeof block.version === 'number'
        ? String(block.version)
        : requireText(block.version, 'document.version', 40);
  const issueDateDisplay = block.issueDate === undefined || block.issueDate === null
    ? null
    : formatHandymanDocumentDate(block.issueDate as string | Date, locale, offset);
  const validUntilDisplay = block.validUntil === undefined || block.validUntil === null
    ? null
    : formatHandymanDocumentDate(block.validUntil as string | Date, locale, offset);
  const downPayment = readDownPayment(block.downPayment, t, currency);
  return {
    kind,
    typeLabel: optionalText(block.typeLabel, 'document.typeLabel', 120),
    number,
    version,
    reference: optionalText(block.reference, 'document.reference', 120),
    currency,
    issueDateDisplay,
    validUntilDisplay,
    downPayment,
  };
}

function readDownPayment(value: unknown, t: Labels, currency: string) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw new HandymanDocumentPdfError('INVALID_LAYOUT', 'document.downPayment must be an object.');
  }
  assertKeys(value, ['percentage', 'amount', 'notes'], 'document.downPayment');
  const block = value as Record<string, unknown>;
  const percentage = block.percentage === undefined || block.percentage === null
    ? null
    : readFinite(block.percentage, 'document.downPayment.percentage', 100);
  const amount = block.amount === undefined || block.amount === null
    ? null
    : readFinite(block.amount, 'document.downPayment.amount', 999_999_999_999_999);
  const notes = optionalText(block.notes, 'document.downPayment.notes', 600);
  if (percentage === null && amount === null && !notes) return null;
  const rows: { label: string; value: string }[] = [];
  if (percentage !== null) {
    rows.push({
      label: t.downPaymentPercent,
      value: `${formatHandymanDocumentQuantity(percentage, 'id')} %`,
    });
  }
  if (amount !== null) {
    rows.push({ label: t.downPayment, value: formatHandymanDocumentMoney(amount, currency, 'id') });
  }
  if (notes) rows.push({ label: t.downPaymentNotes, value: notes });
  return rows;
}

function readParty(value: unknown, path: string, t: Labels) {
  if (!isPlainObject(value)) {
    throw new HandymanDocumentPdfError('INVALID_LAYOUT', `A ${path} block is required.`);
  }
  assertKeys(value, ['role', 'name', 'attention', 'addressLines', 'taxId', 'phone', 'email', 'references'], path);
  const block = value as Record<string, unknown>;
  return {
    role: optionalText(block.role, `${path}.role`, 80) ?? (path === 'issuer' ? t.issuer : t.recipient),
    name: requireText(block.name, `${path}.name`, 200),
    attention: optionalText(block.attention, `${path}.attention`, 120),
    addressLines: readLines(block.addressLines, `${path}.addressLines`, t),
    taxId: optionalText(block.taxId, `${path}.taxId`, 60),
    phone: optionalText(block.phone, `${path}.phone`, 60),
    email: optionalText(block.email, `${path}.email`, 120),
    references: readKeyValues(block.references, `${path}.references`, t),
  };
}

function readProperty(value: unknown, t: Labels) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw new HandymanDocumentPdfError('INVALID_LAYOUT', 'property must be an object.');
  }
  assertKeys(value, ['label', 'name', 'lines', 'references'], 'property');
  const block = value as Record<string, unknown>;
  const lines = readLines(block.lines, 'property.lines', t);
  const references = readKeyValues(block.references, 'property.references', t);
  const name = optionalText(block.name, 'property.name', 200);
  if (!name && lines.length === 0 && references.length === 0) return null;
  return {
    label: optionalText(block.label, 'property.label', 80) ?? t.property,
    name,
    lines,
    references,
  };
}

function readKeyValues(value: unknown, path: string, _t: Labels): HandymanDocumentKeyValue[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > HANDYMAN_DOCUMENT_PDF_LIMITS.maxKeyValues) {
    throw new HandymanDocumentPdfError(
      'INVALID_LAYOUT',
      `${path} must be an array of at most ${HANDYMAN_DOCUMENT_PDF_LIMITS.maxKeyValues} entries.`,
    );
  }
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new HandymanDocumentPdfError('INVALID_LAYOUT', `${path}[${index}] must be an object.`);
    }
    assertKeys(entry, ['label', 'value'], `${path}[${index}]`);
    const row = entry as Record<string, unknown>;
    return {
      label: requireText(row.label, `${path}[${index}].label`, 80),
      value:
        typeof row.value === 'number' || typeof row.value === 'boolean'
          ? String(row.value)
          : optionalText(row.value, `${path}[${index}].value`, 300),
    };
  });
}

function readLines(value: unknown, path: string, _t: Labels, maxLines: number = HANDYMAN_DOCUMENT_PDF_LIMITS.maxAddressLines): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxLines) {
    throw new HandymanDocumentPdfError(
      'INVALID_LAYOUT',
      `${path} must be an array of at most ${maxLines} lines.`,
    );
  }
  return value
    .map((entry, index) => requireText(entry, `${path}[${index}]`, 200))
    .filter((entry) => entry.length > 0);
}

function readCurrency(value: unknown, path: string): string {
  if (value === undefined || value === null || value === '') return 'IDR';
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) {
    throw new HandymanDocumentPdfError(
      'INVALID_LAYOUT',
      `${path} must be an ISO-4217 alpha-3 currency code.`,
    );
  }
  return value.toUpperCase();
}

function readLineItems(value: unknown, currency: string): HandymanDocumentLineItem[] | null {
  if (value === undefined) return null;
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new HandymanDocumentPdfError('INVALID_LAYOUT', 'lineItems must be an array.');
  }
  if (value.length > HANDYMAN_DOCUMENT_PDF_LIMITS.maxLineItems) {
    throw new HandymanDocumentPdfError(
      'CONTENT_TOO_LARGE',
      `lineItems must not exceed ${HANDYMAN_DOCUMENT_PDF_LIMITS.maxLineItems} rows.`,
    );
  }
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new HandymanDocumentPdfError('INVALID_LAYOUT', `lineItems[${index}] must be an object.`);
    }
    assertKeys(entry, ['description', 'quantity', 'unit', 'unitAmount', 'discount', 'total', 'note'], `lineItems[${index}]`);
    const block = entry as Record<string, unknown>;
    return {
      description: requireText(block.description, `lineItems[${index}].description`, 400),
      quantity: optionalFinite(block.quantity, `lineItems[${index}].quantity`),
      unit: optionalText(block.unit, `lineItems[${index}].unit`, 40),
      unitAmount: optionalAmount(block.unitAmount, `lineItems[${index}].unitAmount`, currency),
      discount: optionalAmount(block.discount, `lineItems[${index}].discount`, currency),
      total: optionalAmount(block.total, `lineItems[${index}].total`, currency),
      note: optionalText(block.note, `lineItems[${index}].note`, 300),
    };
  });
}

function readTotals(value: unknown, currency: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > HANDYMAN_DOCUMENT_PDF_LIMITS.maxTotalsRows) {
    throw new HandymanDocumentPdfError(
      'INVALID_LAYOUT',
      `totals must be an array of at most ${HANDYMAN_DOCUMENT_PDF_LIMITS.maxTotalsRows} rows.`,
    );
  }
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new HandymanDocumentPdfError('INVALID_LAYOUT', `totals[${index}] must be an object.`);
    }
    assertKeys(entry, ['label', 'amount', 'emphasised'], `totals[${index}]`);
    const block = entry as Record<string, unknown>;
    return {
      label: requireText(block.label, `totals[${index}].label`, 120),
      amount: optionalAmount(block.amount, `totals[${index}].amount`, currency, true) as number,
      emphasised: block.emphasised === true,
      currency,
    };
  });
}

function readTerms(value: unknown, t: Labels) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > HANDYMAN_DOCUMENT_PDF_LIMITS.maxTermsBlocks) {
    throw new HandymanDocumentPdfError(
      'INVALID_LAYOUT',
      `terms must be an array of at most ${HANDYMAN_DOCUMENT_PDF_LIMITS.maxTermsBlocks} blocks.`,
    );
  }
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new HandymanDocumentPdfError('INVALID_LAYOUT', `terms[${index}] must be an object.`);
    }
    assertKeys(entry, ['heading', 'lines'], `terms[${index}]`);
    const block = entry as Record<string, unknown>;
    const lines = readLines(block.lines, `terms[${index}].lines`, t, HANDYMAN_DOCUMENT_PDF_LIMITS.maxTermsLines);
    if (lines.length > HANDYMAN_DOCUMENT_PDF_LIMITS.maxTermsLines) {
      throw new HandymanDocumentPdfError(
        'CONTENT_TOO_LARGE',
        `terms[${index}].lines must not exceed ${HANDYMAN_DOCUMENT_PDF_LIMITS.maxTermsLines} lines.`,
      );
    }
    return { heading: optionalText(block.heading, `terms[${index}].heading`, 120), lines };
  });
}

function readStatus(value: unknown, t: Labels, offset: number): HandymanDocumentStatusBlock | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw new HandymanDocumentPdfError('INVALID_LAYOUT', 'status must be an object.');
  }
  assertKeys(value, ['label', 'value', 'reference', 'verifiedBy', 'verifiedAt', 'lines'], 'status');
  const block = value as Record<string, unknown>;
  return {
    label: optionalText(block.label, 'status.label', 80) ?? t.status,
    value: requireText(block.value, 'status.value', 60),
    reference: optionalText(block.reference, 'status.reference', 120),
    verifiedBy: optionalText(block.verifiedBy, 'status.verifiedBy', 200),
    verifiedAt:
      block.verifiedAt === undefined || block.verifiedAt === null
        ? null
        : formatHandymanDocumentDate(block.verifiedAt as string | Date, 'id', offset, true),
    lines: readLines(block.lines, 'status.lines', t),
  };
}

function readConsent(value: unknown, t: Labels, offset: number): HandymanDocumentConsentBlock | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw new HandymanDocumentPdfError('INVALID_LAYOUT', 'consent must be an object.');
  }
  assertKeys(
    value,
    ['label', 'outcome', 'actorName', 'actorRole', 'method', 'channel', 'decidedAt', 'reference', 'evidence'],
    'consent',
  );
  const block = value as Record<string, unknown>;
  const evidence = block.evidence === undefined || block.evidence === null
    ? []
    : (Array.isArray(block.evidence) ? block.evidence : []).map((entry, index) => {
        if (!isPlainObject(entry)) {
          throw new HandymanDocumentPdfError('INVALID_LAYOUT', `consent.evidence[${index}] must be an object.`);
        }
        assertKeys(entry, ['label', 'value', 'algorithm', 'sizeBytes'], `consent.evidence[${index}]`);
        const row = entry as Record<string, unknown>;
        return {
          label: requireText(row.label, `consent.evidence[${index}].label`, 80),
          value: requireText(row.value, `consent.evidence[${index}].value`, 120),
          algorithm: optionalText(row.algorithm, `consent.evidence[${index}].algorithm`, 20),
          sizeBytes:
            row.sizeBytes === undefined || row.sizeBytes === null
              ? null
              : Number(row.sizeBytes),
        };
      });
  if (evidence.length > HANDYMAN_DOCUMENT_PDF_LIMITS.maxEvidenceRows) {
    throw new HandymanDocumentPdfError(
      'CONTENT_TOO_LARGE',
      `consent.evidence must not exceed ${HANDYMAN_DOCUMENT_PDF_LIMITS.maxEvidenceRows} rows.`,
    );
  }
  return {
    label: optionalText(block.label, 'consent.label', 80) ?? t.consent,
    outcome: requireText(block.outcome, 'consent.outcome', 40),
    actorName: optionalText(block.actorName, 'consent.actorName', 200),
    actorRole: optionalText(block.actorRole, 'consent.actorRole', 80),
    method: optionalText(block.method, 'consent.method', 80),
    channel: optionalText(block.channel, 'consent.channel', 60),
    decidedAt:
      block.decidedAt === undefined || block.decidedAt === null
        ? null
        : formatHandymanDocumentDate(block.decidedAt as string | Date, 'id', offset, true),
    reference: optionalText(block.reference, 'consent.reference', 120),
    evidence,
  };
}

function readFooter(value: unknown) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw new HandymanDocumentPdfError('INVALID_LAYOUT', 'footer must be an object.');
  }
  assertKeys(value, ['left', 'note'], 'footer');
  const block = value as Record<string, unknown>;
  return {
    left: optionalText(block.left, 'footer.left', 200),
    note: optionalText(block.note, 'footer.note', 400),
  };
}

function optionalFinite(value: unknown, path: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  return readFinite(value, path, 1_000_000_000_000);
}

function readFinite(value: unknown, path: string, limit: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) {
    throw new HandymanDocumentPdfError('INVALID_LAYOUT', `${path} must be a finite number.`);
  }
  return value;
}

function optionalAmount(
  value: unknown,
  path: string,
  _currency: string,
  required = false,
): number | null {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new HandymanDocumentPdfError('INVALID_MONEY_VALUE', `${path} is required.`);
    }
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 999_999_999_999_999) {
    throw new HandymanDocumentPdfError(
      'INVALID_MONEY_VALUE',
      `${path} must be a finite amount inside the supported range.`,
    );
  }
  return value;
}

function requireText(value: unknown, path: string, maxLength: number): string {
  const text = optionalText(value, path, maxLength);
  if (!text) {
    throw new HandymanDocumentPdfError('INVALID_LAYOUT', `${path} is required.`);
  }
  return text;
}

function optionalText(value: unknown, path: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new HandymanDocumentPdfError('INVALID_LAYOUT', `${path} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new HandymanDocumentPdfError(
      'CONTENT_TOO_LARGE',
      `${path} must not exceed ${maxLength} characters.`,
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new HandymanDocumentPdfError('INVALID_LAYOUT', `${path} contains control characters.`);
  }
  const normalized = handymanDocumentText(value);
  return normalized === '' ? null : normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new HandymanDocumentPdfError(
        'UNSUPPORTED_FIELD',
        `Unknown field "${path ? `${path}.` : ''}${key}" - the renderer accepts only documented layout fields.`,
      );
    }
  }
}
