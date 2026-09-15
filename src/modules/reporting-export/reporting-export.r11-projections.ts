import type {
  PublicOperationalBudgetVariance,
  PublicOperationalBudgetVarianceSummary,
} from '../operational-finance';
import type { PublicPurchaseOrder } from '../purchase-orders';
import type { PublicPurchaseOrderLineRegisterRow } from '../purchase-order-line-register';
import type { PublicReceivingRegisterRow } from '../receiving-register';
import type { PublicStockMovementRegisterRow } from '../stock-movement-register';
import type { PublicVendorInvoice } from '../vendor-invoices';
import type {
  ReportingExportColumn,
  ReportingExportKpiValue,
  ReportingExportTable,
} from './reporting-export.types';

/**
 * R11 — bounded Reporting projections for the commercial, resource and
 * service journey datasets.
 *
 * This file is the R11 projection seam. It holds ONLY the projections R11
 * adds, following the exact precedent of `reporting-export.r10-projections.ts`
 * ("the R10 projection seam"): the R01–R09 projections stay in
 * `reporting-export.projections.ts` /
 * `reporting-export.management-projections.ts` and the R10 projections stay
 * in `reporting-export.r10-projections.ts`; none of them is moved, refactored
 * or touched here. The local `table()` helper and column-type constants
 * follow the same self-contained second-file convention.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 *   - It performs NO calculation. No sums, rates, thresholds, day counts,
 *     quantity totals or date arithmetic. Every value is copied verbatim
 *     from the owning read contract's published output.
 *   - It owns NO lifecycle, status or period authority. Native receiving
 *     statuses and types are the receivings domain's own published
 *     vocabularies; this file declares no competing one.
 *   - It creates no second read model and no new SQL. The registry adapter
 *     calls the existing governed PART 01 `getReceivingRegister()` read.
 *   - It exposes NO monetary field: the receiving authority persists none,
 *     so no price, amount, cost, value, currency or valuation appears here.
 */

const STRING = 'STRING' as const;
const NUMBER = 'NUMBER' as const;
const DATE = 'DATE' as const;
const PERCENT = 'PERCENT' as const;
const BOOLEAN = 'BOOLEAN' as const;

function table(
  key: string,
  label: string,
  columns: ReportingExportColumn[],
  rows: ReportingExportTable['rows'],
): ReportingExportTable {
  return { key, label, columns, rows, rowCount: rows.length };
}

/**
 * R11 PART 02 — RECEIVING_REGISTER projection.
 *
 * A PURE re-presentation of the PART 01 internal receiving-register read
 * contract (`src/modules/receiving-register`), which is itself a bounded
 * read model over the authoritative BE-17G `receivings` table. Reporting
 * adds nothing to it: no receiving lifecycle, no receiving repository, no
 * receiving status authority, no KPI authority and no second receiving read
 * model is created here, and no receivings table is queried from Reporting.
 *
 * GRAIN — ONE Reporting row per ONE authoritative receiving-register row,
 * i.e. per one persisted `receivings` record. The owning read selects a
 * single table with zero joins, so nothing is expanded, collapsed,
 * deduplicated or merged here and the row count is always `source.length`.
 *
 * IDENTITY — `receivingId`, the receivings record's own primary key, copied
 * verbatim. No receivingKey, composite id, latestReceivingId or
 * currentReceivingId is minted, and no latest, current or primary receiving
 * is elected.
 *
 * NO PURCHASE ORDER LINKAGE — the schema persists no receiving →
 * purchase_order or purchase_order_line reference, so none is exposed or
 * inferred here: not from vendor, readiness, item, quantity, material
 * request, service request, timestamp and not from the current live PO. The
 * register stays request-anchored through the row's own persisted
 * `purchaseRequestId` / `serviceRequestId` / `materialRequestId` lineage.
 *
 * NO MONEY — receiving is a quantity / operational receipt fact. `quantity`
 * is copied per row and is NEVER summed across items or UOMs, never
 * converted, never valued; no received-vs-ordered or remaining quantity is
 * derived. `uomId` keeps the source's receipt-time snapshot semantics
 * (CR-BE-MAT-01 PART 04; nullable on historical rows and service
 * receivings) and is never resolved or converted.
 *
 * ACTORS — `receivedByUserId` is the persisted receiving actor and keeps
 * exactly that meaning ("Received By"); it is never relabeled as an
 * executor, performer, approver, verifier or requester, and no user or
 * display NAME is resolved for it because the owning read publishes none.
 *
 * `stockMovementId` is the receiving-associated inventory STOCK_IN movement
 * reference copied verbatim; the movement itself is a different grain and
 * belongs to a different register, so it is never expanded here.
 *
 * Exactly ONE table (`receivingRegister`) is emitted, with no secondary
 * child, summary, metadata or drill table, and `kpis` is deliberately empty:
 * no received total, quantity total, completion percentage, value or cycle
 * time is calculated. No `csvDefaultTableKey` is added; OPERATIONAL_DETAIL
 * remains the only dataset with a metadata default, and the generic
 * renderer's sole-table behaviour is sufficient for this response.
 */
