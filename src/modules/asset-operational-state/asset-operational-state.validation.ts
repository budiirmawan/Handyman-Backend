import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ASSET_OPERATIONAL_STATES,
  ASSET_OPERATIONAL_STATE_MUTATION_TARGETS,
  isAssetOperationalState,
  isAssetOperationalStateMutationTarget,
  type ReturnAssetToServiceInput,
  type TransitionAssetOperationalStateInput,
} from './asset-operational-state.types';

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 — strict DTOs.
 *
 * The PATCH body is an ALLOWLIST of exactly three keys. Everything else —
 * including every authority field the write derives server-side — is a 400,
 * not a silently ignored key. The derived-authority keys get a specific
 * message so a client that tries to assert Client / Building / actor /
 * timestamp / version-authority is told why it cannot.
 */

export type ValidationDetail = { field: string; message: string };

const MAX_REASON_LENGTH = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export function parseOperationalStateAssetIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    fail([{ field: 'assetId', message: 'Asset id must be a valid UUID.' }]);
  }
  return value.toLowerCase();
}

/**
 * Body keys the command derives or owns. Named individually so the rejection
 * is diagnosable, and so the list cannot be quietly relaxed.
 *
 * `version` is included on purpose: the caller states the version it READ via
 * `expectedVersion`, but must not be able to assert a resulting version — that
 * is the backend's increment.
 */
const DERIVED_FIELDS: Readonly<Record<string, string>> = {
  assetId: 'assetId is taken from the request path.',
  clientId: 'clientId is derived from the Asset by the backend.',
  buildingId: 'buildingId is derived from the Asset by the backend.',
  actorUserId: 'The acting user is derived from the session.',
  changedByUserId: 'The acting user is derived from the session.',
  changedAt: 'The change timestamp is set by the backend.',
  operationalStateChangedAt: 'The change timestamp is set by the backend.',
  version: 'The resulting version is incremented by the backend.',
  operationalStateVersion: 'The resulting version is incremented by the backend.',
  status: 'The master lifecycle status is a separate BE-05E axis.',
  assetStatus: 'The master lifecycle status is a separate BE-05E axis.',
  previousStatus: 'The master lifecycle status is a separate BE-05E axis.',
  equipmentStatus: 'Equipment profile status is a separate BE-05D model.',
  id: 'This identifier is derived by the backend.',
};

/**
 * Parses the transition body.
 *
 * `state` MUST NOT be `IN_SERVICE`. It is rejected with its own message rather
 * than as an enum failure, because the caller's intent is well-formed but
 * governed elsewhere: leaving a non-service state is the PART-03
 * RETURN_TO_SERVICE operation, with its own preconditions and approval. Said
 * plainly here so the boundary is discoverable at the point of use.
 */
export function parseTransitionOperationalStateBody(
  body: unknown,
): TransitionAssetOperationalStateInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const allowed = new Set(['state', 'reason', 'expectedVersion']);
  const rejected: ValidationDetail[] = [];
  for (const key of Object.keys(body)) {
    if (allowed.has(key)) continue;
    rejected.push({
      field: key,
      message: DERIVED_FIELDS[key] ?? `${key} is not accepted by this command.`,
    });
  }
  if (rejected.length > 0) fail(rejected);

  const details: ValidationDetail[] = [];

  if (body.state === undefined) {
    details.push({ field: 'state', message: 'state is required.' });
  } else if (body.state === 'IN_SERVICE') {
    details.push({
      field: 'state',
      message:
        'IN_SERVICE is not a valid target for this operation; returning an asset to service is a separate governed operation.',
    });
  } else if (!isAssetOperationalStateMutationTarget(body.state)) {
    if (isAssetOperationalState(body.state)) {
      details.push({
        field: 'state',
        message: `state must be one of: ${ASSET_OPERATIONAL_STATE_MUTATION_TARGETS.join(', ')}.`,
      });
    } else {
      details.push({
        field: 'state',
        message: `state must be one of: ${ASSET_OPERATIONAL_STATES.join(', ')}.`,
      });
    }
  }

  let reason: string | undefined;
  if (body.reason === undefined) {
    details.push({ field: 'reason', message: 'reason is required.' });
  } else if (typeof body.reason !== 'string') {
    details.push({ field: 'reason', message: 'reason must be a string.' });
  } else {
    const trimmed = body.reason.trim();
    if (trimmed.length === 0) {
      details.push({ field: 'reason', message: 'reason must not be blank.' });
    } else if (trimmed.length > MAX_REASON_LENGTH) {
      details.push({
        field: 'reason',
        message: `reason must be at most ${MAX_REASON_LENGTH} characters.`,
      });
    } else {
      reason = trimmed;
    }
  }

  let expectedVersion: number | undefined;
  if (body.expectedVersion === undefined) {
    details.push({
      field: 'expectedVersion',
      message: 'expectedVersion is required.',
    });
  } else if (
    typeof body.expectedVersion !== 'number' ||
    !Number.isInteger(body.expectedVersion)
  ) {
    details.push({
      field: 'expectedVersion',
      message: 'expectedVersion must be an integer.',
    });
  } else if (body.expectedVersion < 1) {
    details.push({
      field: 'expectedVersion',
      message: 'expectedVersion must be at least 1.',
    });
  } else {
    expectedVersion = body.expectedVersion;
  }

  if (!isAssetOperationalStateMutationTarget(body.state) || !reason || !expectedVersion) {
    fail(details);
  }

  return {
    state: body.state,
    reason: reason as string,
    expectedVersion: expectedVersion as number,
  };
}

