import { createHash, randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '../../database';
import { assertActiveAllowedCurrency } from '../client-monetary-contexts';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { rfqRepository } from '../rfqs';
import type { RfqLineRecord, RfqRecord } from '../rfqs';
import {
  rfqVendorInvitationRepository,
  type RfqVendorSessionContext,
} from '../rfq-vendor-invitations';
import { vendorQuotationRepository } from './vendor-quotation.repository';
import {
  vendorQuotationActionNotAllowedError,
  vendorQuotationAlreadyExistsError,
  vendorQuotationAttachmentInvalidError,
  vendorQuotationAttachmentNotAllowedError,
  vendorQuotationAttachmentNotFoundError,
  vendorQuotationAttachmentNumberExistsError,
  vendorQuotationCurrencyMismatchError,
  vendorQuotationIncompleteError,
  vendorQuotationInvitationInvalidError,
  vendorQuotationLineAlreadyExistsError,
  vendorQuotationLineNotFoundError,
  vendorQuotationLineRfqMismatchError,
  vendorQuotationNotFoundError,
  vendorQuotationRevisionAlreadySubmittedError,
  vendorQuotationRevisionIdempotencyConflictError,
  vendorQuotationRevisionNotDraftError,
  vendorQuotationRevisionNotFoundError,
  vendorQuotationSessionMismatchError,
  vendorQuotationTechnicalComplianceInvalidError,
  vendorQuotationValidityInvalidError,
} from './vendor-quotation.errors';
import type {
  CreateQuotationAttachmentInput,
  CreateVendorQuotationInput,
  CreateVendorQuotationLineInput,
  CreateVendorQuotationRevisionInput,
  PublicQuotationAttachment,
  PublicVendorQuotation,
  PublicVendorQuotationLine,
  PublicVendorQuotationRevision,
  UpdateVendorQuotationLineInput,
  UpdateVendorQuotationRevisionInput,
  VendorQuotationLineRecord,
  VendorQuotationRecord,
  VendorQuotationRevisionRecord,
  VendorQuotationTechnicalCompliance,
  VendorQuotationFilters,
} from './vendor-quotation.types';

const UNIQUE_VIOLATION = '23505';
const RESPONSE_INVITATION_STATUSES = ['INVITED', 'ACCEPTED', 'QUOTATION_SUBMITTED'] as const;

type RfqLineSource = {
  id: string;
  rfqId: string;
  sourceMode: 'MATERIAL' | 'SERVICE';
  lineNumber: number;
  sourceDescription: string;
  sourceItemId: string | null;
  sourceUomId: string | null;
  /** CR-BE-SVC-01 PART 04 — governed SERVICE identity propagated to the line. */
  sourceServiceId: string | null;
  quantitySnapshot: string | number | null;
  sourceRequiredDate: Date | null;
};

type DocumentAttachmentRow = {
  supportingDocumentId: string;
  documentId: string;
  parentType: 'QUOTATION_REVISION';
  parentId: string;
  documentNumber: string;
  documentType: string;
  title: string;
  description: string | null;
  fileReference: string | null;
  status: string;
  rfqId?: string;
  vendorId?: string;
  buildingId?: string;
};

function uniqueConstraint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === UNIQUE_VIOLATION && typeof candidate.constraint === 'string'
    ? candidate.constraint
    : undefined;
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function toPublicLine(line: VendorQuotationLineRecord): PublicVendorQuotationLine {
  const { createdBySessionId: _createdBySessionId, ...safeLine } = line;
  return {
    ...safeLine,
    createdAt: line.createdAt.toISOString(),
    updatedAt: line.updatedAt.toISOString(),
  };
}

function toPublicRevision(
  revision: VendorQuotationRevisionRecord,
  lines: VendorQuotationLineRecord[],
  attachments: PublicQuotationAttachment[],
  totalAmount: number,
): PublicVendorQuotationRevision {
  return {
    id: revision.id,
    quotationId: revision.quotationId,
    rfqId: revision.rfqId,
    invitationId: revision.invitationId,
    vendorId: revision.vendorId,
    clientId: revision.clientId,
    buildingId: revision.buildingId,
    revisionNumber: revision.revisionNumber,
    status: revision.status,
    currency: revision.currency,
    validUntil: revision.validUntil,
    leadTimeDays: revision.leadTimeDays,
    deliveryTerms: revision.deliveryTerms,
    serviceTerms: revision.serviceTerms,
    notes: revision.notes,
    submittedAt: revision.submittedAt?.toISOString() ?? null,
    supersededAt: revision.supersededAt?.toISOString() ?? null,
    createdAt: revision.createdAt.toISOString(),
    updatedAt: revision.updatedAt.toISOString(),
    totalAmount,
    lines: lines.map(toPublicLine),
    attachments,
  };
}

async function attachmentRows(revisionId: string): Promise<DocumentAttachmentRow[]> {
  const result = await getPool().query<DocumentAttachmentRow>(
    `SELECT sd.id AS "supportingDocumentId", sd.document_id AS "documentId",
            sd.parent_type AS "parentType", sd.parent_id AS "parentId",
            d.document_number AS "documentNumber", d.document_type AS "documentType",
            d.title, d.description, d.file_reference AS "fileReference", d.status
       FROM supporting_documents sd
       JOIN documents d ON d.id = sd.document_id
      WHERE sd.parent_type = 'QUOTATION_REVISION' AND sd.parent_id = $1
      ORDER BY sd.created_at ASC, sd.id ASC`,
    [revisionId],
  );
  return result.rows;
}

function toPublicAttachment(row: DocumentAttachmentRow): PublicQuotationAttachment {
  return row;
}

async function publicRevision(revision: VendorQuotationRevisionRecord): Promise<PublicVendorQuotationRevision> {
  const [lines, attachments, totalAmount] = await Promise.all([
    vendorQuotationRepository.listLines(revision.id),
    attachmentRows(revision.id),
    vendorQuotationRepository.totalForRevision(revision.id),
  ]);
  return toPublicRevision(revision, lines, attachments.map(toPublicAttachment), totalAmount);
}

async function publicQuotation(quotation: VendorQuotationRecord): Promise<PublicVendorQuotation> {
  const revisions = await vendorQuotationRepository.listRevisions(quotation.id);
  const current = revisions.find((revision) => revision.status === 'DRAFT')
    ?? revisions.find((revision) => revision.status === 'SUBMITTED')
    ?? revisions[0]
    ?? null;
  return {
    id: quotation.id,
    rfqId: quotation.rfqId,
    invitationId: quotation.invitationId,
    vendorId: quotation.vendorId,
    clientId: quotation.clientId,
    buildingId: quotation.buildingId,
    quotationNumber: quotation.quotationNumber,
    status: quotation.status,
    createdAt: quotation.createdAt.toISOString(),
    updatedAt: quotation.updatedAt.toISOString(),
    currentRevision: current ? await publicRevision(current) : null,
  };
}

async function loadRfqLineForUpdate(
  client: import('pg').PoolClient,
  rfqId: string,
  rfqLineId: string,
): Promise<RfqLineSource | null> {
  const result = await client.query<RfqLineSource>(
    `SELECT id, rfq_id AS "rfqId", source_mode AS "sourceMode",
            line_number AS "lineNumber", source_description AS "sourceDescription",
            source_item_id AS "sourceItemId", source_uom_id AS "sourceUomId",
            source_service_id AS "sourceServiceId",
            quantity_snapshot AS "quantitySnapshot",
            source_required_date AS "sourceRequiredDate"
       FROM rfq_lines
      WHERE id = $1 AND rfq_id = $2
      FOR UPDATE`,
    [rfqLineId, rfqId],
  );
  return result.rows[0] ?? null;
}

async function loadRfqLinesForUpdate(
  client: import('pg').PoolClient,
  rfqId: string,
): Promise<RfqLineSource[]> {
  const result = await client.query<RfqLineSource>(
    `SELECT id, rfq_id AS "rfqId", source_mode AS "sourceMode",
            line_number AS "lineNumber", source_description AS "sourceDescription",
            source_item_id AS "sourceItemId", source_uom_id AS "sourceUomId",
            source_service_id AS "sourceServiceId",
            quantity_snapshot AS "quantitySnapshot",
            source_required_date AS "sourceRequiredDate"
       FROM rfq_lines
      WHERE rfq_id = $1
      ORDER BY line_number, id
      FOR UPDATE`,
    [rfqId],
  );
  return result.rows;
}

async function loadScopedInvitation(
  context: RfqVendorSessionContext,
): Promise<{ invitation: Awaited<ReturnType<typeof rfqVendorInvitationRepository.findById>>; rfq: RfqRecord }> {
  const invitation = await rfqVendorInvitationRepository.findById(context.invitationId);
  if (!invitation || invitation.rfqId !== context.rfqId || invitation.vendorId !== context.vendorId
    || invitation.clientId !== context.clientId || invitation.buildingId !== context.buildingId) {
    throw vendorQuotationSessionMismatchError();
  }
  const rfq = await rfqRepository.findById(context.rfqId);
  if (!rfq || rfq.clientId !== context.clientId || rfq.buildingId !== context.buildingId) {
    throw vendorQuotationSessionMismatchError();
  }
  return { invitation, rfq };
}

function assertQuotationActionable(
  invitation: NonNullable<Awaited<ReturnType<typeof rfqVendorInvitationRepository.findById>>>,
  rfq: RfqRecord,
): void {
  if (!(RESPONSE_INVITATION_STATUSES as readonly string[]).includes(invitation.status)) {
    throw vendorQuotationInvitationInvalidError();
  }
  if (rfq.status !== 'OPEN' || !rfq.responseDeadline || rfq.responseDeadline.getTime() <= Date.now()) {
    throw vendorQuotationInvitationInvalidError();
  }
}

async function assertCurrency(currency: string, rfq: RfqRecord): Promise<void> {
  if (currency !== rfq.currency) throw vendorQuotationCurrencyMismatchError();
  await assertActiveAllowedCurrency(rfq.clientId, currency);
}

function assertTerms(
  sourceMode: RfqRecord['sourceMode'],
  deliveryTerms: string | null | undefined,
  serviceTerms: string | null | undefined,
): void {
  if (sourceMode === 'MATERIAL' && serviceTerms) throw vendorQuotationIncompleteError();
  if (sourceMode === 'SERVICE' && deliveryTerms) throw vendorQuotationIncompleteError();
}

async function assertRevisionValidity(
  revision: VendorQuotationRevisionRecord,
  rfq: RfqRecord,
): Promise<void> {
  await assertCurrency(revision.currency, rfq);
  assertTerms(rfq.sourceMode, revision.deliveryTerms, revision.serviceTerms);
  if (!revision.validUntil || revision.validUntil < new Date().toISOString().slice(0, 10)) {
    throw vendorQuotationValidityInvalidError();
  }
}

function resolveLineInput(
  source: RfqLineSource,
  input: CreateVendorQuotationLineInput,
): {
  sourceMode: 'MATERIAL' | 'SERVICE';
  lineNumberSnapshot: number;
  description: string | null;
  requiredQuantitySnapshot: number | null;
  requiredUomId: string | null;
  sourceServiceId: string | null;
  quotedQuantity: number | null;
  unitPrice: number;
  technicalCompliance: VendorQuotationTechnicalCompliance;
  deviationNotes: string | null;
} {
  const requiredQuantity = source.quantitySnapshot === null ? null : Number(source.quantitySnapshot);
  const quotedQuantity = source.sourceMode === 'MATERIAL'
    ? (input.quotedQuantity === undefined || input.quotedQuantity === null
      ? requiredQuantity
      : input.quotedQuantity)
    : null;
  return {
    sourceMode: source.sourceMode,
    lineNumberSnapshot: source.lineNumber,
    description: input.description ?? null,
    requiredQuantitySnapshot: requiredQuantity,
    requiredUomId: source.sourceUomId,
    // CR-BE-SVC-01 PART 04 — governed SERVICE identity propagated from the RFQ
    // line and frozen on the quotation line. The Vendor cannot set it.
    sourceServiceId: source.sourceServiceId,
    quotedQuantity,
    unitPrice: input.unitPrice,
    technicalCompliance: input.technicalCompliance ?? 'NOT_STATED',
    deviationNotes: input.deviationNotes ?? null,
  };
}

function assertSubmittedLine(
  line: VendorQuotationLineRecord,
  source: RfqLineSource,
): void {
  if (line.sourceMode !== source.sourceMode || line.lineNumberSnapshot !== source.lineNumber) {
    throw vendorQuotationLineRfqMismatchError();
  }
  if (line.sourceMode === 'MATERIAL') {
    if (line.quotedQuantity === null || line.quotedQuantity !== Number(source.quantitySnapshot)) {
      throw vendorQuotationIncompleteError();
    }
  }
  if (line.technicalCompliance === 'NOT_STATED') {
    throw vendorQuotationTechnicalComplianceInvalidError();
  }
  if (line.technicalCompliance === 'NON_COMPLIANT' && !line.deviationNotes) {
    throw vendorQuotationTechnicalComplianceInvalidError();
  }
}

function createRevisionFingerprint(input: CreateVendorQuotationInput | CreateVendorQuotationRevisionInput): string {
  return hashPayload({
    currency: input.currency,
    validUntil: input.validUntil ?? null,
    leadTimeDays: input.leadTimeDays ?? null,
    deliveryTerms: input.deliveryTerms ?? null,
    serviceTerms: input.serviceTerms ?? null,
    notes: input.notes ?? null,
    lines: input.lines,
  });
}

export async function createVendorQuotation(
  context: RfqVendorSessionContext,
  input: CreateVendorQuotationInput,
): Promise<PublicVendorQuotation> {
  const { invitation, rfq } = await loadScopedInvitation(context);
  if (input.invitationId !== context.invitationId) throw vendorQuotationSessionMismatchError();
  if (!invitation) throw vendorQuotationInvitationInvalidError();
  assertQuotationActionable(invitation, rfq);
  await assertCurrency(input.currency, rfq);
  assertTerms(rfq.sourceMode, input.deliveryTerms, input.serviceTerms);

  const result = await withTransaction(async (client) => {
    const lockedInvitation = await rfqVendorInvitationRepository.findByIdForUpdate(client, invitation.id);
    const lockedRfq = await rfqRepository.findByIdForUpdate(client, rfq.id);
    if (!lockedInvitation || !lockedRfq) throw vendorQuotationInvitationInvalidError();
    assertQuotationActionable(lockedInvitation, lockedRfq);

    const replay = await vendorQuotationRepository.findQuotationByIdempotencyForUpdate(
      client, lockedInvitation.id, input.idempotencyKey,
    );
    const expectedFingerprint = createRevisionFingerprint(input);
    if (replay) {
      if (replay.idempotencyFingerprint !== expectedFingerprint) throw vendorQuotationRevisionIdempotencyConflictError();
      return replay;
    }
    if (await vendorQuotationRepository.findQuotationByInvitationForUpdate(client, lockedInvitation.id)) {
      throw vendorQuotationAlreadyExistsError();
    }

    const quotationNumber = input.quotationNumber?.trim() || `VQ-${randomUUID().slice(0, 12).toUpperCase()}`;
    const quotation = await vendorQuotationRepository.createQuotationIdempotent(client, {
      rfqId: lockedRfq.id,
      invitationId: lockedInvitation.id,
      vendorId: lockedInvitation.vendorId,
      clientId: lockedInvitation.clientId,
      buildingId: lockedInvitation.buildingId,
      quotationNumber,
      createdBySessionId: context.sessionId,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: expectedFingerprint,
    });
    if (!quotation.created) return quotation.record;

    const revision = await vendorQuotationRepository.createRevisionWithClient(client, {
      quotationId: quotation.record.id,
      rfqId: lockedRfq.id,
      invitationId: lockedInvitation.id,
      vendorId: lockedInvitation.vendorId,
      clientId: lockedInvitation.clientId,
      buildingId: lockedInvitation.buildingId,
      revisionNumber: 1,
      currency: input.currency,
      validUntil: input.validUntil ?? null,
      leadTimeDays: input.leadTimeDays ?? null,
      deliveryTerms: input.deliveryTerms ?? null,
      serviceTerms: input.serviceTerms ?? null,
      notes: input.notes ?? null,
      createdBySessionId: context.sessionId,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: expectedFingerprint,
    });
    const sourceLines = await loadRfqLinesForUpdate(client, lockedRfq.id);
    const seen = new Set<string>();
    for (const lineInput of input.lines) {
      if (seen.has(lineInput.rfqLineId)) throw vendorQuotationLineAlreadyExistsError();
      seen.add(lineInput.rfqLineId);
      const source = sourceLines.find((line) => line.id === lineInput.rfqLineId);
      if (!source) throw vendorQuotationLineRfqMismatchError();
      const resolved = resolveLineInput(source, lineInput);
      const createdLine = await vendorQuotationRepository.createLineWithClient(client, {
        quotationRevisionId: revision.id, quotationId: quotation.record.id, rfqId: lockedRfq.id,
        rfqLineId: source.id, ...resolved, createdBySessionId: context.sessionId,
      });
      await recordOperationalEvent({
        clientId: lockedRfq.clientId, buildingId: lockedRfq.buildingId,
        eventType: 'VENDOR_QUOTATION_LINE_ADDED', entityType: 'VENDOR_QUOTATION_LINE', entityId: createdLine.id,
        actorUserId: null, summary: 'Vendor quotation draft line added.',
        metadata: { quotationId: quotation.record.id, revisionId: revision.id, rfqId: lockedRfq.id, vendorId: lockedInvitation.vendorId, rfqLineId: source.id, actorType: 'VENDOR_RFQ_SESSION' },
      }, client);
    }
    await vendorQuotationRepository.updateQuotationStatusWithClient(client, quotation.record.id, 'DRAFT');
    await recordOperationalEvent({
      clientId: lockedRfq.clientId, buildingId: lockedRfq.buildingId,
      eventType: 'VENDOR_QUOTATION_CREATED', entityType: 'VENDOR_QUOTATION', entityId: quotation.record.id,
      actorUserId: null, summary: `Vendor quotation created for RFQ ${lockedRfq.rfqNumber}.`,
      metadata: { rfqId: lockedRfq.id, vendorId: lockedInvitation.vendorId, invitationId: lockedInvitation.id, revisionId: revision.id, actorType: 'VENDOR_RFQ_SESSION' },
    }, client);
    return quotation.record;
  });
  return publicQuotation(result);
}

export async function getVendorQuotation(
  context: RfqVendorSessionContext,
  quotationId: string,
): Promise<PublicVendorQuotation> {
  const quotation = await vendorQuotationRepository.findQuotationById(quotationId);
  if (!quotation) throw vendorQuotationNotFoundError();
  if (quotation.invitationId !== context.invitationId || quotation.rfqId !== context.rfqId || quotation.vendorId !== context.vendorId || quotation.clientId !== context.clientId || quotation.buildingId !== context.buildingId) throw vendorQuotationSessionMismatchError();
  return publicQuotation(quotation);
}

export async function getVendorCurrentQuotation(context: RfqVendorSessionContext): Promise<PublicVendorQuotation | null> {
  const quotation = await vendorQuotationRepository.findQuotationByInvitation(context.invitationId);
  if (!quotation) return null;
  return getVendorQuotation(context, quotation.id);
}

export async function createVendorQuotationRevision(
  context: RfqVendorSessionContext,
  input: CreateVendorQuotationRevisionInput,
): Promise<PublicVendorQuotationRevision> {
  const { invitation, rfq } = await loadScopedInvitation(context);
  if (!invitation) throw vendorQuotationInvitationInvalidError();
  assertQuotationActionable(invitation, rfq);
  await assertCurrency(input.currency, rfq);
  assertTerms(rfq.sourceMode, input.deliveryTerms, input.serviceTerms);
  const result = await withTransaction(async (client) => {
    const quotation = await vendorQuotationRepository.findQuotationByIdForUpdate(client, input.quotationId);
    if (!quotation || quotation.invitationId !== context.invitationId || quotation.vendorId !== context.vendorId) throw vendorQuotationSessionMismatchError();
    const existingKey = await vendorQuotationRepository.findRevisionByIdempotencyForUpdate(client, quotation.id, input.idempotencyKey);
    const expectedFingerprint = createRevisionFingerprint(input);
    if (existingKey) {
      if (existingKey.idempotencyFingerprint !== expectedFingerprint) throw vendorQuotationRevisionIdempotencyConflictError();
      return existingKey;
    }
    if (await vendorQuotationRepository.findDraftRevisionForUpdate(client, quotation.id)) throw vendorQuotationRevisionNotDraftError();
    const revision = await vendorQuotationRepository.createRevisionWithClient(client, {
      quotationId: quotation.id, rfqId: quotation.rfqId, invitationId: quotation.invitationId,
      vendorId: quotation.vendorId, clientId: quotation.clientId, buildingId: quotation.buildingId,
      revisionNumber: await vendorQuotationRepository.nextRevisionNumber(client, quotation.id),
      currency: input.currency, validUntil: input.validUntil ?? null, leadTimeDays: input.leadTimeDays ?? null,
      deliveryTerms: input.deliveryTerms ?? null, serviceTerms: input.serviceTerms ?? null, notes: input.notes ?? null,
      createdBySessionId: context.sessionId, idempotencyKey: input.idempotencyKey, idempotencyFingerprint: expectedFingerprint,
    });
    const sourceLines = await loadRfqLinesForUpdate(client, quotation.rfqId);
    const seen = new Set<string>();
    for (const lineInput of input.lines) {
      if (seen.has(lineInput.rfqLineId)) throw vendorQuotationLineAlreadyExistsError();
      seen.add(lineInput.rfqLineId);
      const source = sourceLines.find((line) => line.id === lineInput.rfqLineId);
      if (!source) throw vendorQuotationLineRfqMismatchError();
      const createdLine = await vendorQuotationRepository.createLineWithClient(client, {
        quotationRevisionId: revision.id, quotationId: quotation.id, rfqId: quotation.rfqId,
        rfqLineId: source.id, ...resolveLineInput(source, lineInput), createdBySessionId: context.sessionId,
      });
      await recordOperationalEvent({
        clientId: quotation.clientId, buildingId: quotation.buildingId,
        eventType: 'VENDOR_QUOTATION_LINE_ADDED', entityType: 'VENDOR_QUOTATION_LINE', entityId: createdLine.id,
        actorUserId: null, summary: 'Vendor quotation revision line added.',
        metadata: { quotationId: quotation.id, revisionId: revision.id, rfqId: quotation.rfqId, vendorId: quotation.vendorId, rfqLineId: source.id, actorType: 'VENDOR_RFQ_SESSION' },
      }, client);
    }
    await vendorQuotationRepository.updateQuotationStatusWithClient(client, quotation.id, 'DRAFT');
    await recordOperationalEvent({
      clientId: quotation.clientId, buildingId: quotation.buildingId, eventType: 'VENDOR_QUOTATION_REVISION_CREATED',
      entityType: 'VENDOR_QUOTATION_REVISION', entityId: revision.id, actorUserId: null,
      summary: 'Vendor quotation revision created.', metadata: { quotationId: quotation.id, rfqId: quotation.rfqId, vendorId: quotation.vendorId, revisionNumber: revision.revisionNumber, actorType: 'VENDOR_RFQ_SESSION' },
    }, client);
    return revision;
  });
  return publicRevision(result);
}

async function loadScopedRevision(context: RfqVendorSessionContext, revisionId: string, client?: import('pg').PoolClient): Promise<{ quotation: VendorQuotationRecord; revision: VendorQuotationRevisionRecord }> {
  const revision = client ? await vendorQuotationRepository.findRevisionByIdForUpdate(client, revisionId) : await vendorQuotationRepository.findRevisionById(revisionId);
  if (!revision) throw vendorQuotationRevisionNotFoundError();
  const quotation = client ? await vendorQuotationRepository.findQuotationByIdForUpdate(client, revision.quotationId) : await vendorQuotationRepository.findQuotationById(revision.quotationId);
  if (!quotation || quotation.invitationId !== context.invitationId || quotation.rfqId !== context.rfqId || quotation.vendorId !== context.vendorId || quotation.clientId !== context.clientId || quotation.buildingId !== context.buildingId) throw vendorQuotationSessionMismatchError();
  return { quotation, revision };
}

export async function updateVendorQuotationRevision(context: RfqVendorSessionContext, revisionId: string, input: UpdateVendorQuotationRevisionInput): Promise<PublicVendorQuotationRevision> {
  const { rfq } = await loadScopedInvitation(context);
  assertQuotationActionable((await rfqVendorInvitationRepository.findById(context.invitationId))!, rfq);
  const result = await withTransaction(async (client) => {
    const scoped = await loadScopedRevision(context, revisionId, client);
    if (scoped.revision.status !== 'DRAFT') throw vendorQuotationRevisionNotDraftError();
    const merged = { ...scoped.revision, ...input } as VendorQuotationRevisionRecord;
    await assertCurrency(merged.currency, rfq);
    assertTerms(rfq.sourceMode, merged.deliveryTerms, merged.serviceTerms);
    const updated = await vendorQuotationRepository.updateRevisionWithClient(client, revisionId, input);
    if (!updated) throw vendorQuotationRevisionNotDraftError();
    await recordOperationalEvent({ clientId: updated.clientId, buildingId: updated.buildingId, eventType: 'VENDOR_QUOTATION_REVISION_UPDATED', entityType: 'VENDOR_QUOTATION_REVISION', entityId: updated.id, actorUserId: null, summary: 'Vendor quotation draft revision updated.', metadata: { quotationId: updated.quotationId, rfqId: updated.rfqId, vendorId: updated.vendorId, actorType: 'VENDOR_RFQ_SESSION' } }, client);
    return updated;
  });
  return publicRevision(result);
}

export async function addVendorQuotationLine(context: RfqVendorSessionContext, revisionId: string, input: CreateVendorQuotationLineInput): Promise<PublicVendorQuotationLine> {
  const result = await withTransaction(async (client) => {
    const scoped = await loadScopedRevision(context, revisionId, client);
    if (scoped.revision.status !== 'DRAFT') throw vendorQuotationRevisionNotDraftError();
    const source = await loadRfqLineForUpdate(client, scoped.revision.rfqId, input.rfqLineId);
    if (!source) throw vendorQuotationLineRfqMismatchError();
    const existing = (await vendorQuotationRepository.listLinesWithClient(client, revisionId)).find((line) => line.rfqLineId === input.rfqLineId);
    if (existing) throw vendorQuotationLineAlreadyExistsError();
    const created = await vendorQuotationRepository.createLineWithClient(client, {
      quotationRevisionId: revisionId, quotationId: scoped.quotation.id, rfqId: scoped.quotation.rfqId,
      rfqLineId: source.id, ...resolveLineInput(source, input), createdBySessionId: context.sessionId,
    });
    await recordOperationalEvent({
      clientId: scoped.quotation.clientId, buildingId: scoped.quotation.buildingId,
      eventType: 'VENDOR_QUOTATION_LINE_ADDED', entityType: 'VENDOR_QUOTATION_LINE', entityId: created.id,
      actorUserId: null, summary: 'Vendor quotation draft line added.',
      metadata: { quotationId: scoped.quotation.id, revisionId, rfqId: scoped.quotation.rfqId, vendorId: scoped.quotation.vendorId, rfqLineId: source.id, actorType: 'VENDOR_RFQ_SESSION' },
    }, client);
    return created;
  });
  return toPublicLine(result);
}

export async function updateVendorQuotationLine(context: RfqVendorSessionContext, lineId: string, input: UpdateVendorQuotationLineInput): Promise<PublicVendorQuotationLine> {
  const result = await withTransaction(async (client) => {
    const line = await vendorQuotationRepository.findLineByIdForUpdate(client, lineId);
    if (!line) throw vendorQuotationLineNotFoundError();
    const scoped = await loadScopedRevision(context, line.quotationRevisionId, client);
    if (scoped.revision.status !== 'DRAFT') throw vendorQuotationRevisionNotDraftError();
    const source = await loadRfqLineForUpdate(client, line.rfqId, line.rfqLineId);
    if (!source) throw vendorQuotationLineRfqMismatchError();
    const merged = { ...line, ...input } as VendorQuotationLineRecord;
    if (source.sourceMode === 'MATERIAL' && (merged.quotedQuantity === null || merged.quotedQuantity === undefined)) {
      throw vendorQuotationIncompleteError();
    }
    if (source.sourceMode === 'SERVICE' && merged.quotedQuantity !== null && merged.quotedQuantity !== undefined) {
      throw vendorQuotationLineRfqMismatchError();
    }
    const updated = await vendorQuotationRepository.updateLineWithClient(client, lineId, input);
    if (!updated) throw vendorQuotationLineNotFoundError();
    await recordOperationalEvent({
      clientId: scoped.quotation.clientId, buildingId: scoped.quotation.buildingId,
      eventType: 'VENDOR_QUOTATION_LINE_UPDATED', entityType: 'VENDOR_QUOTATION_LINE', entityId: updated.id,
      actorUserId: null, summary: 'Vendor quotation draft line updated.',
      metadata: { quotationId: updated.quotationId, revisionId: updated.quotationRevisionId, rfqId: updated.rfqId, vendorId: scoped.quotation.vendorId, rfqLineId: updated.rfqLineId, actorType: 'VENDOR_RFQ_SESSION' },
    }, client);
    return updated;
  });
  return toPublicLine(result);
}

export async function submitVendorQuotationRevision(context: RfqVendorSessionContext, revisionId: string): Promise<PublicVendorQuotationRevision> {
  const result = await withTransaction(async (client) => {
    const scoped = await loadScopedRevision(context, revisionId, client);
    if (scoped.revision.status !== 'DRAFT') throw vendorQuotationRevisionAlreadySubmittedError();
    const rfq = await rfqRepository.findByIdForUpdate(client, scoped.quotation.rfqId);
    const invitation = await rfqVendorInvitationRepository.findByIdForUpdate(client, scoped.quotation.invitationId);
    if (!rfq || !invitation) throw vendorQuotationInvitationInvalidError();
    assertQuotationActionable(invitation, rfq);
    await assertRevisionValidity(scoped.revision, rfq);
    const sources = await loadRfqLinesForUpdate(client, rfq.id);
    const lines = await vendorQuotationRepository.listLinesWithClient(client, revisionId);
    if (lines.length !== sources.length) throw vendorQuotationIncompleteError();
    const byRfqLine = new Map(lines.map((line) => [line.rfqLineId, line]));
    for (const source of sources) {
      const line = byRfqLine.get(source.id);
      if (!line) throw vendorQuotationIncompleteError();
      assertSubmittedLine(line, source);
    }
    const submitted = await vendorQuotationRepository.submitRevisionWithClient(client, revisionId, scoped.quotation.id, context.sessionId);
    if (!submitted) throw vendorQuotationRevisionNotDraftError();
    await vendorQuotationRepository.updateQuotationStatusWithClient(client, scoped.quotation.id, 'SUBMITTED');
    await rfqVendorInvitationRepository.markQuotationSubmittedWithClient(client, invitation.id);
    await recordOperationalEvent({ clientId: submitted.clientId, buildingId: submitted.buildingId, eventType: 'VENDOR_QUOTATION_SUBMITTED', entityType: 'VENDOR_QUOTATION_REVISION', entityId: submitted.id, actorUserId: null, summary: 'Vendor quotation revision submitted and frozen.', metadata: { quotationId: submitted.quotationId, rfqId: submitted.rfqId, vendorId: submitted.vendorId, revisionNumber: submitted.revisionNumber, actorType: 'VENDOR_RFQ_SESSION' } }, client);
    return submitted;
  });
  return publicRevision(result);
}

export async function listVendorQuotationRevisions(context: RfqVendorSessionContext, quotationId: string): Promise<PublicVendorQuotationRevision[]> {
  const quotation = await vendorQuotationRepository.findQuotationById(quotationId);
  if (!quotation || quotation.invitationId !== context.invitationId || quotation.rfqId !== context.rfqId || quotation.vendorId !== context.vendorId || quotation.clientId !== context.clientId || quotation.buildingId !== context.buildingId) throw vendorQuotationSessionMismatchError();
  const revisions = await vendorQuotationRepository.listRevisions(quotationId);
  return Promise.all(revisions.map(publicRevision));
}

export async function listRfqQuotations(rfqId: string, filters: VendorQuotationFilters, actorUserId: string): Promise<PublicVendorQuotation[]> {
  const rfq = await rfqRepository.findById(rfqId);
  if (!rfq) throw vendorQuotationNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, rfq.buildingId);
  const quotations = await vendorQuotationRepository.listQuotationsByRfq(rfqId, filters);
  return Promise.all(quotations.map(publicQuotation));
}