export function projectReceivingRegister(source: PublicReceivingRegisterRow[]): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'receivingRegister',
        'Receiving Register',
        [
          // The authoritative row identity: the receivings record's own id.
          { key: 'receivingId', label: 'Receiving Id', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          // The receivings domain's own request discriminator, verbatim.
          { key: 'requestType', label: 'Request Type', type: STRING },
          // Persisted request lineage — exactly one request reference is
          // non-null (schema CHECK); copied verbatim, never re-derived.
          { key: 'purchaseRequestId', label: 'Purchase Request Id', type: STRING },
          { key: 'serviceRequestId', label: 'Service Request Id', type: STRING },
          // Optional MATERIAL-request line binding (CR-BE-MAT-01 PART 01).
          { key: 'materialRequestId', label: 'Material Request Id', type: STRING },
          { key: 'vendorId', label: 'Vendor Id', type: STRING },
          // The receivings domain's own type discriminator, verbatim.
          { key: 'receivingType', label: 'Receiving Type', type: STRING },
          { key: 'itemId', label: 'Item Id', type: STRING },
          { key: 'warehouseId', label: 'Warehouse Id', type: STRING },
          // Native received quantity. Row-level only: never summed across
          // items or UOMs, never converted, never valued.
          { key: 'quantity', label: 'Quantity', type: NUMBER },
          // UOM snapshot at receipt time; snapshot semantics preserved.
          { key: 'uomId', label: 'Uom Id', type: STRING },
          // Receiving-associated STOCK_IN movement reference, copied only.
          { key: 'stockMovementId', label: 'Stock Movement Id', type: STRING },
          // Persisted receiving actor: "Received By", nothing else.
          { key: 'receivedByUserId', label: 'Received By User Id', type: STRING },
          // The business period authority of this register.
          { key: 'receivedAt', label: 'Received At', type: DATE },
          // The persisted lifecycle status (RECEIVED | FINALIZED), verbatim;
          // never recomputed from any timestamp or link.
          { key: 'status', label: 'Status', type: STRING },
          { key: 'notes', label: 'Notes', type: STRING },
        ],
        source.map((row) => ({
          // The authoritative row identity, copied verbatim: never
          // synthesized and never merged into a composite key.
          receivingId: row.receivingId,
          clientId: row.clientId,
          buildingId: row.buildingId,
          requestType: row.requestType,
          purchaseRequestId: row.purchaseRequestId,
          serviceRequestId: row.serviceRequestId,
          materialRequestId: row.materialRequestId,
          vendorId: row.vendorId,
          receivingType: row.receivingType,
          itemId: row.itemId,
          warehouseId: row.warehouseId,
          // Quantity and UOM copied per row with no aggregation, no
          // conversion and no remaining/approved derivation.
          quantity: row.quantity,
          uomId: row.uomId,
          stockMovementId: row.stockMovementId,
          // Persisted actor reference with its exact source meaning. No
          // name is resolved and no executor or approver is inferred.
          receivedByUserId: row.receivedByUserId,
          receivedAt: row.receivedAt,
          status: row.status,
          notes: row.notes,
        })),
      ),
    ],
  };
}

/**
 * R11 PART 03C — PURCHASE_ORDER_REGISTER HEADER view projection.
 *
 * A PURE re-presentation of the existing purchase-orders public list read
 * (`listPurchaseOrders`, CR-BE-R2P-01), which is itself the authoritative
 * read model over the `purchase_orders` table. Reporting adds nothing: no
 * purchase-order lifecycle, no repository, no status or currency authority,
 * no KPI and no second header read model is created here.
 *
 * GRAIN — ONE Reporting row per ONE `purchase_orders` record. The owning
 * read is a single scoped SELECT with zero joins, so nothing is expanded,
 * collapsed, deduplicated or merged here and the row count is always
 * `source.length`.
 *
 * IDENTITY — the source record's own `id`, projected under the explicit
 * register name `purchaseOrderId`. This is the ONLY rename; every other
 * fact is copied verbatim. No latest, current or primary PO is elected.
 *
 * NO HEADER TOTAL — the schema persists no PO total amount and this
 * projection invents none: no totalAmount, no ordered/received/remaining
 * quantity, no line count, no SUM over lines (lines are a different view of
 * the same dataset, never a child table here). `currency` is the PO's own
 * ISO-4217 context fact, verbatim.
 *
 * NO ENRICHMENT — `poReadinessId` is the row's own persisted precondition
 * reference and stays a bare id: no readiness, RFQ provenance, price
 * deviation, SPK, receiving or invoice record is fetched or joined. The
 * native `status` (DRAFT | ISSUED | CANCELLED) and `requestType`
 * (PURCHASE_REQUEST | SERVICE_REQUEST) discriminators are copied verbatim
 * and never recomputed from issuedAt/cancelledAt or any lineage.
 *
 * Exactly ONE table (`purchaseOrderHeader`) is emitted and `kpis` is
 * deliberately empty: no committed value, PO count, issuance rate or cycle
 * time is calculated. No `csvDefaultTableKey` exists for this dataset —
 * with two possible tables the generic export requires the actually
 * selected response table.
 */
export function projectPurchaseOrderHeader(source: PublicPurchaseOrder[]): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'purchaseOrderHeader',
        'Purchase Order Header',
        [
          // The authoritative row identity: the source record's own id,
          // explicitly named for the register contract.
          { key: 'purchaseOrderId', label: 'Purchase Order Id', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          // The PO's committed Vendor, verbatim from the header.
          { key: 'vendorId', label: 'Vendor Id', type: STRING },
          // Persisted request anchors — exactly one is non-null (schema CHECK).
          { key: 'purchaseRequestId', label: 'Purchase Request Id', type: STRING },
          { key: 'serviceRequestId', label: 'Service Request Id', type: STRING },
          // The row's own persisted BE-17F precondition reference — a bare id,
          // never an enrichment hook.
          { key: 'poReadinessId', label: 'Po Readiness Id', type: STRING },
          // Native request discriminator, verbatim.
          { key: 'requestType', label: 'Request Type', type: STRING },
          { key: 'poNumber', label: 'Po Number', type: STRING },
          // The PO's own ISO-4217 currency — context only; no amount
          // authority exists on the header.
          { key: 'currency', label: 'Currency', type: STRING },
          // Native lifecycle status: DRAFT | ISSUED | CANCELLED, verbatim.
          { key: 'status', label: 'Status', type: STRING },
          // The business period authority of both register views.
          { key: 'poDate', label: 'Po Date', type: DATE },
          { key: 'requiredDate', label: 'Required Date', type: DATE },
          { key: 'vendorReference', label: 'Vendor Reference', type: STRING },
          { key: 'notes', label: 'Notes', type: STRING },
          { key: 'createdByUserId', label: 'Created By User Id', type: STRING },
          // Issuance and cancellation provenance, verbatim; never recomputed
          // from the status and never reinterpreted as a period.
          { key: 'issuedByUserId', label: 'Issued By User Id', type: STRING },
          { key: 'issuedAt', label: 'Issued At', type: DATE },
          { key: 'cancelledByUserId', label: 'Cancelled By User Id', type: STRING },
          { key: 'cancelledAt', label: 'Cancelled At', type: DATE },
          { key: 'createdAt', label: 'Created At', type: DATE },
          { key: 'updatedAt', label: 'Updated At', type: DATE },
        ],
        source.map((row) => ({
          // The ONLY rename: the source identity published explicitly.
          purchaseOrderId: row.id,
          clientId: row.clientId,
          buildingId: row.buildingId,
          vendorId: row.vendorId,
          purchaseRequestId: row.purchaseRequestId,
          serviceRequestId: row.serviceRequestId,
          poReadinessId: row.poReadinessId,
          requestType: row.requestType,
          poNumber: row.poNumber,
          currency: row.currency,
          status: row.status,
          poDate: row.poDate,
          requiredDate: row.requiredDate,
          vendorReference: row.vendorReference,
          notes: row.notes,
          createdByUserId: row.createdByUserId,
          issuedByUserId: row.issuedByUserId,
          issuedAt: row.issuedAt,
          cancelledByUserId: row.cancelledByUserId,
          cancelledAt: row.cancelledAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      ),
    ],
  };
}

