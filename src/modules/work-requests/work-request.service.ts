import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import { resolveBuildingClientId } from '../shifts';
import { userNotFoundError, userRepository } from '../users';
import {
  workRequestBuildingClientMismatchError,
  workRequestNotOpenError,
  workRequestNotFoundError,
  workRequestNumberAlreadyExistsError,
  workRequestTerminalStateError,
} from './work-request.errors';
import { workRequestRepository } from './work-request.repository';
import type {
  CreateWorkRequestInput,
  NewWorkRequest,
  PublicWorkRequest,
  UpdateWorkRequestInput,
  WorkRequestFilters,
  WorkRequestRecord,
} from './work-request.types';

export function toPublicWorkRequest(
  record: WorkRequestRecord,
): PublicWorkRequest {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    requestNumber: record.requestNumber,
    title: record.title,
    description: record.description,
    requestType: record.requestType,
    requestedByUserId: record.requestedByUserId,
    requestedAt: record.requestedAt.toISOString(),
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Creates a Work Request under a Building, owned by the supplied Client.
 *
 * The Client must exist and be ACTIVE, and the Building must resolve — through
 * Property → Client — to that same Client (reusing the BE-03 resolver), so a
 * request can never be scoped to a Client its Building does not belong to.
 * The requester must be a real user record. Request number uniqueness is
 * enforced within the Client scope.
 *
 * Validation order (pinned by tests):
 *   1. unknown Client                 → 404 CLIENT_NOT_FOUND
 *   2. INACTIVE Client                → 400 CLIENT_INACTIVE
 *   3. unknown Building               → 404 BUILDING_NOT_FOUND
 *   4. Building owned by another Client → 400 WORK_REQUEST_BUILDING_CLIENT_MISMATCH
 *   5. unknown requester              → 404 USER_NOT_FOUND
 *   6. duplicate request number       → 409 WORK_REQUEST_NUMBER_ALREADY_EXISTS
 */
export async function createWorkRequest(
  input: CreateWorkRequestInput,
): Promise<PublicWorkRequest> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  const buildingClientId = await resolveBuildingClientId(input.buildingId);
  if (buildingClientId !== input.clientId) {
    throw workRequestBuildingClientMismatchError();
  }

  const requester = await userRepository.findById(input.requestedByUserId);
  if (!requester) {
    throw userNotFoundError();
  }

  const existing = await workRequestRepository.findByRequestNumberForClient(
    input.clientId,
    input.requestNumber,
  );
  if (existing) {
    throw workRequestNumberAlreadyExistsError();
  }

  const newWorkRequest: NewWorkRequest = {
    clientId: input.clientId,
    buildingId: input.buildingId,
    requestNumber: input.requestNumber,
    title: input.title,
    description: input.description?.trim() || null,
    requestType: input.requestType,
    requestedByUserId: input.requestedByUserId,
  };

  try {
    const record = await workRequestRepository.create(newWorkRequest);
    return toPublicWorkRequest(record);
  } catch (error) {
    if (isWorkRequestNumberUniqueViolation(error)) {
      throw workRequestNumberAlreadyExistsError();
    }
    throw error;
  }
}

export async function getWorkRequestById(
  id: string,
): Promise<PublicWorkRequest> {
  const record = await workRequestRepository.findById(id);
  if (!record) {
    throw workRequestNotFoundError();
  }
  return toPublicWorkRequest(record);
}

/**
 * Lists the Work Requests of one Building, optionally filtered by `status`
 * and `requestType`. The Building is validated first (unknown Building → 404
 * rather than an empty list). Queries stay scoped to `building_id`, so the
 * list can never leak another Building's or Client's requests.
 */
export async function listWorkRequestsByBuilding(
  buildingId: string,
  filters: WorkRequestFilters,
): Promise<PublicWorkRequest[]> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const records = await workRequestRepository.listByBuilding(buildingId, filters);
  return records.map(toPublicWorkRequest);
}

/**
 * Partially updates an OPEN Work Request (title, description, requestType).
 * `client_id`, `building_id`, `request_number`, and `requested_by_user_id`
 * are immutable — a request never migrates between Clients/Buildings, and its
 * number is its stable operational identifier. A request that is no longer
 * OPEN (CANCELLED or CONVERTED) is terminal for intake and cannot be edited.
 */
export async function updateWorkRequest(
  id: string,
  input: UpdateWorkRequestInput,
): Promise<PublicWorkRequest> {
  const existing = await workRequestRepository.findById(id);
  if (!existing) {
    throw workRequestNotFoundError();
  }
  if (existing.status !== 'OPEN') {
    throw workRequestNotOpenError();
  }

  const record = await workRequestRepository.update(id, input);
  return toPublicWorkRequest(record as WorkRequestRecord);
}

/**
 * Cancels an OPEN Work Request (OPEN → CANCELLED). A CONVERTED request is
 * terminal for intake and cannot be cancelled; an already-cancelled request
 * cannot be cancelled again. Cancel is not a delete — the request remains
 * persisted for history.
 */
export async function cancelWorkRequest(id: string): Promise<PublicWorkRequest> {
  const existing = await workRequestRepository.findById(id);
  if (!existing) {
    throw workRequestNotFoundError();
  }
  if (existing.status === 'CONVERTED') {
    throw workRequestTerminalStateError();
  }
  if (existing.status !== 'OPEN') {
    throw workRequestNotOpenError();
  }

  const record = await workRequestRepository.updateStatus(id, 'CANCELLED');
  return toPublicWorkRequest(record as WorkRequestRecord);
}

/**
 * Marks an OPEN Work Request as CONVERTED (the terminal intake state once it
 * becomes a Work Order). Called by the BE-08B conversion flow so the Work
 * Request is marked consistently with BE-08A behavior: a CANCELLED request
 * cannot be converted, and a CONVERTED request is terminal and cannot be
 * re-converted.
 */
export async function convertWorkRequest(id: string): Promise<PublicWorkRequest> {
  const existing = await workRequestRepository.findById(id);
  if (!existing) {
    throw workRequestNotFoundError();
  }
  if (existing.status === 'CONVERTED') {
    throw workRequestTerminalStateError();
  }
  if (existing.status !== 'OPEN') {
    throw workRequestNotOpenError();
  }

  const record = await workRequestRepository.updateStatus(id, 'CONVERTED');
  return toPublicWorkRequest(record as WorkRequestRecord);
}

function isWorkRequestNumberUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'work_request_number_unique'
  );
}

export const workRequestService = {
  cancelWorkRequest,
  convertWorkRequest,
  createWorkRequest,
  getWorkRequestById,
  listWorkRequestsByBuilding,
  toPublicWorkRequest,
  updateWorkRequest,
};
