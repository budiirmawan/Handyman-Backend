import { createHash } from 'node:crypto';
import { withTransaction } from '../../database';
import { assertActiveAllowedCurrency } from '../client-monetary-contexts';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { rfqRepository } from './rfq.repository';
import {
  rfqContextMismatchError,
  rfqDeadlineInvalidError,
  rfqDeadlineRequiredError,
  rfqIdempotencyConflictError,
  rfqInvalidTransitionError,
  rfqLineAlreadyExistsError,
  rfqLineNotApprovedError,
  rfqLineNotFoundError,
  rfqLineSourceInvalidError,
  rfqLineSourceModeMismatchError,
  rfqNoLinesError,
  rfqNotDraftError,
  rfqNotFoundError,
  rfqNotOpenError,
  rfqNumberAlreadyExistsError,
  rfqPurchaseRequestInvalidError,
  rfqPurchaseRequestNotFoundError,
  rfqSourceChangedError,
} from './rfq.errors';
import type {
  CreateRfqInput,
  CreateRfqLineInput,
  NewRfq,
  NewRfqLine,
  PublicRfq,
  PublicRfqLine,
  RfqAction,
  RfqAvailableActions,
  RfqLineRecord,
  RfqRecord,
  RfqSourceMode,
  RfqStatus,
  RfqFilters,
  UpdateRfqInput,
} from './rfq.types';

const UNIQUE_VIOLATION = '23505';

type PurchaseRequestSource = {
  id: string;
  clientId: string;
  buildingId: string;
  requestNumber: string;
  title: string;
  requiredDate: Date | null;
  status: string;
  clientStatus: string;
  buildingStatus: string;
};

type MaterialSource = {
  id: string;
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  itemId: string;
  itemName: string;
  quantity: string;
  approvedQuantity: string | null;
  uomId: string | null;
  requiredDate: Date | null;
  status: string;
};

type ServiceSource = {
  id: string;
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  title: string;
  requiredDate: Date | null;
  status: string;
  /** CR-BE-SVC-01 PART 04 — governed identity propagated to the RFQ line. */
  serviceCatalogId: string | null;
};