/**
 * R11 PART 03C — PURCHASE_ORDER_REGISTER LINE view projection.
 *
 * A PURE re-presentation of the R11 PART 03B purchase-order-line-register
 * public read (`getPurchaseOrderLineRegister`), itself the bounded set-based
 * read model over `purchase_order_lines` joined 1:1 to its owning
 * `purchase_orders` header. Every one of the 25 published fields is copied
 * verbatim — the register row is already Reporting-safe, so this function
 * renames nothing, derives nothing and drops nothing.
 *
 * GRAIN — ONE Reporting row per ONE `purchase_order_lines` record. The
 * owning read is ONE query with a 1:1 parent join, so the row count is
 * always `source.length`: no fan-out, no collapse, no dedup.
 *
 * IDENTITY — `purchaseOrderLineId` (the line's own id, explicitly named by
 * the PART 03B contract). No latest, current or primary line is elected.
 *
 * MONEY — `unitPrice` and `lineAmount` are persisted historical
 * transactional commitments in the parent PO's `currency` (the one
 * authoritative currency per PO, carried by the owning read). Nothing is
 * summed into a PO total, recomputed from quantitySnapshot × unitPrice,
 * rounded, converted (no FX), tax-adjusted or compared against any price
 * catalog.
 *
 * QUANTITY — `quantitySnapshot` stays the frozen commit-time snapshot under
 * its own name: never relabeled ordered, approved, current, received or
 * remaining; NULL for SERVICE lines is preserved as NULL.
 *
 * SEMANTICS — `requestLineType` is the authoritative persisted
 * discriminator (MATERIAL_REQUEST | SERVICE_REQUEST), never inferred from
 * the nullable lineage fields; `purchaseOrderStatus` is the PARENT PO's
 * native status under its explicit name (a line owns no lifecycle, so no
 * lineStatus exists); and the line's own `serviceRequestId` /
 * `materialRequestId` lineage is preserved from the LINE authority, never
 * overwritten with parent-header semantics.
 *
 * NO ENRICHMENT — itemId/uomId/sourceServiceId are the row's own snapshots
 * (bare ids, never resolved to names, units or catalog prices), and no RFQ,
 * deviation, readiness, receiving, invoice, SPK, work-order or commitment
 * record is fetched or joined.
 *
 * Exactly ONE table (`purchaseOrderLine`) is emitted and `kpis` is
 * deliberately empty: no committed value, line count, quantity total or
 * average price is calculated.
 */
export function projectPurchaseOrderLine(
  source: PublicPurchaseOrderLineRegisterRow[],
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'purchaseOrderLine',
        'Purchase Order Line',
        [
          // The authoritative line identity, explicitly named.
          { key: 'purchaseOrderLineId', label: 'Purchase Order Line Id', type: STRING },
          // Parent PO context — verbatim from the owning read's 1:1 join.
          { key: 'purchaseOrderId', label: 'Purchase Order Id', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'vendorId', label: 'Vendor Id', type: STRING },
          { key: 'purchaseRequestId', label: 'Purchase Request Id', type: STRING },
          { key: 'poNumber', label: 'Po Number', type: STRING },
          // The business period authority of both register views.
          { key: 'poDate', label: 'Po Date', type: DATE },
          // The ONE authoritative currency of this line's money facts.
          { key: 'currency', label: 'Currency', type: STRING },
          // The PARENT PO's native status under its explicit semantic name.
          { key: 'purchaseOrderStatus', label: 'Purchase Order Status', type: STRING },
          // Line facts — verbatim.
          { key: 'lineNumber', label: 'Line Number', type: NUMBER },
          { key: 'requestLineType', label: 'Request Line Type', type: STRING },
          { key: 'materialRequestId', label: 'Material Request Id', type: STRING },
          { key: 'serviceRequestId', label: 'Service Request Id', type: STRING },
          { key: 'itemId', label: 'Item Id', type: STRING },
          { key: 'uomId', label: 'Uom Id', type: STRING },
          { key: 'sourceServiceId', label: 'Source Service Id', type: STRING },
          { key: 'description', label: 'Description', type: STRING },
          // Frozen commit-time snapshot; NULL preserved for SERVICE lines;
          // never relabeled or used in arithmetic.
          { key: 'quantitySnapshot', label: 'Quantity Snapshot', type: NUMBER },
          // Persisted historical money facts, never recomputed or totaled.
          { key: 'unitPrice', label: 'Unit Price', type: NUMBER },
          { key: 'lineAmount', label: 'Line Amount', type: NUMBER },
          { key: 'notes', label: 'Notes', type: STRING },
          { key: 'createdByUserId', label: 'Created By User Id', type: STRING },
          { key: 'createdAt', label: 'Created At', type: DATE },
          { key: 'updatedAt', label: 'Updated At', type: DATE },
        ],
        source.map((row) => ({
          purchaseOrderLineId: row.purchaseOrderLineId,
          purchaseOrderId: row.purchaseOrderId,
          clientId: row.clientId,
          buildingId: row.buildingId,
          vendorId: row.vendorId,
          purchaseRequestId: row.purchaseRequestId,
          poNumber: row.poNumber,
          poDate: row.poDate,
          currency: row.currency,
          purchaseOrderStatus: row.purchaseOrderStatus,
          lineNumber: row.lineNumber,
          requestLineType: row.requestLineType,
          materialRequestId: row.materialRequestId,
          serviceRequestId: row.serviceRequestId,
          itemId: row.itemId,
          uomId: row.uomId,
          sourceServiceId: row.sourceServiceId,
          description: row.description,
          quantitySnapshot: row.quantitySnapshot,
          unitPrice: row.unitPrice,
          lineAmount: row.lineAmount,
          notes: row.notes,
          createdByUserId: row.createdByUserId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      ),
    ],
  };
}

