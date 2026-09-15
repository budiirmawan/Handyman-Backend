import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import { priceCatalogLookupService } from '../price-catalog-entries';
import type {
  PriceCatalogCurrency,
  PriceCatalogScopeTier,
} from '../price-catalog-entries';
import { rfqRepository, type RfqRecord } from '../rfqs';
import { rfqComparisonRepository } from './rfq-comparison.repository';
import {
  rfqComparisonCurrencyInvalidError,
  rfqComparisonEvaluationAlreadyExistsError,
  rfqComparisonEvaluationEvidenceInvalidError,
  rfqComparisonEvaluationNotFoundError,
  rfqComparisonEvidenceInvalidError,
  rfqComparisonIdempotencyConflictError,
  rfqComparisonLineInvalidError,
  rfqComparisonNotFoundError,
  rfqComparisonReferenceAmbiguousError,
  rfqComparisonRevisionAmbiguousError,
  rfqComparisonRfqInvalidError,
} from './rfq-comparison.errors';
import {
  EMPTY_REFERENCE,
  type CreateRfqEvaluationInput,
  type PublicRfqComparison,
  type PublicRfqComparisonEvidence,
  type PublicRfqComparisonEvaluation,
  type PublicRfqComparisonLine,
  type PublicRfqComparisonLineOffer,
  type PublicRfqComparisonLineReference,
  type RfqComparisonEvaluationRecord,
  type RfqComparisonEvidenceRecord,
  type RfqComparisonLineRecord,
  type RfqComparisonLineReference,
  type RfqComparisonRunRecord,
  type UpdateRfqEvaluationInput,
} from './rfq-comparison.types';

const UNIQUE_VIOLATION = '23505';

type CandidateRevision = {
  id: string | null;
  quotationId: string;
  rfqId: string;
  invitationId: string;
  vendorId: string;
  clientId: string;
  buildingId: string;
  quotationStatus: 'DRAFT' | 'SUBMITTED' | 'WITHDRAWN';
  invitationRfqId: string;
  invitationVendorId: string;
  invitationClientId: string;
  invitationBuildingId: string;
  invitationStatus: string;
  vendorClientId: string;
  vendorStatus: string;
  vendorBuildingActive: boolean;
  quotationNumber: string;
  revisionNumber: number | null;
  revisionStatus: 'DRAFT' | 'SUBMITTED' | 'SUPERSEDED' | null;
  revisionRfqId: string | null;
  revisionInvitationId: string | null;
  revisionVendorId: string | null;
  revisionClientId: string | null;
  revisionBuildingId: string | null;
  submittedAt: Date | null;
  currency: string | null;
  validUntil: string | null;
  leadTimeDays: number | null;
  deliveryTerms: string | null;
  serviceTerms: string | null;
  notes: string | null;
};

type CanonicalLine = {
  id: string;
  rfqId: string;
  sourceMode: 'MATERIAL' | 'SERVICE';
  lineNumber: number;
  sourceDescription: string;
  sourceItemId: string | null;
  sourceUomId: string | null;
  /** CR-BE-SVC-01 PART 04/05 — governed SERVICE identity on the RFQ line. */
  sourceServiceId: string | null;
  quantitySnapshot: string | number | null;
};

type QuotationLineSnapshot = {
  id: string;
  quotationRevisionId: string;
  quotationId: string;
  rfqId: string;
  rfqLineId: string;
  sourceMode: 'MATERIAL' | 'SERVICE';
  lineNumberSnapshot: number;
  description: string | null;
  requiredQuantitySnapshot: string | number | null;
  requiredUomId: string | null;
  quotedQuantity: string | number | null;
  unitPrice: string | number;
  lineTotal: string | number;
  technicalCompliance: 'COMPLIANT' | 'NON_COMPLIANT' | 'NOT_STATED';
  deviationNotes: string | null;
};

type AttachmentSnapshot = {
  supportingDocumentId: string;
  documentId: string;
};

type ComparisonDetails = {
  run: RfqComparisonRunRecord;
  evidence: RfqComparisonEvidenceRecord[];
  lines: RfqComparisonLineRecord[];
  attachments: Array<{
    evidenceId: string;
    supportingDocumentId: string;
    documentId: string;
  }>;
  evaluations: RfqComparisonEvaluationRecord[];
};

function uniqueConstraint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === UNIQUE_VIOLATION && typeof candidate.constraint === 'string'
    ? candidate.constraint
    : undefined;
}

function fingerprint(rfqId: string): string {
  return createHash('sha256').update(JSON.stringify({ rfqId })).digest('hex');
}

function sameNumber(left: string | number | null, right: string | number | null): boolean {
  if (left === null || right === null) return left === right;
  return Number(left) === Number(right);
}