function toPublic(record: RfqRecord): PublicRfq {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    purchaseRequestId: record.purchaseRequestId,
    sourceMode: record.sourceMode,
    rfqNumber: record.rfqNumber,
    title: record.title,
    description: record.description,
    currency: record.currency,
    requiredDate: record.requiredDate?.toISOString() ?? null,
    responseDeadline: record.responseDeadline?.toISOString() ?? null,
    sourceRequestNumber: record.sourceRequestNumber,
    sourceRequestTitle: record.sourceRequestTitle,
    sourceRequestStatus: record.sourceRequestStatus,
    status: record.status,
    openedAt: record.openedAt?.toISOString() ?? null,
    openedByUserId: record.openedByUserId,
    closedAt: record.closedAt?.toISOString() ?? null,
    closedByUserId: record.closedByUserId,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    cancelledByUserId: record.cancelledByUserId,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicLine(record: RfqLineRecord): PublicRfqLine {
  const { sourceClaimStatus: _sourceClaimStatus, ...publicRecord } = record;
  return {
    ...publicRecord,
    sourceRequiredDate: record.sourceRequiredDate?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function uniqueConstraint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === UNIQUE_VIOLATION && typeof candidate.constraint === 'string'
    ? candidate.constraint
    : undefined;
}

function fingerprint(input: CreateRfqInput): string {
  const canonical = JSON.stringify({
    purchaseRequestId: input.purchaseRequestId,
    sourceMode: input.sourceMode,
    rfqNumber: input.rfqNumber,
    title: input.title,
    description: input.description ?? null,
    currency: input.currency,
    requiredDate: input.requiredDate ?? null,
    responseDeadline: input.responseDeadline ?? null,
    clientId: input.clientId ?? null,
    buildingId: input.buildingId ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

async function loadPurchaseRequestForUpdate(
  client: import('pg').PoolClient,
  id: string,
): Promise<PurchaseRequestSource | null> {
  const result = await client.query<PurchaseRequestSource>(
    `SELECT
       pr.id,
       pr.client_id AS "clientId",
       pr.building_id AS "buildingId",
       pr.request_number AS "requestNumber",
       pr.title,
       pr.required_date AS "requiredDate",
       pr.status,
       c.status AS "clientStatus",
       b.status AS "buildingStatus"
     FROM purchase_requests pr
     JOIN clients c ON c.id = pr.client_id
     JOIN buildings b ON b.id = pr.building_id
     WHERE pr.id = $1
     FOR UPDATE OF pr`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function loadMaterialSource(
  client: import('pg').PoolClient,
  id: string,
): Promise<MaterialSource | null> {
  const result = await client.query<MaterialSource>(
    `SELECT
       mr.id,
       mr.client_id AS "clientId",
       mr.building_id AS "buildingId",
       mr.purchase_request_id AS "purchaseRequestId",
       mr.item_id AS "itemId",
       i.name AS "itemName",
       mr.quantity::text AS quantity,
       mr.approved_quantity::text AS "approvedQuantity",
       mr.uom_id AS "uomId",
       mr.required_date AS "requiredDate",
       mr.status
     FROM material_requests mr
     JOIN inventory_items i ON i.id = mr.item_id
     WHERE mr.id = $1
     FOR UPDATE OF mr`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function loadServiceSource(
  client: import('pg').PoolClient,
  id: string,
): Promise<ServiceSource | null> {
  const result = await client.query<ServiceSource>(
    `SELECT
       sr.id,
       sr.client_id AS "clientId",
       sr.building_id AS "buildingId",
       sr.purchase_request_id AS "purchaseRequestId",
       sr.title,
       sr.required_date AS "requiredDate",
       sr.status,
       sr.service_catalog_id AS "serviceCatalogId"
     FROM service_requests sr
     WHERE sr.id = $1
     FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

function isSameDate(left: Date | null, right: Date | null): boolean {
  return (left?.getTime() ?? null) === (right?.getTime() ?? null);
}

async function loadAccessible(
  id: string,
  actorUserId: string,
): Promise<RfqRecord> {
  const record = await rfqRepository.findById(id);
  if (!record) throw rfqNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return record;
}

function assertCreateContext(
  source: PurchaseRequestSource,
  input: CreateRfqInput,
): void {
  if (source.status !== 'OPEN' || source.clientStatus !== 'ACTIVE' || source.buildingStatus !== 'ACTIVE') {
    throw rfqPurchaseRequestInvalidError();
  }
  if (
    (input.clientId !== undefined && input.clientId !== source.clientId) ||
    (input.buildingId !== undefined && input.buildingId !== source.buildingId)
  ) {
    throw rfqContextMismatchError();
  }
}

/** Creates an idempotent DRAFT RFQ. No line or financial record is created. */
export async function createRfq(
  input: CreateRfqInput,
  actorUserId: string,
): Promise<PublicRfq> {
  return withTransaction(async (client) => {
    // The Purchase Request gives us the Client/Building needed to resolve an
    // idempotency replay before accepting a new source snapshot.
    const initialSource = await loadPurchaseRequestForUpdate(client, input.purchaseRequestId);
    if (!initialSource) throw rfqPurchaseRequestNotFoundError();
    await contextAccessService.assertBuildingAccess(actorUserId, initialSource.buildingId);

    const existing = await rfqRepository.findByIdempotencyKey(
      client,
      initialSource.clientId,
      input.idempotencyKey,
    );
    if (existing) {
      if (existing.idempotencyFingerprint !== fingerprint(input)) {
        throw rfqIdempotencyConflictError();
      }
      return toPublic(existing);
    }

    assertCreateContext(initialSource, input);
    await assertActiveAllowedCurrency(initialSource.clientId, input.currency);
    const newRfq: NewRfq = {
      clientId: initialSource.clientId,
      buildingId: initialSource.buildingId,
      purchaseRequestId: initialSource.id,
      sourceMode: input.sourceMode,
      rfqNumber: input.rfqNumber,
      title: input.title,
      description: input.description ?? null,
      currency: input.currency,
      requiredDate:
        input.requiredDate === undefined
          ? initialSource.requiredDate
          : input.requiredDate === null
            ? null
            : new Date(input.requiredDate),
      responseDeadline:
        input.responseDeadline === undefined || input.responseDeadline === null
          ? null
          : new Date(input.responseDeadline),
      sourceRequestNumber: initialSource.requestNumber,
      sourceRequestTitle: initialSource.title,
      sourceRequestStatus: initialSource.status,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: fingerprint(input),
      createdByUserId: actorUserId,
    };

    let result: { record: RfqRecord; created: boolean };
    try {
      result = await rfqRepository.createIdempotent(client, newRfq);
    } catch (error) {
      if (uniqueConstraint(error) === 'rfqs_client_number_unique') {
        throw rfqNumberAlreadyExistsError();
      }
      throw error;
    }

    if (!result.created) {
      if (result.record.idempotencyFingerprint !== fingerprint(input)) {
        throw rfqIdempotencyConflictError();
      }
      return toPublic(result.record);
    }

    await recordOperationalEvent(
      {
        clientId: result.record.clientId,
        buildingId: result.record.buildingId,
        eventType: 'RFQ_CREATED',
        entityType: 'RFQ',
        entityId: result.record.id,
        actorUserId,
        summary: `RFQ ${result.record.rfqNumber} created as a DRAFT.`,
        metadata: {
          rfqNumber: result.record.rfqNumber,
          sourceMode: result.record.sourceMode,
          purchaseRequestId: result.record.purchaseRequestId,
          currency: result.record.currency,
        },
      },
      client,
    );
    return toPublic(result.record);
  });
}

export async function getRfq(id: string, actorUserId: string): Promise<PublicRfq> {
  return toPublic(await loadAccessible(id, actorUserId));
}

export async function listRfqs(
  filters: RfqFilters,
  actorUserId: string,
): Promise<PublicRfq[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  }
  if (filters.purchaseRequestId) {
    // A request filter is additionally constrained by the caller's Building
    // scope in the repository query; no global source lookup is disclosed.
  }
  const buildings = await getAccessibleBuildingIds(actorUserId);
  const records = await rfqRepository.list(filters, buildings);
  return records.map(toPublic);
}

export async function updateRfq(
  id: string,
  input: UpdateRfqInput,
  actorUserId: string,
): Promise<PublicRfq> {
  const current = await loadAccessible(id, actorUserId);
  if (current.status !== 'DRAFT') throw rfqNotDraftError();

  return withTransaction(async (client) => {
    const locked = await rfqRepository.findByIdForUpdate(client, id);
    if (!locked) throw rfqNotFoundError();
    if (locked.status !== 'DRAFT') throw rfqNotDraftError();
    if (input.currency !== undefined) await assertActiveAllowedCurrency(locked.clientId, input.currency);
    const updated = await rfqRepository.updateDraftWithClient(client, id, input);
    if (!updated) throw rfqNotDraftError();

    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        buildingId: updated.buildingId,
        eventType: 'RFQ_UPDATED',
        entityType: 'RFQ',
        entityId: updated.id,
        actorUserId,
        summary: `RFQ ${updated.rfqNumber} updated while DRAFT.`,
        metadata: { fields: Object.keys(input) },
      },
      client,
    );
    return toPublic(updated);
  });
}

async function resolveLine(
  client: import('pg').PoolClient,
  rfq: RfqRecord,
  input: CreateRfqLineInput,
  actorUserId: string,
): Promise<NewRfqLine> {
  if (input.sourceLineType === 'MATERIAL_REQUEST') {
    if (rfq.sourceMode !== 'MATERIAL') throw rfqLineSourceModeMismatchError();
    const source = await loadMaterialSource(client, input.sourceLineId);
    if (!source || source.status === 'CANCELLED') throw rfqLineSourceInvalidError();
    if (
      source.clientId !== rfq.clientId ||
      source.buildingId !== rfq.buildingId ||
      source.purchaseRequestId !== rfq.purchaseRequestId
    ) throw rfqLineSourceInvalidError();
    const quantity = source.approvedQuantity ?? source.quantity;
    return {
      rfqId: rfq.id,
      sourceMode: rfq.sourceMode,
      clientId: rfq.clientId,
      buildingId: rfq.buildingId,
      purchaseRequestId: rfq.purchaseRequestId,
      lineNumber: 0,
      materialRequestId: source.id,
      serviceRequestId: null,
      sourceDescription: source.itemName,
      sourceItemId: source.itemId,
      sourceUomId: source.uomId,
      sourceServiceId: null,
      quantitySnapshot: Number(quantity),
      sourceRequiredDate: source.requiredDate,
      sourceClaimStatus: 'ACTIVE',
      createdByUserId: actorUserId,
    };
  }

  if (rfq.sourceMode !== 'SERVICE') throw rfqLineSourceModeMismatchError();
  const source = await loadServiceSource(client, input.sourceLineId);
  if (!source || source.status === 'CANCELLED') throw rfqLineSourceInvalidError();
  if (
    source.clientId !== rfq.clientId ||
    source.buildingId !== rfq.buildingId ||
    source.purchaseRequestId !== rfq.purchaseRequestId
  ) throw rfqLineSourceInvalidError();
  return {
    rfqId: rfq.id,
    sourceMode: rfq.sourceMode,
    clientId: rfq.clientId,
    buildingId: rfq.buildingId,
    purchaseRequestId: rfq.purchaseRequestId,
    lineNumber: 0,
    materialRequestId: null,
    serviceRequestId: source.id,
    sourceDescription: source.title,
    sourceItemId: null,
    sourceUomId: null,
    // CR-BE-SVC-01 PART 04 — governed SERVICE identity propagated from the
    // Service Request (PART 02). NULL when the request is un-governed.
    sourceServiceId: source.serviceCatalogId,
    quantitySnapshot: null,
    sourceRequiredDate: source.requiredDate,
    sourceClaimStatus: 'ACTIVE',
    createdByUserId: actorUserId,
  };
}

export async function addRfqLine(
  rfqId: string,
  input: CreateRfqLineInput,
  actorUserId: string,
): Promise<PublicRfqLine> {
  await loadAccessible(rfqId, actorUserId);
  return withTransaction(async (client) => {
    const rfq = await rfqRepository.findByIdForUpdate(client, rfqId);
    if (!rfq) throw rfqNotFoundError();
    if (rfq.status !== 'DRAFT') throw rfqNotDraftError();
    const resolved = await resolveLine(client, rfq, input, actorUserId);

    let line: RfqLineRecord;
    try {
      line = await rfqRepository.createLineWithClient(client, resolved);
    } catch (error) {
      const constraint = uniqueConstraint(error);
      if (
        constraint === 'rfq_lines_material_source_unique' ||
        constraint === 'rfq_lines_service_source_unique'
      ) throw rfqLineAlreadyExistsError();
      throw error;
    }

    await recordOperationalEvent(
      {
        clientId: line.clientId,
        buildingId: line.buildingId,
        eventType: 'RFQ_LINE_ADDED',
        entityType: 'RFQ_LINE',
        entityId: line.id,
        actorUserId,
        summary: `Demand line added to RFQ ${rfq.rfqNumber}.`,
        metadata: {
          rfqId: rfq.id,
          sourceMode: line.sourceMode,
          materialRequestId: line.materialRequestId,
          serviceRequestId: line.serviceRequestId,
          quantitySnapshot: line.quantitySnapshot,
        },
      },
      client,
    );
    return toPublicLine(line);
  });
}

export async function listRfqLines(
  rfqId: string,
  actorUserId: string,
): Promise<PublicRfqLine[]> {
  await loadAccessible(rfqId, actorUserId);
  return (await rfqRepository.listLines(rfqId)).map(toPublicLine);
}

export async function getRfqLine(
  lineId: string,
  actorUserId: string,
): Promise<PublicRfqLine> {
  const line = await rfqRepository.findLineById(lineId);
  if (!line) throw rfqLineNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, line.buildingId);
  return toPublicLine(line);
}

function ensureDeadlineCanOpen(rfq: RfqRecord): void {
  if (!rfq.responseDeadline) throw rfqDeadlineRequiredError();
  if (rfq.responseDeadline.getTime() <= Date.now()) throw rfqDeadlineInvalidError();
}

async function assertRfqSourceCurrent(
  client: import('pg').PoolClient,
  rfq: RfqRecord,
): Promise<void> {
  const source = await loadPurchaseRequestForUpdate(client, rfq.purchaseRequestId);
  if (!source) throw rfqPurchaseRequestNotFoundError();
  if (
    source.clientId !== rfq.clientId ||
    source.buildingId !== rfq.buildingId ||
    source.requestNumber !== rfq.sourceRequestNumber ||
    source.title !== rfq.sourceRequestTitle
  ) throw rfqSourceChangedError();
  if (source.status !== 'OPEN' || source.clientStatus !== 'ACTIVE' || source.buildingStatus !== 'ACTIVE') {
    throw rfqPurchaseRequestInvalidError();
  }
}

async function assertLineSourcesCurrent(
  client: import('pg').PoolClient,
  rfq: RfqRecord,
  lines: RfqLineRecord[],
): Promise<void> {
  for (const line of lines) {
    if (rfq.sourceMode === 'MATERIAL') {
      const source = await loadMaterialSource(client, line.materialRequestId!);
      if (!source || source.status === 'CANCELLED') throw rfqLineSourceInvalidError();
      const quantity = Number(source.approvedQuantity ?? source.quantity);
      if (
        source.clientId !== line.clientId ||
        source.buildingId !== line.buildingId ||
        source.purchaseRequestId !== line.purchaseRequestId ||
        source.itemId !== line.sourceItemId ||
        source.uomId !== line.sourceUomId ||
        quantity !== line.quantitySnapshot ||
        !isSameDate(source.requiredDate, line.sourceRequiredDate)
      ) throw rfqSourceChangedError();
      if (source.status !== 'APPROVED') throw rfqLineNotApprovedError();
    } else {
      const source = await loadServiceSource(client, line.serviceRequestId!);
      if (!source || source.status === 'CANCELLED') throw rfqLineSourceInvalidError();
      if (
        source.clientId !== line.clientId ||
        source.buildingId !== line.buildingId ||
        source.purchaseRequestId !== line.purchaseRequestId ||
        source.title !== line.sourceDescription ||
        !isSameDate(source.requiredDate, line.sourceRequiredDate)
      ) throw rfqSourceChangedError();
      if (source.status !== 'OPEN') throw rfqLineSourceInvalidError();
    }
  }
}

async function transitionRfq(
  id: string,
  to: Exclude<RfqStatus, 'DRAFT'>,
  actorUserId: string,
): Promise<PublicRfq> {
  await loadAccessible(id, actorUserId);
  return withTransaction(async (client) => {
    const rfq = await rfqRepository.findByIdForUpdate(client, id);
    if (!rfq) throw rfqNotFoundError();

    if (to === 'OPEN') {
      if (rfq.status !== 'DRAFT') throw rfqInvalidTransitionError();
      if ((await rfqRepository.countLines(client, rfq.id)) === 0) throw rfqNoLinesError();
      ensureDeadlineCanOpen(rfq);
      await assertRfqSourceCurrent(client, rfq);
      const lines = await rfqRepository.listLinesWithClient(client, rfq.id);
      await assertLineSourcesCurrent(client, rfq, lines);
    } else if (to === 'CLOSED') {
      if (rfq.status !== 'OPEN') throw rfqNotOpenError();
    } else if (to === 'CANCELLED') {
      if (rfq.status !== 'DRAFT' && rfq.status !== 'OPEN') throw rfqInvalidTransitionError();
    }

    if (to === 'CANCELLED') {
      await rfqRepository.releaseSourceClaimsWithClient(client, rfq.id);
    }

    const updated = await rfqRepository.transitionWithClient(
      client,
      rfq.id,
      rfq.status,
      to,
      actorUserId,
    );
    if (!updated) throw rfqInvalidTransitionError();

    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        buildingId: updated.buildingId,
        eventType: `RFQ_${to}`,
        entityType: 'RFQ',
        entityId: updated.id,
        actorUserId,
        summary: `RFQ ${updated.rfqNumber} transitioned to ${to}.`,
        metadata: {
          fromStatus: rfq.status,
          toStatus: to,
          sourceMode: updated.sourceMode,
          purchaseRequestId: updated.purchaseRequestId,
        },
      },
      client,
    );
    return toPublic(updated);
  });
}

export function openRfq(id: string, actorUserId: string): Promise<PublicRfq> {
  return transitionRfq(id, 'OPEN', actorUserId);
}

export function closeRfq(id: string, actorUserId: string): Promise<PublicRfq> {
  return transitionRfq(id, 'CLOSED', actorUserId);
}

export function cancelRfq(id: string, actorUserId: string): Promise<PublicRfq> {
  return transitionRfq(id, 'CANCELLED', actorUserId);
}

export async function getRfqAvailableActions(
  id: string,
  actorUserId: string,
): Promise<RfqAvailableActions> {
  const rfq = await loadAccessible(id, actorUserId);
  const availableActions: RfqAction[] =
    rfq.status === 'DRAFT'
      ? ['OPEN', 'CANCEL']
      : rfq.status === 'OPEN'
        ? ['CLOSE', 'CANCEL']
        : [];
  return { rfqId: rfq.id, state: rfq.status, availableActions };
}

export const rfqService = {
  addRfqLine,
  cancelRfq,
  closeRfq,
  createRfq,
  getRfq,
  getRfqAvailableActions,
  getRfqLine,
  listRfqLines,
  listRfqs,
  openRfq,
  updateRfq,
};