/**
 * R11 PART 04 — VENDOR_INVOICE_REGISTER projection.
 *
 * A PURE re-presentation of the EXISTING vendor-invoices public list read
 * (`listVendorInvoices`, CR-BE-COM-02), the authoritative read model over
 * the `vendor_invoices` table. Reporting adds nothing: no invoice
 * lifecycle, no verification/matching/settlement/payment authority, no
 * repository and no second invoice read model is created here, and neither
 * `vendor_invoices` nor `vendor_invoice_history` is queried from Reporting.
 *
 * GRAIN — ONE Reporting row per ONE persisted `vendor_invoices` record. The
 * owning read is a single scoped SELECT with zero joins, so nothing is
 * expanded, collapsed, deduplicated or merged here and the row count is
 * always `source.length`. No child flattening and no one-to-many join
 * exists: `discrepancyCodes` stays an ON-ROW fact and is never fanned out
 * to multiple rows.
 *
 * IDENTITY — the source record's own `id`, projected under the explicit
 * register name `vendorInvoiceId`. This is the ONLY rename; every other
 * fact is copied verbatim. No latest, current or primary invoice is
 * elected.
 *
 * STATUS DIMENSIONS — the three native vocabularies stay separate and
 * verbatim: lifecycle `status` (DRAFT | FINALIZED | CANCELLED),
 * `verificationStatus` (PENDING | VERIFIED | DISCREPANCY) and
 * `paymentStatus` (UNPAID | PARTIALLY_PAID | PAID). They are never
 * collapsed into one generic status, never normalized, and no OPEN/CLOSED/
 * SETTLED/APPROVED/PAYABLE vocabulary is invented.
 *
 * PAYMENT — CURRENT STATE ONLY: `paidAmount`, `outstandingAmount`,
 * `lastPaymentDate` and `paymentStatus` are the persisted cumulative facts
 * on the invoice row, copied verbatim. This projection materializes NO
 * payment event, receipt, transaction, instrument or bank-transfer row —
 * the schema persists no discrete vendor payment documents (a known R11
 * non-blocking limitation) — and individual payments are never inferred
 * from changes in `paidAmount`. `vendor_invoice_history` is never expanded.
 *
 * MONEY — `invoiceAmount`, `paidAmount` and `outstandingAmount` are
 * source-generated NUMERIC facts and `currency` is the invoice's own
 * persisted ISO-4217 currency, ALL copied verbatim with ZERO arithmetic:
 * no sum, no subtraction, no outstanding recomputation
 * (`invoiceAmount - paidAmount` is the SOURCE's persisted value, never
 * re-derived here), no cross-invoice or cross-currency total, no FX, no
 * tax/VAT, no price-catalog lookup and no accounting classification.
 *
 * LINEAGE — `vendorWorkId`, `workOrderId`, `completionReportId`,
 * `serviceReportId`, `bastDocumentId`, `purchaseOrderId` and
 * `workContractId` are the invoice row's own persisted references, copied
 * as bare drill handles: no vendor-work, work-order, report, BAST, PO or
 * SPK record is fetched, joined or enriched.
 *
 * ACTORS — exact meanings preserved: `createdByUserId` created the invoice,
 * `finalizedByUserId` finalized it, `cancelledByUserId` cancelled it and
 * `verifiedByUserId` is the verification actor. None is relabeled as a
 * payer, payment actor, approver, executor or vendor PIC.
 *
 * `discrepancyCodes` is serialized with the house comma-join convention for
 * source-owned arrays (management-projections `availableActions`,
 * r10-projections `recurrenceDaysOfWeek`): the persisted codes and their
 * order survive verbatim in one renderer-safe STRING cell — never
 * recalculated, never interpreted into a new status and never fanned out.
 *
 * PERIOD — `invoiceDate` is the business period authority, echoed verbatim;
 * `receivedDate`, `verifiedAt`, `finalizedAt`, `cancelledAt` and
 * `lastPaymentDate` are ordinary date facts and never period substitutes.
 *
 * Exactly ONE table (`vendorInvoiceRegister`) is emitted and `kpis` is
 * deliberately empty: no invoice count, invoice amount, paid total,
 * outstanding total, discrepancy rate, verification rate, payment rate,
 * aging or overdue value is calculated — even conceptually-safe
 * per-currency aggregates are intentionally deferred. No
 * `csvDefaultTableKey` exists: with exactly one table, the generic
 * renderer's sole-table selection is sufficient.
 */
