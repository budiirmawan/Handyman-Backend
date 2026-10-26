/**
 * CR-HM-DOCUMENT-PDF-01 PART 01 — focused renderer tests.
 *
 * Pure rendering only: no database, no routes, no storage. These checks are
 * the contract this layer must keep for every document type: valid A4 output,
 * byte-determinism for a frozen input (so a checksum and an idempotent
 * re-issue are meaningful), safe multi-page flow with fail-closed caps,
 * Indonesian money/date/text handling, omission instead of invention for
 * optional blocks, and refusal of anything the layout does not know.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import {
  HandymanDocumentPdfError,
  renderHandymanDocumentPdf,
  type HandymanDocumentSnapshot,
} from '../src/modules/handyman-documents';
import {
  formatHandymanDocumentDate,
  formatHandymanDocumentMoney,
  formatHandymanDocumentQuantity,
  handymanDocumentText,
} from '../src/modules/handyman-documents/handyman-document-format';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A frozen quotation snapshot: the exact shape the lifecycle will feed in. */
function quotationSnapshot(
  overrides: Partial<HandymanDocumentSnapshot> = {},
): HandymanDocumentSnapshot {
  return {
    locale: 'id',
    utcOffsetMinutes: 420,
    document: {
      kind: 'QUOTATION',
      number: 'QT-2026-000123',
      version: 'v2',
      issueDate: '2026-10-26T02:45:00.000Z',
      validUntil: '2026-11-09T23:59:59.000Z',
      currency: 'IDR',
      reference: 'REQ-8891',
      downPayment: {
        percentage: 20,
        amount: 420000,
        notes: 'DP dibayar sebelum kerja dimulai.',
      },
    },
    issuer: {
      name: 'PT Asentra Layanan Prima',
      addressLines: ['Jl. Kenanga No. 88, Jakarta Selatan 12550'],
      taxId: '01.234.567.8-901.000',
      phone: '+62 21 5000 1111',
      email: 'operations@asentra.test',
    },
    recipient: {
      name: 'Budi Hartono',
      attention: 'Building Manager',
      addressLines: ['Tenant Company: PT Karya Mandiri', 'Gedong Sudirman, Lantai 12'],
      references: [{ label: 'No. pelanggan', value: 'CUS-0042' }],
    },
    property: {
      name: 'Gedong Sudirman',
      lines: ['Jl. Sudirman Kav. 21, Jakarta Pusat', 'Ruang teknis Lantai 12 - Panel MDP'],
      references: [{ label: 'Building code', value: 'BLD-014' }],
    },
    lineItems: [
      {
        description: 'Perbaikan instalasi listrik panel MDP termasuk pengecekan beban',
        quantity: 10,
        unit: 'jam',
        unitAmount: 150000,
        total: 1500000,
        note: 'Termasuk tes isolasi dan laporan hasil',
      },
      {
        description: 'Material: kabel NYY 4x16 mm2',
        quantity: 2,
        unit: 'roll',
        unitAmount: 300000,
        discount: 0,
        total: 600000,
      },
    ],
    totals: [
      { label: 'Subtotal tenaga kerja', amount: 1500000 },
      { label: 'Subtotal material', amount: 600000 },
      { label: 'Total', amount: 2100000, emphasised: true },
    ],
    terms: [
      {
        heading: 'Ketentuan pembayaran',
        lines: [
          'DP 20% dibayar setelah persetujuan.',
          'Pelunasan setelah pekerjaan selesai dan BAST ditandatangani.',
        ],
      },
      {
        heading: 'Catatan',
        lines: ['Harga belum termasuk pekerjaan tambahan di luar lingkup.'],
      },
    ],
    status: {
      value: 'ISSUED',
      reference: 'quotation-version-4f2a',
      verifiedBy: 'Operations - Rina',
      verifiedAt: '2026-10-26T02:46:10.000Z',
      lines: ['Quotation issued to the tenant PIC for decision.'],
    },
    consent: {
      outcome: 'APPROVE',
      actorName: 'Budi Hartono',
      actorRole: 'Tenant PIC',
      method: 'IN_APP',
      channel: 'EMAIL',
      decidedAt: '2026-10-27T09:15:00.000Z',
      reference: 'decision-7c11',
      evidence: [
        { label: 'Bukti foto', value: 'evidence-9a12', algorithm: 'sha256', sizeBytes: 128344 },
      ],
    },
    footer: {
      left: 'Dokumen resmi - dihasilkan dari catatan sistem',
      note: 'Simpan dokumen ini sebagai bukti persetujuan.',
    },
    ...overrides,
  };
}