/* -------------------------------------------------------------------------- */
/* PART 03 — the governed return-to-service request                            */
/* -------------------------------------------------------------------------- */

/**
 * Body keys the return command derives or owns, and the reason each one is
 * refused.
 *
 * The three `state` aliases matter most: this command's TARGET is not data, so
 * there is no field in which a caller could name a different destination state
 * (or re-state the source). The approval keys matter next: PART 03 records the
 * executing actor as the authorizing reviewer, and accepts no other identity —
 * a client must not be able to assert who approved a safety decision, nor claim
 * an approval status it cannot establish.
 */
const RETURN_DERIVED_FIELDS: Readonly<Record<string, string>> = {
  assetId: 'assetId is taken from the request path.',
  clientId: 'clientId is derived from the Asset by the backend.',
  buildingId: 'buildingId is derived from the Asset by the backend.',
  state: 'The target state of this command is fixed: IN_SERVICE.',
  operationalState: 'The target state of this command is fixed: IN_SERVICE.',
  toState: 'The target state of this command is fixed: IN_SERVICE.',
  fromState: 'The source state is read from the Asset by the backend.',
  version: 'The resulting version is incremented by the backend.',
  operationalStateVersion: 'The resulting version is incremented by the backend.',
  changedByUserId: 'The acting user is derived from the session.',
  changedAt: 'The change timestamp is set by the backend.',
  operationalStateChangedAt: 'The change timestamp is set by the backend.',
  approvedByUserId:
    'The authorizing user is the authenticated actor; it is never client-supplied.',
  approvedAt: 'The approval timestamp is the command timestamp.',
  approvalMode: 'The approval model is fixed: DIRECT_PRIVILEGED_COMMAND.',
  reviewerUserId: 'This command has no separate reviewer; identity is the session.',
  approverUserId: 'This command has no separate approver; identity is the session.',
  approvalStatus: 'This command creates no pending approval to be in a status.',
  status: 'The master lifecycle status is a separate BE-05E axis.',
  assetStatus: 'The master lifecycle status is a separate BE-05E axis.',
  previousStatus: 'The master lifecycle status is a separate BE-05E axis.',
  equipmentStatus: 'Equipment profile status is a separate BE-05D model.',
  failureStatus: 'Asset Failure state is owned by the BE-21C lifecycle.',
  operationalImpact: 'Asset Failure impact is owned by the BE-21C record.',
  incidentId: 'Linking a specific failure is not part of this command.',
  safetyRiskGate: 'The safety-risk gate is evaluated by the backend.',
  id: 'This identifier is derived by the backend.',
};

/**
 * Parses the return-to-service body: exactly `reason` and `expectedVersion`.
 *
 * Same rules as the PART-02 transition body for both fields (trimmed,
 * non-blank, <= 1000 characters; integer >= 1), because they mean the same
 * thing — the only difference is that this command has no `state` member to
 * validate, since its target is not caller-controlled.
 *
 * There is NO `expectedVersion`-optional form and no unconditional variant: a
 * governed safety command always states the version it acted on.
 */
export function parseReturnToServiceBody(
  body: unknown,
): ReturnAssetToServiceInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const allowed = new Set(['reason', 'expectedVersion']);
  const rejected: ValidationDetail[] = [];
  for (const key of Object.keys(body)) {
    if (allowed.has(key)) continue;
    rejected.push({
      field: key,
      message:
        RETURN_DERIVED_FIELDS[key] ?? `${key} is not accepted by this command.`,
    });
  }
  if (rejected.length > 0) fail(rejected);

  const details: ValidationDetail[] = [];

  let reason: string | undefined;
  if (body.reason === undefined) {
    details.push({ field: 'reason', message: 'reason is required.' });
  } else if (typeof body.reason !== 'string') {
    details.push({ field: 'reason', message: 'reason must be a string.' });
  } else {
    const trimmed = body.reason.trim();
    if (trimmed.length === 0) {
      details.push({ field: 'reason', message: 'reason must not be blank.' });
    } else if (trimmed.length > MAX_REASON_LENGTH) {
      details.push({
        field: 'reason',
        message: `reason must be at most ${MAX_REASON_LENGTH} characters.`,
      });
    } else {
      reason = trimmed;
    }
  }

  let expectedVersion: number | undefined;
  if (body.expectedVersion === undefined) {
    details.push({
      field: 'expectedVersion',
      message: 'expectedVersion is required.',
    });
  } else if (
    typeof body.expectedVersion !== 'number' ||
    !Number.isInteger(body.expectedVersion)
  ) {
    details.push({
      field: 'expectedVersion',
      message: 'expectedVersion must be an integer.',
    });
  } else if (body.expectedVersion < 1) {
    details.push({
      field: 'expectedVersion',
      message: 'expectedVersion must be at least 1.',
    });
  } else {
    expectedVersion = body.expectedVersion;
  }

  if (!reason || !expectedVersion) fail(details);

  return { reason: reason as string, expectedVersion: expectedVersion as number };
}