export function projectVendorInvoiceRegister(source: PublicVendorInvoice[]): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'vendorInvoiceRegister',
        'Vendor Invoice Register',
        [
          // The authoritative row identity: the source record's own id,
          // explicitly named for the register contract.
          { key: 'vendorInvoiceId', label: 'Vendor Invoice Id', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'vendorId', label: 'Vendor Id', type: STRING },
          // Invoice facts — the business period authority is invoiceDate.
          { key: 'invoiceNumber', label: 'Invoice Number', type: STRING },
          { key: 'invoiceDate', label: 'Invoice Date', type: DATE },
          { key: 'receivedDate', label: 'Received Date', type: DATE },
          // The invoice's own persisted ISO-4217 currency — never converted.
          { key: 'currency', label: 'Currency', type: STRING },
          // Source-generated money facts, verbatim; zero arithmetic here.
          { key: 'invoiceAmount', label: 'Invoice Amount', type: NUMBER },
          // Native lifecycle status: DRAFT | FINALIZED | CANCELLED.
          { key: 'status', label: 'Status', type: STRING },
          { key: 'vendorReference', label: 'Vendor Reference', type: STRING },
          // Persisted lineage — bare drill handles, never enriched.
          { key: 'vendorWorkId', label: 'Vendor Work Id', type: STRING },
          { key: 'workOrderId', label: 'Work Order Id', type: STRING },
          { key: 'completionReportId', label: 'Completion Report Id', type: STRING },
          { key: 'serviceReportId', label: 'Service Report Id', type: STRING },
          { key: 'bastDocumentId', label: 'Bast Document Id', type: STRING },
          { key: 'purchaseOrderId', label: 'Purchase Order Id', type: STRING },
          { key: 'workContractId', label: 'Work Contract Id', type: STRING },
          { key: 'notes', label: 'Notes', type: STRING },
          { key: 'createdByUserId', label: 'Created By User Id', type: STRING },
          // Native verification dimension, kept separate from lifecycle and
          // payment; the verifier actor keeps its exact meaning.
          { key: 'verificationStatus', label: 'Verification Status', type: STRING },
          { key: 'verifiedByUserId', label: 'Verified By User Id', type: STRING },
          { key: 'verifiedAt', label: 'Verified At', type: DATE },
          { key: 'verificationNotes', label: 'Verification Notes', type: STRING },
          // Source-owned deterministic codes, comma-joined on the row: never
          // fanned out, recalculated or interpreted into a new status.
          { key: 'discrepancyCodes', label: 'Discrepancy Codes', type: STRING },
          // Native payment dimension — CURRENT STATE ONLY, no payment events.
          { key: 'paymentStatus', label: 'Payment Status', type: STRING },
          { key: 'paidAmount', label: 'Paid Amount', type: NUMBER },
          { key: 'outstandingAmount', label: 'Outstanding Amount', type: NUMBER },
          { key: 'lastPaymentDate', label: 'Last Payment Date', type: DATE },
          // Lifecycle provenance, verbatim; actors keep their exact meanings.
          { key: 'finalizedAt', label: 'Finalized At', type: DATE },
          { key: 'finalizedByUserId', label: 'Finalized By User Id', type: STRING },
          { key: 'cancelledAt', label: 'Cancelled At', type: DATE },
          { key: 'cancelledByUserId', label: 'Cancelled By User Id', type: STRING },
          { key: 'createdAt', label: 'Created At', type: DATE },
          { key: 'updatedAt', label: 'Updated At', type: DATE },
        ],
        source.map((row) => ({
          // The ONLY rename: the source identity published explicitly.
          vendorInvoiceId: row.id,
          clientId: row.clientId,
          buildingId: row.buildingId,
          vendorId: row.vendorId,
          invoiceNumber: row.invoiceNumber,
          invoiceDate: row.invoiceDate,
          receivedDate: row.receivedDate,
          currency: row.currency,
          // Money copied verbatim — never summed, subtracted, recomputed,
          // converted or classified.
          invoiceAmount: row.invoiceAmount,
          status: row.status,
          vendorReference: row.vendorReference,
          // Bare persisted drill handles — nothing is fetched or joined.
          vendorWorkId: row.vendorWorkId,
          workOrderId: row.workOrderId,
          completionReportId: row.completionReportId,
          serviceReportId: row.serviceReportId,
          bastDocumentId: row.bastDocumentId,
          purchaseOrderId: row.purchaseOrderId,
          workContractId: row.workContractId,
          notes: row.notes,
          createdByUserId: row.createdByUserId,
          verificationStatus: row.verificationStatus,
          verifiedByUserId: row.verifiedByUserId,
          verifiedAt: row.verifiedAt,
          verificationNotes: row.verificationNotes,
          // On-row array fact, comma-joined per the house convention: codes
          // and order verbatim, one cell, no fan-out.
          discrepancyCodes: row.discrepancyCodes.join(','),
          paymentStatus: row.paymentStatus,
          paidAmount: row.paidAmount,
          outstandingAmount: row.outstandingAmount,
          lastPaymentDate: row.lastPaymentDate,
          finalizedAt: row.finalizedAt,
          finalizedByUserId: row.finalizedByUserId,
          cancelledAt: row.cancelledAt,
          cancelledByUserId: row.cancelledByUserId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      ),
    ],
  };
}

/**
 * R11 PART 05C — STOCK_MOVEMENT_REGISTER projection.
 *
 * A PURE re-presentation of the R11 PART 05B internal stock-movement-register
 * read contract (`src/modules/stock-movement-register`), which is itself the
 * bounded governed read model over the authoritative append-only BE-16D
 * `inventory_stock_movements` ledger. Reporting adds nothing to it: no
 * movement lifecycle, no movement repository, no current-balance authority,
 * no KPI authority and no second movement read model is created here, and no
 * inventory_stock_movements or inventory_stock_balances table is queried from
 * Reporting. The owning inventory-stock-movements module's public enriched
 * list is deliberately NOT the source: R11 PART 05 verification proved it is
 * not actor-scoped and its raw date handling truncates the final day.
 *
 * GRAIN — ONE Reporting row per ONE governed source row, i.e. per one
 * persisted `inventory_stock_movements` record. The owning read selects a
 * single table with zero joins, so nothing is expanded, collapsed,
 * deduplicated or merged here and the row count is always `source.length`.
 * No child flattening exists: the ledger is append-only and has no children.
 *
 * IDENTITY — `stockMovementId`, the movement record's own primary key under
 * its explicit register name (the rename already performed by the source
 * contract), copied verbatim. No movementKey, composite id,
 * latestMovementId or currentMovementId is minted, and no latest, current or
 * primary movement is elected.
 *
 * MOVEMENT VOCABULARY — `movementType` is the native persisted
 * direction/type discriminator (STOCK_IN | STOCK_OUT), copied verbatim. It
 * is NOT a lifecycle status: it is never normalized to IN/OUT, RECEIPT,
 * ISSUE, CONSUMPTION, RETURN, TRANSFER or ADJUSTMENT, and no generic status,
 * directionLabel, receiptType or issueType is invented beside it.
 *
 * QUANTITY / UOM — `quantity` is the row-level authoritative movement
 * quantity and `uomId` the persisted movement-time UOM snapshot (nullable on
 * historical rows), both copied verbatim: never summed across items or UOMs,
 * never converted, never netted, and no consumption, receiving or remaining
 * quantity is derived.
 *
 * RESULTING SNAPSHOTS — `resultingQuantityOnHand` and
 * `resultingAvailableQuantity` are the persisted HISTORICAL post-movement
 * snapshots, copied verbatim. They are never renamed or relabeled as
 * current balances, never re-resolved against the live stock-balance domain,
 * and no reserved quantity or other balance arithmetic is derived from them.
 *
 * REFERENCE / SOURCE — the generic persisted `reference` and `source` texts
 * are copied verbatim as bare on-row facts: never reinterpreted as a
 * Receiving, Work Order, Purchase Order, Material Request, Reservation,
 * Transfer or Adjustment link, never resolved, and no reverse-domain lookup
 * is performed even where other domains persist a movement id.
 *
 * ACTOR — `performedByUserId` is the persisted movement actor and keeps
 * exactly that meaning ("Performed By"); it is never relabeled as a
 * receiver, user, consumer, requester, approver or executor, and no actor or
 * warehouse/item/UOM display NAME is resolved — the owning read publishes
 * IDs only.
 *
 * NO MONEY — a stock movement is a quantity fact: no cost, price, amount,
 * currency, value, COGS or valuation field exists on this contract and none
 * is inferred from purchase orders, vendor invoices, price catalog,
 * receivings or work-order material usage.
 *
 * PERIOD — `movementDate` is the business period authority, echoed verbatim;
 * `createdAt` is an ordinary audit fact and never a period substitute.
 *
 * Exactly ONE table (`stockMovementRegister`) is emitted, with no secondary
 * balance, item, warehouse, summary, metadata or drill table, and `kpis` is
 * deliberately empty: no movement count, stock-in or stock-out quantity
 * total, net movement, current balance, inventory value, turnover or
 * consumption figure is calculated. No `csvDefaultTableKey` is added;
 * OPERATIONAL_DETAIL remains the only dataset with a metadata default, and
 * the generic renderer's sole-table behaviour is sufficient for this
 * response.
 */