export async function listInternalQuotationRevisions(quotationId: string, actorUserId: string): Promise<PublicVendorQuotationRevision[]> {
  const quotation = await vendorQuotationRepository.findQuotationById(quotationId);
  if (!quotation) throw vendorQuotationNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, quotation.buildingId);
  return Promise.all((await vendorQuotationRepository.listRevisions(quotationId)).map(publicRevision));
}

export async function listInternalQuotationAttachments(revisionId: string, actorUserId: string): Promise<PublicQuotationAttachment[]> {
  const revision = await vendorQuotationRepository.findRevisionById(revisionId);
  if (!revision) throw vendorQuotationRevisionNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, revision.buildingId);
  return (await attachmentRows(revisionId)).map(toPublicAttachment);
}

export async function getInternalQuotation(quotationId: string, actorUserId: string): Promise<PublicVendorQuotation> {
  const quotation = await vendorQuotationRepository.findQuotationById(quotationId);
  if (!quotation) throw vendorQuotationNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, quotation.buildingId);
  return publicQuotation(quotation);
}

async function createAttachment(
  input: CreateQuotationAttachmentInput,
  actorUserId: string,
  externalContext: RfqVendorSessionContext | null,
): Promise<PublicQuotationAttachment> {
  const revision = await vendorQuotationRepository.findRevisionById(input.quotationRevisionId);
  if (!revision) throw vendorQuotationRevisionNotFoundError();
  const quotation = await vendorQuotationRepository.findQuotationById(revision.quotationId);
  if (!quotation) throw vendorQuotationNotFoundError();
  const invitation = await rfqVendorInvitationRepository.findById(quotation.invitationId);
  if (!invitation) throw vendorQuotationInvitationInvalidError();
  if (externalContext) {
    if (quotation.invitationId !== externalContext.invitationId || quotation.vendorId !== externalContext.vendorId || quotation.rfqId !== externalContext.rfqId) throw vendorQuotationSessionMismatchError();
  } else {
    await contextAccessService.assertBuildingAccess(actorUserId, quotation.buildingId);
  }
  if (revision.status !== 'DRAFT') throw vendorQuotationAttachmentNotAllowedError();

  const documentActor = externalContext ? invitation.createdByUserId : actorUserId;
  return withTransaction(async (client) => {
    const locked = await vendorQuotationRepository.findRevisionByIdForUpdate(client, revision.id);
    if (!locked || locked.status !== 'DRAFT') throw vendorQuotationAttachmentNotAllowedError();
    const existing = await client.query<{ id: string }>('SELECT id FROM documents WHERE client_id=$1 AND document_number=$2', [locked.clientId, input.documentNumber]);
    if (existing.rows[0]) throw vendorQuotationAttachmentNumberExistsError();
    const documentId = randomUUID();
    try {
      await client.query(
        `INSERT INTO documents
           (id, client_id, building_id, document_number, document_type,
            context_type, source_type, source_id, title, description,
            file_reference, status, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,'VENDOR','VENDOR',$6,$7,$8,$9,'DRAFT',$10)`,
        [documentId, locked.clientId, locked.buildingId, input.documentNumber, input.documentType,
          locked.vendorId, input.title, input.description ?? null, input.fileReference, documentActor],
      );
      await client.query(
        `INSERT INTO document_versions
           (id, document_id, version_number, title, description, file_reference,
            document_type, status, created_by_user_id)
         VALUES ($1,$2,1,$3,$4,$5,$6,'DRAFT',$7)`,
        [randomUUID(), documentId, input.title, input.description ?? null, input.fileReference, input.documentType, documentActor],
      );
      const supportingId = randomUUID();
      await client.query(
        `INSERT INTO supporting_documents
           (id, document_id, parent_type, parent_id, client_id, building_id,
            context_type, created_by_user_id)
         VALUES ($1,$2,'QUOTATION_REVISION',$3,$4,$5,'VENDOR',$6)`,
        [supportingId, documentId, locked.id, locked.clientId, locked.buildingId, documentActor],
      );
      await recordOperationalEvent({
        clientId: locked.clientId,
        buildingId: locked.buildingId,
        eventType: 'VENDOR_QUOTATION_ATTACHMENT_ADDED',
        entityType: 'QUOTATION_REVISION',
        entityId: locked.id,
        actorUserId: externalContext ? null : actorUserId,
        summary: 'Quotation attachment linked through shared Documents authority.',
        metadata: {
          quotationId: locked.quotationId,
          quotationRevisionId: locked.id,
          vendorId: locked.vendorId,
          supportingDocumentId: supportingId,
          documentId,
          ...(externalContext ? { actorType: 'VENDOR_RFQ_SESSION', sessionId: externalContext.sessionId, invitationId: externalContext.invitationId } : {}),
        },
      }, client);
      const rows = await client.query<DocumentAttachmentRow>(
        `SELECT sd.id AS "supportingDocumentId", sd.document_id AS "documentId",
                sd.parent_type AS "parentType", sd.parent_id AS "parentId",
                d.document_number AS "documentNumber", d.document_type AS "documentType",
                d.title, d.description, d.file_reference AS "fileReference", d.status
           FROM supporting_documents sd JOIN documents d ON d.id=sd.document_id
          WHERE sd.id=$1`, [supportingId],
      );
      return toPublicAttachment(rows.rows[0]);
    } catch (error) {
      if (uniqueConstraint(error) === 'documents_client_number_unique') throw vendorQuotationAttachmentNumberExistsError();
      throw error;
    }
  });
}

