import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import { resolveBuildingClientId } from '../shifts';
import { userNotFoundError, userRepository } from '../users';
import {
  purchaseRequestBuildingClientMismatchError,
  purchaseRequestNotOpenError,
  purchaseRequestNotFoundError,
  purchaseRequestNumberAlreadyExistsError,
} from './purchase-request.errors';
import { purchaseRequestRepository } from './purchase-request.repository';
import type {
  CreatePurchaseRequestInput,
  NewPurchaseRequest,
  PublicPurchaseRequest,
  PurchaseRequestRecord,
  UpdatePurchaseRequestInput,
  PurchaseRequestFilters,
} from './purchase-request.types';

export function toPublicPurchaseRequest(
  record: PurchaseRequestRecord,
): PublicPurchaseRequest {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    requestNumber: record.requestNumber,
    requesterReference: record.requesterReference,
    requestType: record.requestType,
    title: record.title,
    description: record.description,
    requiredDate: record.requiredDate
      ? record.requiredDate.toISOString()
      : null,
    priority: record.priority,
    status: record.status,
    requestedByUserId: record.requestedByUserId,
    requestedAt: record.requestedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toDateOrNull(value: string | null | undefined): Date | null {
  if (value === undefined || value === null) {
    return null;
  }
  return new Date(value);
}

/**
 * Creates a Purchase Request under a Building, owned by the supplied Client.
 *
 * The Client must exist and be ACTIVE, and the Building must resolve — through
 * Property → Client — to that same Client (reusing the BE-03 resolver), so a
 * request can never be scoped to a Client its Building does not belong to.
 * The requester is a real user record. Request number uniqueness is enforced
 * within the Client scope.
 *
 * Validation order (pinned by tests):
 *   1. unknown Client                 → 404 CLIENT_NOT_FOUND
 *   2. INACTIVE Client                → 400 CLIENT_INACTIVE
 *   3. unknown Building               → 404 BUILDING_NOT_FOUND
 *   4. Building owned by another Client → 400 PURCHASE_REQUEST_BUILDING_CLIENT_MISMATCH
 *   5. unknown requester              → 404 USER_NOT_FOUND
 *   6. duplicate request number       → 409 PURCHASE_REQUEST_NUMBER_ALREADY_EXISTS
 */
export async function createPurchaseRequest(
  input: CreatePurchaseRequestInput,
): Promise<PublicPurchaseRequest> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  const buildingClientId = await resolveBuildingClientId(input.buildingId);
  if (buildingClientId !== input.clientId) {
    throw purchaseRequestBuildingClientMismatchError();
  }

  const requester = await userRepository.findById(input.requestedByUserId);
  if (!requester) {
    throw userNotFoundError();
  }

  const existing = await purchaseRequestRepository.findByRequestNumberForClient(
    input.clientId,
    input.requestNumber,
  );
  if (existing) {
    throw purchaseRequestNumberAlreadyExistsError();
  }

  const newPurchaseRequest: NewPurchaseRequest = {
    clientId: input.clientId,
    buildingId: input.buildingId,
    requestNumber: input.requestNumber,
    requesterReference: input.requesterReference?.trim() || null,
    requestType: input.requestType,
    title: input.title,
    description: input.description?.trim() || null,
    requiredDate: toDateOrNull(input.requiredDate),
    priority: input.priority ?? 'MEDIUM',
    requestedByUserId: input.requestedByUserId,
  };

  try {
    const record = await purchaseRequestRepository.create(newPurchaseRequest);
    return toPublicPurchaseRequest(record);
  } catch (error) {
    if (isPurchaseRequestNumberUniqueViolation(error)) {
      throw purchaseRequestNumberAlreadyExistsError();
    }
    throw error;
  }
}

export async function getPurchaseRequestById(
  id: string,
): Promise<PublicPurchaseRequest> {
  const record = await purchaseRequestRepository.findById(id);
  if (!record) {
    throw purchaseRequestNotFoundError();
  }
  return toPublicPurchaseRequest(record);
}

/**
 * Lists the Purchase Requests of one Building, optionally filtered by status,
 * request type, requester user, and priority. The Building is validated first
 * (unknown Building → 404 rather than an empty list). Queries stay scoped to
 * `building_id`, so the list can never leak another Building's or Client's
 * requests.
 */
export async function listPurchaseRequestsByBuilding(
  buildingId: string,
  filters: PurchaseRequestFilters,
): Promise<PublicPurchaseRequest[]> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const records = await purchaseRequestRepository.listByBuilding(
    buildingId,
    filters,
  );
  return records.map(toPublicPurchaseRequest);
}

/**
 * Partially updates an OPEN Purchase Request (requesterReference, requestType,
 * title, description, requiredDate, priority). `client_id`, `building_id`,
 * `request_number`, and `requested_by_user_id` are immutable — a request never
 * migrates between Clients/Buildings, and its number is its stable operational
 * identifier. A request that is no longer OPEN (CANCELLED) is terminal for
 * intake and cannot be edited.
 */
export async function updatePurchaseRequest(
  id: string,
  input: UpdatePurchaseRequestInput,
): Promise<PublicPurchaseRequest> {
  const existing = await purchaseRequestRepository.findById(id);
  if (!existing) {
    throw purchaseRequestNotFoundError();
  }
  if (existing.status !== 'OPEN') {
    throw purchaseRequestNotOpenError();
  }

  const record = await purchaseRequestRepository.update(id, input);
  return toPublicPurchaseRequest(record as PurchaseRequestRecord);
}

/**
 * Cancels an OPEN Purchase Request (OPEN → CANCELLED). An already-cancelled
 * request cannot be cancelled again. Cancel is not a delete — the request
 * remains persisted for history.
 */
export async function cancelPurchaseRequest(
  id: string,
): Promise<PublicPurchaseRequest> {
  const existing = await purchaseRequestRepository.findById(id);
  if (!existing) {
    throw purchaseRequestNotFoundError();
  }
  if (existing.status !== 'OPEN') {
    throw purchaseRequestNotOpenError();
  }

  const record = await purchaseRequestRepository.updateStatus(id, 'CANCELLED');
  return toPublicPurchaseRequest(record as PurchaseRequestRecord);
}

function isPurchaseRequestNumberUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'purchase_request_number_unique'
  );
}

export const purchaseRequestService = {
  cancelPurchaseRequest,
  createPurchaseRequest,
  getPurchaseRequestById,
  listPurchaseRequestsByBuilding,
  toPublicPurchaseRequest,
  updatePurchaseRequest,
};