export function projectStockMovementRegister(
  source: PublicStockMovementRegisterRow[],
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'stockMovementRegister',
        'Stock Movement Register',
        [
          // The authoritative row identity: the movement record's own id
          // under its explicit register name.
          { key: 'stockMovementId', label: 'Stock Movement Id', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'warehouseId', label: 'Warehouse Id', type: STRING },
          { key: 'itemId', label: 'Item Id', type: STRING },
          // Native direction/type discriminator: STOCK_IN | STOCK_OUT —
          // verbatim, never a lifecycle status.
          { key: 'movementType', label: 'Movement Type', type: STRING },
          // Row-level movement quantity, verbatim; never summed or converted.
          { key: 'quantity', label: 'Quantity', type: NUMBER },
          // Movement-time UOM snapshot, verbatim; never a conversion input.
          { key: 'uomId', label: 'Uom Id', type: STRING },
          // The business period authority.
          { key: 'movementDate', label: 'Movement Date', type: DATE },
          // Generic persisted facts — bare, never resolved into any domain.
          { key: 'reference', label: 'Reference', type: STRING },
          { key: 'source', label: 'Source', type: STRING },
          // The persisted movement actor — "Performed By", nothing else.
          { key: 'performedByUserId', label: 'Performed By User Id', type: STRING },
          { key: 'notes', label: 'Notes', type: STRING },
          // Persisted HISTORICAL post-movement snapshots, verbatim; never
          // current balances and never an arithmetic input.
          { key: 'resultingQuantityOnHand', label: 'Resulting Quantity On Hand', type: NUMBER },
          { key: 'resultingAvailableQuantity', label: 'Resulting Available Quantity', type: NUMBER },
          // Audit fact; the ledger is immutable and has no updated-at.
          { key: 'createdAt', label: 'Created At', type: DATE },
        ],
        source.map((row) => ({
          stockMovementId: row.stockMovementId,
          clientId: row.clientId,
          buildingId: row.buildingId,
          warehouseId: row.warehouseId,
          itemId: row.itemId,
          // Native vocabulary copied verbatim — never normalized, never
          // accompanied by an invented status.
          movementType: row.movementType,
          // Quantities copied verbatim — never summed across items or UOMs,
          // never converted, never netted.
          quantity: row.quantity,
          uomId: row.uomId,
          movementDate: row.movementDate,
          reference: row.reference,
          source: row.source,
          performedByUserId: row.performedByUserId,
          notes: row.notes,
          // Historical snapshots copied verbatim — no subtraction, no
          // reserved quantity, no current-balance alias.
          resultingQuantityOnHand: row.resultingQuantityOnHand,
          resultingAvailableQuantity: row.resultingAvailableQuantity,
          createdAt: row.createdAt,
        })),
      ),
    ],
  };
}