export function addVendorQuotationAttachment(context: RfqVendorSessionContext, input: CreateQuotationAttachmentInput): Promise<PublicQuotationAttachment> {
  return createAttachment(input, '', context);
}
export function addInternalQuotationAttachment(revisionId: string, input: Omit<CreateQuotationAttachmentInput, 'quotationRevisionId'>, actorUserId: string): Promise<PublicQuotationAttachment> {
  return createAttachment({ ...input, quotationRevisionId: revisionId }, actorUserId, null);
}
export async function listQuotationAttachments(revisionId: string): Promise<PublicQuotationAttachment[]> {
  return (await attachmentRows(revisionId)).map(toPublicAttachment);
}

export async function listVendorQuotationAttachments(
  context: RfqVendorSessionContext,
  revisionId: string,
): Promise<PublicQuotationAttachment[]> {
  await loadScopedRevision(context, revisionId);
  return (await attachmentRows(revisionId)).map(toPublicAttachment);
}

export async function getQuotationAttachment(attachmentId: string, context: RfqVendorSessionContext | null, actorUserId?: string): Promise<PublicQuotationAttachment> {
  const result = await getPool().query<DocumentAttachmentRow>(
    `SELECT sd.id AS "supportingDocumentId", sd.document_id AS "documentId",
            sd.parent_type AS "parentType", sd.parent_id AS "parentId",
            d.document_number AS "documentNumber", d.document_type AS "documentType",
            d.title, d.description, d.file_reference AS "fileReference", d.status,
            r.rfq_id AS "rfqId", r.vendor_id AS "vendorId", r.building_id AS "buildingId"
       FROM supporting_documents sd
       JOIN documents d ON d.id=sd.document_id
       JOIN vendor_quotation_revisions r ON r.id=sd.parent_id
      WHERE sd.id=$1 AND sd.parent_type='QUOTATION_REVISION'`, [attachmentId],
  );
  const row = result.rows[0];
  if (!row) throw vendorQuotationAttachmentNotFoundError();
  if (context) {
    if (row.rfqId !== context.rfqId || row.vendorId !== context.vendorId) throw vendorQuotationAttachmentNotFoundError();
  } else if (actorUserId) {
    if (!row.buildingId) throw vendorQuotationAttachmentInvalidError();
    await contextAccessService.assertBuildingAccess(actorUserId, row.buildingId);
  }
  return toPublicAttachment(row);
}

export const vendorQuotationService = {
  addInternalQuotationAttachment,
  addVendorQuotationAttachment,
  addVendorQuotationLine,
  createVendorQuotation,
  createVendorQuotationRevision,
  getInternalQuotation,
  getQuotationAttachment,
  getVendorCurrentQuotation,
  getVendorQuotation,
  listQuotationAttachments,
  listInternalQuotationAttachments,
  listInternalQuotationRevisions,
  listVendorQuotationAttachments,
  listRfqQuotations,
  listVendorQuotationRevisions,
  submitVendorQuotationRevision,
  updateVendorQuotationLine,
  updateVendorQuotationRevision,
};