function longItems(count: number, length: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    description: `Uraian panjang ${index} - ${'x'.repeat(Math.max(0, length - 20))}`,
    quantity: 1,
    unitAmount: 1000,
    total: 1000,
  }));
}

function errorOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => 'ALLOWED',
    (error: unknown) => (error as HandymanDocumentPdfError).code,
  );
}

describe('CR-HM-DOCUMENT-PDF-01 PART 01 - shared business PDF renderer', () => {
  it('renders a valid A4 PDF for the frozen quotation snapshot', async () => {
    const rendered = await renderHandymanDocumentPdf(quotationSnapshot());
    assert.equal(rendered.contentType, 'application/pdf');
    assert.equal(rendered.filename, 'quotation-document.pdf');
    assert.equal(rendered.pageCount, 1);
    assert.equal(rendered.fileSize, rendered.bytes.length);
    assert.equal(rendered.checksumAlgorithm, 'SHA-256');
    assert.equal(rendered.checksum, sha(rendered.bytes));
    assert.equal(rendered.bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(
      rendered.bytes.subarray(-16).toString('latin1').includes('%%EOF'),
      true,
      'a truncated PDF must never be returned',
    );

    const loaded = await PDFDocument.load(rendered.bytes);
    assert.equal(loaded.getPageCount(), 1);
    const [page] = loaded.getPages();
    assert.ok(page);
    assert.equal(Math.round(page.getWidth() * 100) / 100, 595.28);
    assert.equal(Math.round(page.getHeight() * 100) / 100, 841.89);
  });

  it('is byte-deterministic for an identical frozen input and never stamps a clock', async () => {
    const first = await renderHandymanDocumentPdf(quotationSnapshot());
    const second = await renderHandymanDocumentPdf(quotationSnapshot());
    assert.equal(Buffer.compare(first.bytes, second.bytes), 0);
    assert.equal(first.checksum, second.checksum);

    // Any change in the frozen content changes the digest.
    const changed = await renderHandymanDocumentPdf(
      quotationSnapshot({ totals: [{ label: 'Total', amount: 2000000, emphasised: true }] }),
    );
    assert.notEqual(changed.checksum, first.checksum);

    const raw = first.bytes.toString('latin1');
    assert.ok(!raw.includes('/CreationDate'), 'no fabricated creation timestamp');
    assert.ok(!raw.includes('/ModDate'), 'no fabricated modification timestamp');
  });

  it('flows long documents across pages and refuses past its caps', async () => {
    const wide = await renderHandymanDocumentPdf(quotationSnapshot({ lineItems: longItems(120, 320) }));
    assert.ok(wide.pageCount > 3, `expected several pages, got ${wide.pageCount}`);
    const loaded = await PDFDocument.load(wide.bytes);
    assert.equal(loaded.getPageCount(), wide.pageCount);
    for (const page of loaded.getPages()) {
      assert.equal(Math.round(page.getWidth() * 100) / 100, 595.28);
      assert.equal(Math.round(page.getHeight() * 100) / 100, 841.89);
    }
    // Rows the layout would have to clip are refused instead.
    assert.equal(
      await errorOf(renderHandymanDocumentPdf(quotationSnapshot({ lineItems: longItems(401, 40) }))),
      'CONTENT_TOO_LARGE',
    );
  });

  it('formats Indonesian money, quantities and dates and normalizes unsafe text', async () => {
    assert.equal(formatHandymanDocumentMoney(1500000, 'IDR', 'id'), 'Rp1.500.000');
    assert.equal(formatHandymanDocumentMoney(-250000, 'IDR', 'id'), '-Rp250.000');
    // IDR has no minor unit in this layout: a fraction is rounded half-up.
    assert.equal(formatHandymanDocumentMoney(1500.4, 'IDR', 'id'), 'Rp1.500');
    assert.equal(formatHandymanDocumentMoney(1234.5, 'USD', 'id'), 'US$1.234,50');
    assert.equal(formatHandymanDocumentMoney(1234.5, 'USD', 'en'), 'US$1,234.50');
    assert.equal(formatHandymanDocumentMoney(7, 'AED', 'id'), 'AED 7,00');
    assert.equal(formatHandymanDocumentQuantity(10, 'id'), '10');
    assert.equal(formatHandymanDocumentQuantity(0.5, 'id'), '0,5');
    assert.equal(formatHandymanDocumentQuantity(1234.567, 'en'), '1,234.567');
    assert.equal(formatHandymanDocumentDate('2026-10-26T02:45:00.000Z', 'id', 0), '26 Oktober 2026');
    assert.equal(
      formatHandymanDocumentDate('2026-10-26T02:45:00.000Z', 'id', 420, true),
      '26 Oktober 2026, 09.45 (UTC+07:00)',
    );
    assert.equal(
      handymanDocumentText('Quotasi - "Spesial"  eMOJI'),
      'Quotasi - "Spesial" eMOJI',
    );

    // Unsafe/unsupported input must not break rendering.
    const odd = await renderHandymanDocumentPdf(
      quotationSnapshot({
        recipient: {
          name: 'PT Émma "Kur" \u{1F389}',
          addressLines: ['Jl. - No. 1'.repeat(40).slice(0, 190)],
        },
      }),
    );
    assert.ok(odd.bytes.length > 1000);
    const loaded = await PDFDocument.load(odd.bytes);
    assert.ok(loaded.getPageCount() >= 1);
    // Control characters are refused outright: they cannot be represented.
    assert.equal(
      await errorOf(
        renderHandymanDocumentPdf(
          quotationSnapshot({ recipient: { name: 'BadName' } }),
        ),
      ),
      'INVALID_LAYOUT',
    );
  });

  it('omits an absent optional block instead of inventing one', async () => {
    const absent = await renderHandymanDocumentPdf(
      quotationSnapshot({ property: undefined, consent: undefined, status: undefined, totals: undefined, terms: undefined }),
    );
    const empty = await renderHandymanDocumentPdf(
      quotationSnapshot({ property: null, consent: null, status: null, totals: [], terms: [] }),
    );
    assert.equal(absent.checksum, empty.checksum, 'undefined and empty must render the same');
    const minimal = await renderHandymanDocumentPdf({
      document: { kind: 'WARRANTY_CERTIFICATE', number: 'WC-2026-0007' },
      issuer: { name: 'PT Asentra Layanan Prima' },
      recipient: { name: 'Budi Hartono' },
    });
    assert.equal(minimal.pageCount, 1);
    assert.equal(minimal.filename, 'warranty_certificate-document.pdf');
    const loaded = await PDFDocument.load(minimal.bytes);
    assert.equal(loaded.getPageCount(), 1);
  });

  it('fails closed on anything the layout does not know', async () => {
    const base = quotationSnapshot();
    assert.equal(
      await errorOf(
        renderHandymanDocumentPdf({ ...base, surprise: true } as unknown as HandymanDocumentSnapshot),
      ),
      'UNSUPPORTED_FIELD',
      'unknown fields are refused, never ignored',
    );
    assert.equal(
      await errorOf(
        renderHandymanDocumentPdf({
          ...base,
          document: { ...base.document, kind: 'TAX_INVOICE' as never },
        }),
      ),
      'UNSUPPORTED_FIELD',
      'only the five official kinds are supported',
    );
    assert.equal(
      await errorOf(
        renderHandymanDocumentPdf({
          ...base,
          totals: [{ label: 'Total', amount: Number.NaN }],
        }),
      ),
      'INVALID_MONEY_VALUE',
    );
    assert.equal(
      await errorOf(
        renderHandymanDocumentPdf({
          ...base,
          document: { ...base.document, issueDate: 'not-a-date' },
        }),
      ),
      'INVALID_DATE_VALUE',
    );
    assert.equal(
      await errorOf(
        renderHandymanDocumentPdf({
          ...base,
          document: { ...base.document, number: '   ' },
        }),
      ),
      'INVALID_LAYOUT',
      'a document number is never invented',
    );
    assert.equal(
      await errorOf(renderHandymanDocumentPdf(base, { filename: '../escape/quotation.pdf' })),
      'UNSAFE_FILENAME',
    );
    assert.equal(
      await errorOf(
        renderHandymanDocumentPdf({ ...base, locale: 'de' as never }),
      ),
      'INVALID_LAYOUT',
    );
  });
});