/**
 * R11 PART 06 — OPERATIONAL_BUDGET_VARIANCE projection, BUDGET view.
 *
 * A PURE re-presentation of the EXISTING operational-finance variance list
 * read (`operationalVarianceService.listOperationalBudgetVariance`,
 * CR-BE-COMM-VAR-01 PART 05): ONE row per budget-level variance summary,
 * i.e. per one `operational_budgets` record in the actor's authorized
 * scope. Reporting adds nothing: no budget engine, no commitment engine, no
 * accounting ledger, no FX or consolidation engine and no second variance
 * read model is created here, and no operational-finance table is queried
 * from Reporting.
 *
 * GRAIN — one authoritative budget-level variance result per row. The
 * summary grain is the source's own: budget identity, the budget's control
 * period, its single authoritative currency, its native status, the
 * source-computed totals and the source-owned fail-closed control and gap
 * count. The detail read's `categories` child array is NEVER embedded in a
 * budget row — categories are a separate grain with their own CATEGORY
 * view — and the budget row is never duplicated per category.
 *
 * ZERO FINANCIAL ARITHMETIC — every figure (plannedAmount, the four ledger
 * amounts, legacyCommittedAmount, the uncommitted and unallocated actuals,
 * openCommitmentAmount, actualAmount, consumedAmount, availableAmount,
 * varianceAmount, utilizationPercent, committedUtilizationPercent) is the
 * owning authority's own read-time computed value, copied field-for-field.
 * Nothing is summed, subtracted, multiplied, divided, percentaged, rounded,
 * converted or re-derived here, and the nested `totals` object is flattened
 * by pure field copy only. `utilizationPercent` /
 * `committedUtilizationPercent` keep the source's null (planned = 0)
 * verbatim — never zero-filled.
 *
 * CURRENCY — each row stays tied to exactly ONE budget currency, copied
 * verbatim. Rows of different currencies coexist in the table without ever
 * being summed, converted or consolidated; no reporting currency is
 * selected and no client base currency is inferred.
 *
 * PERIOD — `periodStart` / `periodEnd` are the budget's own control period
 * (flattened from the source `budgetPeriod` object by field copy), NOT
 * transaction timestamps; createdAt/updatedAt and commitment or invoice
 * instants are never substituted.
 *
 * DIAGNOSTICS — `failClosed` and `gapCount` are the source-owned summary
 * controls, preserved exactly: the fail-closed state is never suppressed,
 * gaps are never valued, reinterpreted or expanded here (the gap code
 * vocabulary stays the source's own), and exclusions are never turned into
 * zero-valued financial facts.
 *
 * STATUS — the native budget status (DRAFT | ACTIVE | CLOSED | CANCELLED)
 * is copied verbatim; no healthy/atRisk/overBudget or green/amber/red
 * vocabulary is invented. The summary grain publishes no overspendPolicy,
 * so none is projected.
 *
 * Exactly ONE table (`operationalBudgetVariance`) is emitted, with no
 * category, gap, traceability, summary or drill child table, and `kpis` is
 * deliberately empty: the source-owned totals and percentages live on the
 * rows and are NEVER duplicated into a second Reporting KPI layer — no
 * cross-budget or cross-currency aggregate exists. No `csvDefaultTableKey`
 * is added; OPERATIONAL_DETAIL remains the only dataset with a metadata
 * default.
 */
export function projectOperationalBudgetVariance(
  source: PublicOperationalBudgetVarianceSummary[],
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'operationalBudgetVariance',
        'Operational Budget Variance',
        [
          // The authoritative row identity: the budget's own id.
          { key: 'budgetId', label: 'Budget Id', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'budgetName', label: 'Budget Name', type: STRING },
          // The budget's own control period — never a transaction timestamp.
          { key: 'periodStart', label: 'Period Start', type: DATE },
          { key: 'periodEnd', label: 'Period End', type: DATE },
          // The ONE authoritative currency of this budget's figures.
          { key: 'currency', label: 'Currency', type: STRING },
          // Native budget status, verbatim; no invented health vocabulary.
          { key: 'status', label: 'Status', type: STRING },
          // Source-computed totals, copied field-for-field with ZERO arithmetic.
          { key: 'plannedAmount', label: 'Planned Amount', type: NUMBER },
          { key: 'ledgerCommittedAmount', label: 'Ledger Committed Amount', type: NUMBER },
          { key: 'ledgerOpenAmount', label: 'Ledger Open Amount', type: NUMBER },
          { key: 'ledgerActualizedAmount', label: 'Ledger Actualized Amount', type: NUMBER },
          { key: 'ledgerReleasedAmount', label: 'Ledger Released Amount', type: NUMBER },
          { key: 'legacyCommittedAmount', label: 'Legacy Committed Amount', type: NUMBER },
          { key: 'uncommittedMaterialActualAmount', label: 'Uncommitted Material Actual Amount', type: NUMBER },
          { key: 'uncommittedInvoiceActualAmount', label: 'Uncommitted Invoice Actual Amount', type: NUMBER },
          { key: 'unallocatedActualAmount', label: 'Unallocated Actual Amount', type: NUMBER },
          { key: 'openCommitmentAmount', label: 'Open Commitment Amount', type: NUMBER },
          { key: 'actualAmount', label: 'Actual Amount', type: NUMBER },
          { key: 'consumedAmount', label: 'Consumed Amount', type: NUMBER },
          { key: 'availableAmount', label: 'Available Amount', type: NUMBER },
          { key: 'varianceAmount', label: 'Variance Amount', type: NUMBER },
          // Source-computed percentages; the source's null (planned = 0) is
          // preserved verbatim, never zero-filled.
          { key: 'utilizationPercent', label: 'Utilization Percent', type: PERCENT },
          { key: 'committedUtilizationPercent', label: 'Committed Utilization Percent', type: PERCENT },
          // Source-owned fail-closed diagnostics at the summary grain —
          // described, never valued, never suppressed.
          { key: 'failClosed', label: 'Fail Closed', type: BOOLEAN },
          { key: 'gapCount', label: 'Gap Count', type: NUMBER },
        ],
        source.map((row) => ({
          budgetId: row.budgetId,
          clientId: row.clientId,
          buildingId: row.buildingId,
          budgetName: row.budgetName,
          // Field copy from the source period object — the budget's own
          // control period.
          periodStart: row.budgetPeriod.start,
          periodEnd: row.budgetPeriod.end,
          currency: row.currency,
          status: row.status,
          // Every figure is the owning authority's own computed value —
          // pure field copy out of the nested totals object, ZERO
          // arithmetic, ZERO rounding, ZERO conversion.
          plannedAmount: row.totals.plannedAmount,
          ledgerCommittedAmount: row.totals.ledgerCommittedAmount,
          ledgerOpenAmount: row.totals.ledgerOpenAmount,
          ledgerActualizedAmount: row.totals.ledgerActualizedAmount,
          ledgerReleasedAmount: row.totals.ledgerReleasedAmount,
          legacyCommittedAmount: row.totals.legacyCommittedAmount,
          uncommittedMaterialActualAmount: row.totals.uncommittedMaterialActualAmount,
          uncommittedInvoiceActualAmount: row.totals.uncommittedInvoiceActualAmount,
          unallocatedActualAmount: row.totals.unallocatedActualAmount,
          openCommitmentAmount: row.totals.openCommitmentAmount,
          actualAmount: row.totals.actualAmount,
          consumedAmount: row.totals.consumedAmount,
          availableAmount: row.totals.availableAmount,
          varianceAmount: row.totals.varianceAmount,
          utilizationPercent: row.totals.utilizationPercent,
          committedUtilizationPercent: row.totals.committedUtilizationPercent,
          failClosed: row.failClosed,
          gapCount: row.gapCount,
        })),
      ),
    ],
  };
}