function money(value: string | number): number {
  return Number(value);
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

function percentageDelta(low: number, high: number): number | null {
  if (low === 0) return null;
  return roundMoney(((high - low) / low) * 100);
}

async function loadCandidateRows(client: PoolClient, rfqId: string): Promise<CandidateRevision[]> {
  const result = await client.query<CandidateRevision>(
    `SELECT
       q.id AS "quotationId", q.rfq_id AS "rfqId", q.invitation_id AS "invitationId",
       q.vendor_id AS "vendorId", q.client_id AS "clientId", q.building_id AS "buildingId",
       q.status AS "quotationStatus", q.quotation_number AS "quotationNumber",
       i.rfq_id AS "invitationRfqId", i.vendor_id AS "invitationVendorId",
       i.client_id AS "invitationClientId", i.building_id AS "invitationBuildingId",
       i.status AS "invitationStatus", v.client_id AS "vendorClientId", v.status AS "vendorStatus",
       EXISTS (
         SELECT 1 FROM vendor_building_relationships vbr
          WHERE vbr.vendor_id = q.vendor_id
            AND vbr.building_id = q.building_id
            AND vbr.status = 'ACTIVE'
            AND (vbr.effective_from IS NULL OR vbr.effective_from <= NOW())
            AND (vbr.effective_until IS NULL OR vbr.effective_until >= NOW())
       ) AS "vendorBuildingActive",
       r.id AS id, r.rfq_id AS "revisionRfqId",
       r.invitation_id AS "revisionInvitationId", r.vendor_id AS "revisionVendorId",
       r.client_id AS "revisionClientId", r.building_id AS "revisionBuildingId",
       r.revision_number AS "revisionNumber", r.status AS "revisionStatus",
       r.submitted_at AS "submittedAt", r.currency,
       r.valid_until::text AS "validUntil", r.lead_time_days AS "leadTimeDays",
       r.delivery_terms AS "deliveryTerms", r.service_terms AS "serviceTerms", r.notes
      FROM vendor_quotations q
      JOIN rfq_vendor_invitations i ON i.id = q.invitation_id
      JOIN vendors v ON v.id = q.vendor_id
      LEFT JOIN vendor_quotation_revisions r ON r.quotation_id = q.id
     WHERE q.rfq_id = $1
     ORDER BY q.id, r.revision_number NULLS FIRST`,
    [rfqId],
  );
  return result.rows;
}

async function loadCanonicalLines(client: PoolClient, rfqId: string): Promise<CanonicalLine[]> {
  const result = await client.query<CanonicalLine>(
    `SELECT id, rfq_id AS "rfqId", source_mode AS "sourceMode",
            line_number AS "lineNumber", source_description AS "sourceDescription",
            source_item_id AS "sourceItemId", source_uom_id AS "sourceUomId",
            source_service_id AS "sourceServiceId",
            quantity_snapshot AS "quantitySnapshot"
       FROM rfq_lines
      WHERE rfq_id = $1
      ORDER BY line_number, id
      FOR UPDATE`,
    [rfqId],
  );
  return result.rows;
}

async function loadQuotationLines(client: PoolClient, revisionId: string): Promise<QuotationLineSnapshot[]> {
  const result = await client.query<QuotationLineSnapshot>(
    `SELECT id, quotation_revision_id AS "quotationRevisionId",
            quotation_id AS "quotationId", rfq_id AS "rfqId",
            rfq_line_id AS "rfqLineId", source_mode AS "sourceMode",
            line_number_snapshot AS "lineNumberSnapshot", description,
            required_quantity_snapshot AS "requiredQuantitySnapshot",
            required_uom_id AS "requiredUomId", quoted_quantity AS "quotedQuantity",
            unit_price AS "unitPrice", line_total AS "lineTotal",
            technical_compliance AS "technicalCompliance", deviation_notes AS "deviationNotes"
       FROM vendor_quotation_lines
      WHERE quotation_revision_id = $1
      ORDER BY line_number_snapshot, id
      FOR UPDATE`,
    [revisionId],
  );
  return result.rows;
}

async function loadAttachments(client: PoolClient, revisionId: string): Promise<AttachmentSnapshot[]> {
  const result = await client.query<AttachmentSnapshot>(
    `SELECT sd.id AS "supportingDocumentId", sd.document_id AS "documentId"
       FROM supporting_documents sd
       JOIN documents d ON d.id = sd.document_id
      WHERE sd.parent_type = 'QUOTATION_REVISION' AND sd.parent_id = $1
      ORDER BY sd.created_at, sd.id`,
    [revisionId],
  );
  return result.rows;
}

function groupCandidates(rows: CandidateRevision[]): CandidateRevision[][] {
  const grouped = new Map<string, CandidateRevision[]>();
  for (const row of rows) {
    const current = grouped.get(row.quotationId) ?? [];
    current.push(row);
    grouped.set(row.quotationId, current);
  }
  return [...grouped.values()];
}

function assertCandidateScope(row: CandidateRevision, rfq: RfqRecord): void {
  if (row.rfqId !== rfq.id || row.invitationRfqId !== rfq.id
    || row.clientId !== rfq.clientId || row.buildingId !== rfq.buildingId
    || row.invitationClientId !== rfq.clientId || row.invitationBuildingId !== rfq.buildingId
    || row.vendorId !== row.invitationVendorId || row.vendorClientId !== rfq.clientId
    || row.vendorId !== row.revisionVendorId || row.revisionRfqId !== rfq.id
    || row.revisionInvitationId !== row.invitationId || row.revisionClientId !== rfq.clientId
    || row.revisionBuildingId !== rfq.buildingId || row.revisionNumber === null) {
    throw rfqComparisonEvidenceInvalidError();
  }
}

function selectApplicable(rows: CandidateRevision[], rfq: RfqRecord): CandidateRevision | null {
  const submitted = rows.filter((row) => row.revisionStatus === 'SUBMITTED');
  if (submitted.length > 1) throw rfqComparisonRevisionAmbiguousError();
  if (submitted.length === 0) {
    // A draft-only quotation is intentionally not comparison evidence. A
    // terminal quotation with no submitted revision is also not evidence.
    if (rows.some((row) => row.quotationStatus === 'SUBMITTED')) {
      throw rfqComparisonEvidenceInvalidError();
    }
    return null;
  }

  const selected = submitted[0];
  assertCandidateScope(selected, rfq);
  if (selected.quotationStatus !== 'SUBMITTED'
    || selected.invitationStatus !== 'QUOTATION_SUBMITTED'
    || selected.vendorStatus !== 'ACTIVE'
    || !selected.vendorBuildingActive
    || selected.submittedAt === null
    || selected.currency === null) {
    throw rfqComparisonEvidenceInvalidError();
  }
  if (selected.currency !== rfq.currency) throw rfqComparisonCurrencyInvalidError();
  return selected;
}

function assertQuotationLineShape(
  line: QuotationLineSnapshot,
  canonical: CanonicalLine,
): void {
  if (line.rfqId !== canonical.rfqId || line.rfqLineId !== canonical.id
    || line.sourceMode !== canonical.sourceMode
    || line.lineNumberSnapshot !== canonical.lineNumber
    || !sameNumber(line.requiredQuantitySnapshot, canonical.quantitySnapshot)
    || line.requiredUomId !== canonical.sourceUomId) {
    throw rfqComparisonLineInvalidError();
  }
  if (canonical.sourceMode === 'MATERIAL'
    && (line.quotedQuantity === null || !sameNumber(line.quotedQuantity, canonical.quantitySnapshot))) {
    throw rfqComparisonLineInvalidError();
  }
  if (canonical.sourceMode === 'SERVICE'
    && (line.requiredQuantitySnapshot !== null || line.quotedQuantity !== null || line.requiredUomId !== null)) {
    throw rfqComparisonLineInvalidError();
  }
}

/**
 * CR-BE-PRICE-01 PART 04 — advisory reference snapshot for one comparison
 * line (governance §12).
 *
 * Context is exact: the RFQ line's immutable material/UOM snapshots, the
 * run's Client/Building/currency, the evidence row's Vendor, and as-of =
 * run `snapshot_at`. SERVICE lines are `NOT_REQUESTED` without touching the
 * resolver. A MATERIAL line whose required UOM is structurally absent can
 * never satisfy §10 exact equality → `UOM_INCOMPATIBLE` (fail closed, no
 * resolver call). `AMBIGUOUS` fails the whole run creation (§8) — the
 * resolver already recorded durable incident evidence — while every other
 * non-matched outcome is recorded and never blocks the run (§12.3).
 * Variances are quotation-minus-reference at 2dp (`roundMoney` convention);
 * re-derivation after snapshot is prohibited (§15).
 */
async function resolveLineReference(
  run: RfqComparisonRunRecord,
  vendorId: string,
  canonical: CanonicalLine,
  quotedUnitPrice: number,
  quotedLineTotal: number,
  actorUserId: string,
): Promise<RfqComparisonLineReference> {
  if (canonical.sourceMode === 'SERVICE') {
    // CR-BE-SVC-01 PART 05 — a SERVICE line resolves against the governed
    // SERVICE reference authority only when it carries a governed identity
    // (PART 04). Un-governed SERVICE lines remain NOT_REQUESTED. SERVICE has
    // no quantity/UOM: unit-vs-unit advisory only (no reference total / total
    // variance). No inference/backfill from service_type.
    if (canonical.sourceServiceId === null) {
      return { ...EMPTY_REFERENCE, resolution: 'NOT_REQUESTED' };
    }
    const lookup = await priceCatalogLookupService.lookupPriceCatalogEntry(
      {
        sourceMode: 'SERVICE',
        buildingId: run.buildingId,
        vendorId,
        serviceId: canonical.sourceServiceId,
        currency: run.currency as PriceCatalogCurrency,
        asOf: run.snapshotAt.toISOString(),
      },
      actorUserId,
    );
    if (lookup.resolution === 'AMBIGUOUS') {
      throw rfqComparisonReferenceAmbiguousError();
    }
    if (lookup.resolution !== 'MATCHED' || lookup.entry === null) {
      return { ...EMPTY_REFERENCE, resolution: lookup.resolution };
    }
    const entry = lookup.entry;
    const tier: Record<PriceCatalogScopeTier, [boolean, boolean]> = {
      VENDOR_BUILDING: [true, true],
      VENDOR: [true, false],
      BUILDING: [false, true],
      CLIENT_WIDE: [false, false],
    };
    const [scopeVendor, scopeBuilding] = tier[lookup.scopeTier ?? 'CLIENT_WIDE'];
    const unitVariance = roundMoney(quotedUnitPrice - entry.unitPrice);
    const variancePercent = roundMoney((unitVariance / entry.unitPrice) * 100);
    return {
      priceEntryId: entry.id,
      unitPrice: entry.unitPrice,
      currency: entry.currency,
      uomId: null, // SERVICE has no UOM
      scopeVendor,
      scopeBuilding,
      effectiveFrom: new Date(entry.effectiveFrom),
      resolution: 'MATCHED',
      referenceTotal: null, // SERVICE has no governed quantity
      unitVariance,
      totalVariance: null,
      variancePercent,
      position: unitVariance > 0 ? 'ABOVE' : unitVariance < 0 ? 'BELOW' : 'EQUAL',
    };
  }
  if (canonical.sourceItemId === null || canonical.sourceUomId === null) {
    return { ...EMPTY_REFERENCE, resolution: 'UOM_INCOMPATIBLE' };
  }

  const lookup = await priceCatalogLookupService.lookupPriceCatalogEntry(
    {
      sourceMode: 'MATERIAL',
      buildingId: run.buildingId,
      vendorId,
      itemId: canonical.sourceItemId,
      uomId: canonical.sourceUomId,
      currency: run.currency as PriceCatalogCurrency,
      asOf: run.snapshotAt.toISOString(),
    },
    actorUserId,
  );

  if (lookup.resolution === 'AMBIGUOUS') {
    throw rfqComparisonReferenceAmbiguousError();
  }
  if (lookup.resolution !== 'MATCHED' || lookup.entry === null) {
    return { ...EMPTY_REFERENCE, resolution: lookup.resolution };
  }

  const entry = lookup.entry;
  const tier: Record<PriceCatalogScopeTier, [boolean, boolean]> = {
    VENDOR_BUILDING: [true, true],
    VENDOR: [true, false],
    BUILDING: [false, true],
    CLIENT_WIDE: [false, false],
  };
  const [scopeVendor, scopeBuilding] = tier[lookup.scopeTier ?? 'CLIENT_WIDE'];
  const referenceTotal = roundMoney(
    entry.unitPrice * Number(canonical.quantitySnapshot),
  );
  const unitVariance = roundMoney(quotedUnitPrice - entry.unitPrice);
  const totalVariance = roundMoney(quotedLineTotal - referenceTotal);
  // Catalog unit prices are > 0 by CHECK, so the division is structurally
  // safe (R-16); zero/negative bases can never occur here.
  const variancePercent = roundMoney((unitVariance / entry.unitPrice) * 100);
  return {
    priceEntryId: entry.id,
    unitPrice: entry.unitPrice,
    currency: entry.currency,
    uomId: entry.uomId,
    scopeVendor,
    scopeBuilding,
    effectiveFrom: new Date(entry.effectiveFrom),
    resolution: 'MATCHED',
    referenceTotal,
    unitVariance,
    totalVariance,
    variancePercent,
    position: unitVariance > 0 ? 'ABOVE' : unitVariance < 0 ? 'BELOW' : 'EQUAL',
  };
}

function createLineSnapshot(
  comparisonRunId: string,
  evidenceId: string,
  selected: CandidateRevision,
  line: QuotationLineSnapshot,
  canonical: CanonicalLine,
  reference: RfqComparisonLineReference,
): Parameters<typeof rfqComparisonRepository.createLineWithClient>[1] {
  return {
    comparisonRunId,
    evidenceId,
    rfqId: canonical.rfqId,
    rfqLineId: canonical.id,
    quotationLineId: line.id,
    sourceMode: canonical.sourceMode,
    rfqLineNumberSnapshot: canonical.lineNumber,
    descriptionSnapshot: canonical.sourceDescription,
    offeredDescriptionSnapshot: line.description,
    requiredQuantitySnapshot: canonical.sourceMode === 'SERVICE' ? null : Number(canonical.quantitySnapshot),
    requiredUomId: canonical.sourceMode === 'SERVICE' ? null : canonical.sourceUomId,
    quotedQuantitySnapshot: canonical.sourceMode === 'SERVICE' ? null : Number(line.quotedQuantity),
    unitPrice: money(line.unitPrice),
    lineTotal: money(line.lineTotal),
    technicalCompliance: line.technicalCompliance,
    deviationNotes: line.deviationNotes,
    lineStatus: 'QUOTED',
    reference,
  };
}

type ReferenceResolutionSummary = {
  rfqLineId: string;
  vendorId: string;
  resolution: RfqComparisonLineReference['resolution'];
  priceEntryId: string | null;
};

async function createSnapshotEvidence(
  client: PoolClient,
  run: RfqComparisonRunRecord,
  selected: CandidateRevision,
  canonicalLines: CanonicalLine[],
  actorUserId: string,
  resolutions: ReferenceResolutionSummary[],
): Promise<void> {
  if (selected.id === null || selected.submittedAt === null || selected.currency === null) {
    throw rfqComparisonEvidenceInvalidError();
  }
  const quotationLines = await loadQuotationLines(client, selected.id);
  if (quotationLines.length !== canonicalLines.length) throw rfqComparisonLineInvalidError();
  const canonicalById = new Map(canonicalLines.map((line) => [line.id, line]));
  const seen = new Set<string>();
  for (const line of quotationLines) {
    const canonical = canonicalById.get(line.rfqLineId);
    if (line.quotationRevisionId !== selected.id || line.quotationId !== selected.quotationId
      || !canonical || seen.has(line.rfqLineId)) throw rfqComparisonLineInvalidError();
    seen.add(line.rfqLineId);
    assertQuotationLineShape(line, canonical);
  }
  if (seen.size !== canonicalLines.length) throw rfqComparisonLineInvalidError();

  const totalResult = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(line_total), 0)::text AS total
       FROM vendor_quotation_lines WHERE quotation_revision_id = $1`,
    [selected.id],
  );
  const totalAmount = money(totalResult.rows[0]?.total ?? '0');
  const evidence = await rfqComparisonRepository.createEvidenceWithClient(client, {
    comparisonRunId: run.id,
    rfqId: run.rfqId,
    invitationId: selected.invitationId,
    quotationId: selected.quotationId,
    quotationRevisionId: selected.id,
    vendorId: selected.vendorId,
    clientId: run.clientId,
    buildingId: run.buildingId,
    quotationNumberSnapshot: selected.quotationNumber,
    revisionNumberSnapshot: selected.revisionNumber ?? 0,
    submittedAt: selected.submittedAt,
    currency: selected.currency,
    validUntil: selected.validUntil,
    leadTimeDays: selected.leadTimeDays,
    deliveryTerms: selected.deliveryTerms,
    serviceTerms: selected.serviceTerms,
    notes: selected.notes,
    totalAmount,
  });

  for (const line of quotationLines) {
    const canonical = canonicalById.get(line.rfqLineId)!;
    // PART 04: freeze the advisory reference snapshot alongside the exact
    // quotation line facts (governance §12/§15 — snapshot, never recompute).
    const reference = await resolveLineReference(
      run,
      selected.vendorId,
      canonical,
      money(line.unitPrice),
      money(line.lineTotal),
      actorUserId,
    );
    resolutions.push({
      rfqLineId: canonical.id,
      vendorId: selected.vendorId,
      resolution: reference.resolution,
      priceEntryId: reference.priceEntryId,
    });
    await rfqComparisonRepository.createLineWithClient(
      client,
      createLineSnapshot(run.id, evidence.id, selected, line, canonical, reference),
    );
  }

  for (const attachment of await loadAttachments(client, selected.id)) {
    await rfqComparisonRepository.createAttachmentWithClient(client, {
      comparisonRunId: run.id,
      evidenceId: evidence.id,
      supportingDocumentId: attachment.supportingDocumentId,
      documentId: attachment.documentId,
    });
  }
}

async function loadDetails(run: RfqComparisonRunRecord): Promise<ComparisonDetails> {
  const [evidence, lines, attachments, evaluations] = await Promise.all([
    rfqComparisonRepository.listEvidence(run.id),
    rfqComparisonRepository.listLines(run.id),
    rfqComparisonRepository.listAttachments(run.id),
    rfqComparisonRepository.listEvaluations(run.id),
  ]);
  return { run, evidence, lines, attachments, evaluations };
}

function toPublicEvaluation(record: RfqComparisonEvaluationRecord): PublicRfqComparisonEvaluation {
  return {
    id: record.id,
    comparisonRunId: record.comparisonRunId,
    evidenceId: record.evidenceId,
    rfqId: record.rfqId,
    vendorId: record.vendorId,
    quotationRevisionId: record.quotationRevisionId,
    commercialObservation: record.commercialObservation,
    technicalObservation: record.technicalObservation,
    complianceObservation: record.complianceObservation,
    evaluatorNote: record.evaluatorNote,
    createdByUserId: record.createdByUserId,
    updatedByUserId: record.updatedByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function publicEvidence(
  evidence: RfqComparisonEvidenceRecord,
  lines: RfqComparisonLineRecord[],
  attachments: ComparisonDetails['attachments'],
): PublicRfqComparisonEvidence {
  return {
    evidenceId: evidence.id,
    vendorId: evidence.vendorId,
    invitationId: evidence.invitationId,
    quotationId: evidence.quotationId,
    quotationRevisionId: evidence.quotationRevisionId,
    quotationNumber: evidence.quotationNumberSnapshot,
    revisionNumber: evidence.revisionNumberSnapshot,
    submittedAt: evidence.submittedAt.toISOString(),
    currency: evidence.currency,
    validUntil: evidence.validUntil,
    leadTimeDays: evidence.leadTimeDays,
    deliveryTerms: evidence.deliveryTerms,
    serviceTerms: evidence.serviceTerms,
    notes: evidence.notes,
    totalAmount: evidence.totalAmount,
    lines: lines.map((line) => ({
      quotationLineId: line.quotationLineId,
      rfqLineId: line.rfqLineId,
      lineNumber: line.rfqLineNumberSnapshot,
      sourceMode: line.sourceMode,
      description: line.descriptionSnapshot,
      offeredDescription: line.offeredDescriptionSnapshot,
      requiredQuantity: line.requiredQuantitySnapshot,
      requiredUomId: line.requiredUomId,
      quotedQuantity: line.quotedQuantitySnapshot,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      technicalCompliance: line.technicalCompliance,
      deviationNotes: line.deviationNotes,
      lineStatus: line.lineStatus,
    })),
    attachments: attachments
      .filter((attachment) => attachment.evidenceId === evidence.id)
      .map((attachment) => ({
        supportingDocumentId: attachment.supportingDocumentId,
        documentId: attachment.documentId,
      })),
  };
}

function publicReference(
  reference: RfqComparisonLineReference,
): PublicRfqComparisonLineReference {
  return {
    priceEntryId: reference.priceEntryId,
    unitPrice: reference.unitPrice,
    currency: reference.currency,
    uomId: reference.uomId,
    scopeVendor: reference.scopeVendor,
    scopeBuilding: reference.scopeBuilding,
    effectiveFrom: reference.effectiveFrom?.toISOString() ?? null,
    resolution: reference.resolution,
    referenceTotal: reference.referenceTotal,
    unitVariance: reference.unitVariance,
    totalVariance: reference.totalVariance,
    variancePercent: reference.variancePercent,
    position: reference.position,
  };
}

function offerFromLine(
  evidence: RfqComparisonEvidenceRecord,
  line: RfqComparisonLineRecord,
  includeReference: boolean,
): PublicRfqComparisonLineOffer {
  return {
    evidenceId: evidence.id,
    vendorId: evidence.vendorId,
    invitationId: evidence.invitationId,
    quotationId: evidence.quotationId,
    quotationRevisionId: evidence.quotationRevisionId,
    revisionNumber: evidence.revisionNumberSnapshot,
    submittedAt: evidence.submittedAt.toISOString(),
    quotedQuantity: line.quotedQuantitySnapshot,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
    technicalCompliance: line.technicalCompliance,
    deviationNotes: line.deviationNotes,
    ...(includeReference ? { reference: publicReference(line.reference) } : {}),
  };
}

function publicComparison(
  details: ComparisonDetails,
  includeReference: boolean,
): PublicRfqComparison {
  const { run, evidence, lines, attachments, evaluations } = details;
  const byEvidence = new Map(evidence.map((item) => [item.id, item]));
  const grouped = new Map<string, RfqComparisonLineRecord[]>();
  for (const line of lines) {
    const current = grouped.get(line.rfqLineId) ?? [];
    current.push(line);
    grouped.set(line.rfqLineId, current);
  }

  const publicLines: PublicRfqComparisonLine[] = [];
  for (const records of grouped.values()) {
    const first = records[0];
    const offers = records
      .map((line) => {
        const evidenceRecord = byEvidence.get(line.evidenceId);
        return evidenceRecord
          ? offerFromLine(evidenceRecord, line, includeReference)
          : null;
      })
      .filter((offer): offer is PublicRfqComparisonLineOffer => offer !== null)
      .sort((left, right) => left.vendorId.localeCompare(right.vendorId));
    const prices = offers.map((offer) => offer.unitPrice);
    const lowest = prices.length ? Math.min(...prices) : null;
    const highest = prices.length ? Math.max(...prices) : null;
    publicLines.push({
      rfqLineId: first.rfqLineId,
      lineNumber: first.rfqLineNumberSnapshot,
      sourceMode: first.sourceMode,
      description: first.descriptionSnapshot,
      requiredQuantity: first.requiredQuantitySnapshot,
      requiredUomId: first.requiredUomId,
      offers,
      lowestQuotedUnitPrice: lowest,
      highestQuotedUnitPrice: highest,
      priceDelta: lowest === null || highest === null ? null : roundMoney(highest - lowest),
      percentageDelta: lowest === null || highest === null ? null : percentageDelta(lowest, highest),
    });
  }
  publicLines.sort((left, right) => left.lineNumber - right.lineNumber || left.rfqLineId.localeCompare(right.rfqLineId));

  const orderedEvidence = [...evidence].sort((left, right) => left.vendorId.localeCompare(right.vendorId));
  const totals = orderedEvidence.map((item) => item.totalAmount);
  const lowestTotalAmount = totals.length ? Math.min(...totals) : null;
  const highestTotalAmount = totals.length ? Math.max(...totals) : null;
  const lowestTotalQuotations = lowestTotalAmount === null
    ? []
    : orderedEvidence
      .filter((item) => item.totalAmount === lowestTotalAmount)
      .map((item) => ({ evidenceId: item.id, vendorId: item.vendorId, totalAmount: item.totalAmount }));

  return {
    id: run.id,
    rfqId: run.rfqId,
    clientId: run.clientId,
    buildingId: run.buildingId,
    sourceMode: run.sourceMode,
    currency: run.currency,
    rfqNumber: run.rfqNumberSnapshot,
    status: run.status,
    snapshotAt: run.snapshotAt.toISOString(),
    createdByUserId: run.createdByUserId,
    createdAt: run.createdAt.toISOString(),
    evidence: orderedEvidence.map((item) => publicEvidence(
      item,
      lines.filter((line) => line.evidenceId === item.id).sort((left, right) => left.rfqLineNumberSnapshot - right.rfqLineNumberSnapshot),
      attachments,
    )),
    lines: publicLines,
    commercial: {
      lowestTotalQuotations,
      lowestTotalAmount,
      highestTotalAmount,
      totalPriceSpread: lowestTotalAmount === null || highestTotalAmount === null
        ? null
        : roundMoney(highestTotalAmount - lowestTotalAmount),
    },
    evaluations: evaluations.map(toPublicEvaluation),
  };
}

async function requireRun(runId: string, actorUserId: string): Promise<RfqComparisonRunRecord> {
  const run = await rfqComparisonRepository.findRunById(runId);
  if (!run) throw rfqComparisonNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, run.buildingId);
  return run;
}

export async function createRfqComparison(
  input: { rfqId: string; idempotencyKey: string },
  actorUserId: string,
): Promise<PublicRfqComparison> {
  const initial = await rfqRepository.findById(input.rfqId);
  if (!initial) throw rfqComparisonRfqInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, initial.buildingId);

  const run = await withTransaction(async (client) => {
    const rfq = await rfqRepository.findByIdForUpdate(client, input.rfqId);
    if (!rfq || !['OPEN', 'CLOSED'].includes(rfq.status)) throw rfqComparisonRfqInvalidError();
    const existing = await rfqComparisonRepository.findRunByIdempotencyForUpdate(client, rfq.id, input.idempotencyKey);
    const runFingerprint = fingerprint(rfq.id);
    if (existing) {
      if (existing.idempotencyFingerprint !== runFingerprint) throw rfqComparisonIdempotencyConflictError();
      return existing;
    }

    const result = await rfqComparisonRepository.createRunIdempotent(client, {
      rfqId: rfq.id,
      clientId: rfq.clientId,
      buildingId: rfq.buildingId,
      sourceMode: rfq.sourceMode,
      currency: rfq.currency,
      rfqNumberSnapshot: rfq.rfqNumber,
      createdByUserId: actorUserId,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: runFingerprint,
    });
    if (!result.created) return result.record;

    const canonicalLines = await loadCanonicalLines(client, rfq.id);
    const selected = groupCandidates(await loadCandidateRows(client, rfq.id))
      .map((rows) => selectApplicable(rows, rfq))
      .filter((row): row is CandidateRevision => row !== null);
    const selectedVendors = new Set<string>();
    const referenceResolutions: ReferenceResolutionSummary[] = [];
    for (const candidate of selected) {
      if (selectedVendors.has(candidate.vendorId)) throw rfqComparisonEvidenceInvalidError();
      selectedVendors.add(candidate.vendorId);

      await createSnapshotEvidence(
        client,
        result.record,
        candidate,
        canonicalLines,
        actorUserId,
        referenceResolutions,
      );
    }

    await recordOperationalEvent({
      clientId: rfq.clientId,
      buildingId: rfq.buildingId,
      eventType: 'RFQ_COMPARISON_CREATED',
      entityType: 'RFQ_COMPARISON_RUN',
      entityId: result.record.id,
      actorUserId,
      summary: 'Immutable RFQ quotation comparison snapshot created.',
      metadata: {
        rfqId: rfq.id,
        comparisonRunId: result.record.id,
        quotationRevisionIds: selected.map((item) => item.id),
        vendorIds: selected.map((item) => item.vendorId),
      },
    }, client);

    // PART 04 (§17): one governed summary event per run — chosen over
    // per-line events so audit volume tracks runs; non-matched lines are
    // enumerated for traceability. Ordinary matched IDs live on the lines
    // themselves (the authoritative snapshot).
    const outcomeCounts: Record<string, number> = {};
    for (const item of referenceResolutions) {
      if (item.resolution === null) continue;
      outcomeCounts[item.resolution] = (outcomeCounts[item.resolution] ?? 0) + 1;
    }
    await recordOperationalEvent({
      clientId: rfq.clientId,
      buildingId: rfq.buildingId,
      eventType: 'RFQ_COMPARISON_REFERENCE_RESOLVED',
      entityType: 'RFQ_COMPARISON_RUN',
      entityId: result.record.id,
      actorUserId,
      summary: 'Advisory reference prices resolved and frozen onto the comparison run.',
      metadata: {
        rfqId: rfq.id,
        comparisonRunId: result.record.id,
        outcomeCounts,
        unmatchedLines: referenceResolutions
          .filter((item) => item.resolution !== 'MATCHED')
          .map((item) => ({
            rfqLineId: item.rfqLineId,
            vendorId: item.vendorId,
            resolution: item.resolution,
          })),
      },
    }, client);
    return result.record;
  });

  return publicComparison(
    await loadDetails(run),
    await canReadPriceReference(actorUserId),
  );
}

/**
 * PART 04 (§20): the comparison read model extends with reference fields
 * only when the caller holds BOTH `rfq.read` (route gate) and
 * `price_catalog.read` — the conjunctive default recorded in governance.
 */
async function canReadPriceReference(actorUserId: string): Promise<boolean> {
  const permissions = await permissionService.resolvePermissionsForUser(actorUserId);
  return permissions.includes('price_catalog.read');
}

export async function getRfqComparison(comparisonId: string, actorUserId: string): Promise<PublicRfqComparison> {
  const run = await requireRun(comparisonId, actorUserId);
  return publicComparison(
    await loadDetails(run),
    await canReadPriceReference(actorUserId),
  );
}

export async function listRfqComparisons(rfqId: string, actorUserId: string): Promise<PublicRfqComparison[]> {
  const rfq = await rfqRepository.findById(rfqId);
  if (!rfq) throw rfqComparisonRfqInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, rfq.buildingId);
  const runs = await rfqComparisonRepository.listRunsByRfq(rfqId);
  const includeReference = await canReadPriceReference(actorUserId);
  return Promise.all(runs.map(async (run) => publicComparison(await loadDetails(run), includeReference)));
}

export async function listRfqComparisonEvaluations(comparisonId: string, actorUserId: string): Promise<PublicRfqComparisonEvaluation[]> {
  const run = await requireRun(comparisonId, actorUserId);
  return (await rfqComparisonRepository.listEvaluations(run.id)).map(toPublicEvaluation);
}

export async function getRfqComparisonEvaluation(evaluationId: string, actorUserId: string): Promise<PublicRfqComparisonEvaluation> {
  const evaluation = await rfqComparisonRepository.findEvaluationById(evaluationId);
  if (!evaluation) throw rfqComparisonEvaluationNotFoundError();
  await requireRun(evaluation.comparisonRunId, actorUserId);
  return toPublicEvaluation(evaluation);
}

async function findEvidenceForEvaluation(
  client: PoolClient,
  comparisonId: string,
  evidenceId: string | undefined,
  vendorId: string | undefined,
): Promise<RfqComparisonEvidenceRecord> {
  const evidence = await client.query<RfqComparisonEvidenceRecord>(
    `SELECT id, comparison_run_id AS "comparisonRunId", rfq_id AS "rfqId",
            invitation_id AS "invitationId", quotation_id AS "quotationId",
            quotation_revision_id AS "quotationRevisionId", vendor_id AS "vendorId",
            client_id AS "clientId", building_id AS "buildingId",
            quotation_number_snapshot AS "quotationNumberSnapshot",
            revision_number_snapshot AS "revisionNumberSnapshot", submitted_at AS "submittedAt",
            currency, valid_until::text AS "validUntil", lead_time_days AS "leadTimeDays",
            delivery_terms AS "deliveryTerms", service_terms AS "serviceTerms", notes,
            total_amount AS "totalAmount", created_at AS "createdAt"
       FROM rfq_comparison_evidence
      WHERE comparison_run_id = $1
        AND ($2::uuid IS NULL OR id = $2)
        AND ($3::uuid IS NULL OR vendor_id = $3)
      ORDER BY id
      LIMIT 2`,
    [comparisonId, evidenceId ?? null, vendorId ?? null],
  );
  if (evidence.rows.length !== 1) throw rfqComparisonEvaluationEvidenceInvalidError();
  const row = evidence.rows[0];
  return { ...row, totalAmount: Number(row.totalAmount) };
}

export async function createRfqComparisonEvaluation(
  input: CreateRfqEvaluationInput,
  actorUserId: string,
): Promise<PublicRfqComparisonEvaluation> {
  const run = await requireRun(input.comparisonRunId, actorUserId);
  const result = await withTransaction(async (client) => {
    const lockedRun = await rfqComparisonRepository.findRunByIdForUpdate(client, run.id);
    if (!lockedRun) throw rfqComparisonNotFoundError();
    const evidence = await findEvidenceForEvaluation(client, lockedRun.id, input.evidenceId, input.vendorId);
    try {
      const evaluation = await rfqComparisonRepository.createEvaluationWithClient(client, {
        comparisonRunId: lockedRun.id,
        evidenceId: evidence.id,
        rfqId: lockedRun.rfqId,
        vendorId: evidence.vendorId,
        quotationRevisionId: evidence.quotationRevisionId,
        createdByUserId: actorUserId,
        commercialObservation: input.commercialObservation,
        technicalObservation: input.technicalObservation,
        complianceObservation: input.complianceObservation,
        evaluatorNote: input.evaluatorNote,
      });
      await recordOperationalEvent({
        clientId: lockedRun.clientId,
        buildingId: lockedRun.buildingId,
        eventType: 'RFQ_COMPARISON_EVALUATION_CREATED',
        entityType: 'RFQ_COMPARISON_EVALUATION',
        entityId: evaluation.id,
        actorUserId,
        summary: 'Human RFQ comparison evaluation recorded.',
        metadata: {
          comparisonRunId: lockedRun.id,
          evidenceId: evidence.id,
          quotationRevisionId: evidence.quotationRevisionId,
          vendorId: evidence.vendorId,
        },
      }, client);
      return evaluation;
    } catch (error) {
      if (uniqueConstraint(error) === 'rfq_comparison_evaluations_unique') {
        throw rfqComparisonEvaluationAlreadyExistsError();
      }
      throw error;
    }
  });
  return toPublicEvaluation(result);
}

export async function updateRfqComparisonEvaluation(
  evaluationId: string,
  input: UpdateRfqEvaluationInput,
  actorUserId: string,
): Promise<PublicRfqComparisonEvaluation> {
  const existing = await rfqComparisonRepository.findEvaluationById(evaluationId);
  if (!existing) throw rfqComparisonEvaluationNotFoundError();
  await requireRun(existing.comparisonRunId, actorUserId);
  const result = await withTransaction(async (client) => {
    const run = await rfqComparisonRepository.findRunByIdForUpdate(client, existing.comparisonRunId);
    if (!run) throw rfqComparisonNotFoundError();
    const updated = await rfqComparisonRepository.updateEvaluationWithClient(client, evaluationId, input, actorUserId);
    if (!updated) throw rfqComparisonEvaluationNotFoundError();
    await recordOperationalEvent({
      clientId: run.clientId,
      buildingId: run.buildingId,
      eventType: 'RFQ_COMPARISON_EVALUATION_UPDATED',
      entityType: 'RFQ_COMPARISON_EVALUATION',
      entityId: updated.id,
      actorUserId,
      summary: 'Human RFQ comparison evaluation updated.',
      metadata: {
        comparisonRunId: run.id,
        evidenceId: updated.evidenceId,
        quotationRevisionId: updated.quotationRevisionId,
        vendorId: updated.vendorId,
      },
    }, client);
    return updated;
  });
  return toPublicEvaluation(result);
}

export const rfqComparisonService = {
  createRfqComparison,
  createRfqComparisonEvaluation,
  getRfqComparison,
  getRfqComparisonEvaluation,
  listRfqComparisonEvaluations,
  listRfqComparisons,
  updateRfqComparisonEvaluation,
};