/**
 * R11 PART 06 — OPERATIONAL_BUDGET_VARIANCE projection, CATEGORY view.
 *
 * A PURE re-presentation of the `categories` child grain of the EXISTING
 * single-budget variance detail read
 * (`operationalVarianceService.getOperationalBudgetVariance`,
 * CR-BE-COMM-VAR-01 PART 05): ONE row per persisted budget category of the
 * addressed budget. Reporting adds nothing: no category engine, no
 * per-category re-computation and no second variance read model is created
 * here.
 *
 * GRAIN — one authoritative category-level variance result per row. This is
 * NOT a budget×category flattening: the budget's own totals row never
 * appears here and no budget-level figure (planned total, uncommitted or
 * unallocated actuals, failClosed, gapCount, gaps, controls or exclusions)
 * is duplicated onto category rows — the category grain does not own them.
 *
 * IDENTITY — `budgetId` (from the source envelope) plus `budgetCategoryId`
 * (the category row's own persisted id). No synthetic id is generated and
 * the category NAME is never an identity.
 *
 * PARENT CONTEXT — clientId, buildingId, currency, the budget's control
 * period (periodStart/periodEnd) and the native budget status and
 * overspendPolicy are field copies from the source envelope, following the
 * PURCHASE_ORDER_REGISTER LINE parent-context precedent: context only,
 * never budget variance figures.
 *
 * ZERO FINANCIAL ARITHMETIC — every per-category figure (plannedAmount,
 * the four ledger amounts, legacyCommittedAmount, openCommitmentAmount,
 * actualAmount, consumedAmount, availableAmount, varianceAmount,
 * utilizationPercent, committedUtilizationPercent, commitmentCount) is the
 * owning authority's own read-time computed value, copied verbatim; the
 * source's null percentages are preserved, never zero-filled.
 *
 * CURRENCY — every row inherits exactly ONE budget currency from the source
 * envelope (a single-budget read can never mix currencies); no conversion,
 * no consolidation.
 *
 * Exactly ONE table (`operationalBudgetVarianceCategory`) is emitted, with
 * no budget, gap, traceability or drill child table, and `kpis` is
 * deliberately empty: no per-category or cross-category aggregate is
 * created. No `csvDefaultTableKey` is added.
 */
export function projectOperationalBudgetVarianceCategory(
  source: PublicOperationalBudgetVariance,
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'operationalBudgetVarianceCategory',
        'Operational Budget Variance Category',
        [
          // Composite source identity: the addressed budget plus the
          // category's own persisted id — never a synthetic key, never the
          // category name.
          { key: 'budgetId', label: 'Budget Id', type: STRING },
          { key: 'budgetCategoryId', label: 'Budget Category Id', type: STRING },
          // Parent budget context, field copies from the source envelope —
          // context only, never budget variance figures.
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          // The ONE budget currency every category row is tied to.
          { key: 'currency', label: 'Currency', type: STRING },
          { key: 'periodStart', label: 'Period Start', type: DATE },
          { key: 'periodEnd', label: 'Period End', type: DATE },
          // Native budget status and overspend policy, verbatim.
          { key: 'status', label: 'Status', type: STRING },
          { key: 'overspendPolicy', label: 'Overspend Policy', type: STRING },
          // Category facts — the source's own persisted descriptors.
          { key: 'categoryCode', label: 'Category Code', type: STRING },
          { key: 'categoryName', label: 'Category Name', type: STRING },
          // Source-computed per-category figures, copied verbatim with ZERO
          // arithmetic.
          { key: 'plannedAmount', label: 'Planned Amount', type: NUMBER },
          { key: 'ledgerCommittedAmount', label: 'Ledger Committed Amount', type: NUMBER },
          { key: 'ledgerOpenAmount', label: 'Ledger Open Amount', type: NUMBER },
          { key: 'ledgerActualizedAmount', label: 'Ledger Actualized Amount', type: NUMBER },
          { key: 'ledgerReleasedAmount', label: 'Ledger Released Amount', type: NUMBER },
          { key: 'legacyCommittedAmount', label: 'Legacy Committed Amount', type: NUMBER },
          { key: 'openCommitmentAmount', label: 'Open Commitment Amount', type: NUMBER },
          { key: 'actualAmount', label: 'Actual Amount', type: NUMBER },
          { key: 'consumedAmount', label: 'Consumed Amount', type: NUMBER },
          { key: 'availableAmount', label: 'Available Amount', type: NUMBER },
          { key: 'varianceAmount', label: 'Variance Amount', type: NUMBER },
          { key: 'utilizationPercent', label: 'Utilization Percent', type: PERCENT },
          { key: 'committedUtilizationPercent', label: 'Committed Utilization Percent', type: PERCENT },
          { key: 'commitmentCount', label: 'Commitment Count', type: NUMBER },
        ],
        source.categories.map((row) => ({
          budgetId: source.budgetId,
          budgetCategoryId: row.budgetCategoryId,
          clientId: source.clientId,
          buildingId: source.buildingId,
          currency: source.currency,
          periodStart: source.budgetPeriod.start,
          periodEnd: source.budgetPeriod.end,
          status: source.status,
          overspendPolicy: source.overspendPolicy,
          categoryCode: row.categoryCode,
          categoryName: row.categoryName,
          plannedAmount: row.plannedAmount,
          ledgerCommittedAmount: row.ledgerCommittedAmount,
          ledgerOpenAmount: row.ledgerOpenAmount,
          ledgerActualizedAmount: row.ledgerActualizedAmount,
          ledgerReleasedAmount: row.ledgerReleasedAmount,
          legacyCommittedAmount: row.legacyCommittedAmount,
          openCommitmentAmount: row.openCommitmentAmount,
          actualAmount: row.actualAmount,
          consumedAmount: row.consumedAmount,
          availableAmount: row.availableAmount,
          varianceAmount: row.varianceAmount,
          utilizationPercent: row.utilizationPercent,
          committedUtilizationPercent: row.committedUtilizationPercent,
          commitmentCount: row.commitmentCount,
        })),
      ),
    ],
  };
}
