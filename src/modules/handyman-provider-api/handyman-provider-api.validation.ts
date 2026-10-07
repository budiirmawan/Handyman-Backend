import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HANDYMAN_CREW_STATUSES,
  HANDYMAN_PROVIDER_CONTEXT_STATUSES,
  HANDYMAN_WORKER_CONTEXT_STATUSES,
} from '../handyman-providers';
import type {
  AddHandymanCrewMemberInput,
  CreateHandymanProviderContextInput,
  CreateHandymanWorkerContextInput,
  CreateHandymanWorkCrewInput,
  DesignateHandymanCrewLeadInput,
  HandymanCrewStatus,
  HandymanProviderContextStatus,
  HandymanWorkerContextStatus,
  ListHandymanProviderAvailabilityInput,
} from '../handyman-providers';

/**
 * CR-HM-04 PART 05A — request/DTO parsing for the Handyman provider /
 * worker / crew surface (FROZEN F9). Validation-only: the PART 01–03
 * services remain the sole business authority (provider/worker/crew
 * invariants, Lead eligibility, scope, journal).
 *
 * Authority rule: bodies expose ONLY caller-owned inputs
 * (vendor/provider-context/workforce-profile/worker-context references,
 * crew code/name, target status). Any smuggled keys — actor/user ids,
 * clientId, provider-derived scope, workforce identity fields, Lead
 * eligibility results, assignment targets, FM context — are structurally
 * IGNORED: parsers never spread the source object, so smuggled fields
 * cannot even reach the service layer.
 */

type Detail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function readId(
  value: unknown,
  field: string,
  details: Detail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} is required and must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readText(
  value: unknown,
  field: string,
  details: Detail[],
  max: number,
): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (typeof value !== 'string' || trimmed.length < 1 || trimmed.length > max) {
    details.push({
      field,
      message: `${field} is required and must be between 1 and ${max} characters.`,
    });
  }
  return trimmed;
}

function readEnum<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
  details: Detail[],
): T[number] | undefined {
  if (
    typeof value === 'string' &&
    (allowed as readonly string[]).includes(value.trim())
  ) {
    return value.trim() as T[number];
  }
  details.push({
    field,
    message: `${field} must be one of: ${allowed.join(', ')}.`,
  });
  return undefined;
}

/** Path parameter authority: a single UUID id in the URL. */
export function parseProviderApiUuidParam(
  value: unknown,
  field: string,
): string {
  const details: Detail[] = [];
  const id = readId(value, field, details);
  if (!id || details.length) fail(details);
  return id;
}

/** POST /handyman/provider-contexts — vendor reference only. */
export function parseProviderContextCreateBody(
  body: unknown,
): CreateHandymanProviderContextInput {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const vendorId = readId(source.vendorId, 'vendorId', details);
  if (!vendorId || details.length) fail(details);
  return { vendorId };
}

/** POST /handyman/provider-contexts/:providerContextId/status */
export function parseProviderContextStatusBody(
  body: unknown,
): HandymanProviderContextStatus {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const status = readEnum(
    source.status,
    'status',
    HANDYMAN_PROVIDER_CONTEXT_STATUSES,
    details,
  );
  if (!status || details.length) fail(details);
  return status;
}

/**
 * POST /handyman/worker-contexts — provider-context + workforce-profile
 * references required by the PART 02 service. Workforce identity fields
 * themselves are never accepted.
 */
export function parseWorkerContextCreateBody(
  body: unknown,
): CreateHandymanWorkerContextInput {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const handymanProviderContextId = readId(
    source.handymanProviderContextId,
    'handymanProviderContextId',
    details,
  );
  const workforceProfileId = readId(
    source.workforceProfileId,
    'workforceProfileId',
    details,
  );
  if (!handymanProviderContextId || !workforceProfileId || details.length) {
    fail(details);
  }
  return { handymanProviderContextId, workforceProfileId };
}

/** POST /handyman/worker-contexts/:workerContextId/status */
export function parseWorkerContextStatusBody(
  body: unknown,
): HandymanWorkerContextStatus {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const status = readEnum(
    source.status,
    'status',
    HANDYMAN_WORKER_CONTEXT_STATUSES,
    details,
  );
  if (!status || details.length) fail(details);
  return status;
}

/**
 * POST /handyman/work-crews — minimum crew fields + the initial valid
 * Lead worker-context reference (transactional creation, F4).
 */
export function parseWorkCrewCreateBody(
  body: unknown,
): CreateHandymanWorkCrewInput {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const handymanProviderContextId = readId(
    source.handymanProviderContextId,
    'handymanProviderContextId',
    details,
  );
  const code = readText(source.code, 'code', details, 64);
  const name = readText(source.name, 'name', details, 200);
  const leadWorkerContextId = readId(
    source.leadWorkerContextId,
    'leadWorkerContextId',
    details,
  );
  if (
    !handymanProviderContextId ||
    !leadWorkerContextId ||
    details.length
  ) {
    fail(details);
  }
  return { handymanProviderContextId, code, name, leadWorkerContextId };
}

/** POST /handyman/work-crews/:crewId/status */
export function parseWorkCrewStatusBody(body: unknown): HandymanCrewStatus {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const status = readEnum(
    source.status,
    'status',
    HANDYMAN_CREW_STATUSES,
    details,
  );
  if (!status || details.length) fail(details);
  return status;
}

/** POST /handyman/work-crews/:crewId/members — worker-context reference. */
export function parseCrewMemberBody(
  body: unknown,
): Omit<AddHandymanCrewMemberInput, 'handymanCrewId'> {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const handymanWorkerContextId = readId(
    source.handymanWorkerContextId,
    'handymanWorkerContextId',
    details,
  );
  if (!handymanWorkerContextId || details.length) fail(details);
  return { handymanWorkerContextId };
}

/** POST /handyman/work-crews/:crewId/lead — eligible member reference. */
export function parseCrewLeadBody(
  body: unknown,
): Omit<DesignateHandymanCrewLeadInput, 'handymanCrewId'> {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const handymanWorkerContextId = readId(
    source.handymanWorkerContextId,
    'handymanWorkerContextId',
    details,
  );
  if (!handymanWorkerContextId || details.length) fail(details);
  return { handymanWorkerContextId };
}

/** POST /handyman/crew-memberships/:membershipId/status */
export function parseCrewMembershipStatusBody(
  body: unknown,
): HandymanCrewStatus {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const status = readEnum(
    source.status,
    'status',
    HANDYMAN_CREW_STATUSES,
    details,
  );
  if (!status || details.length) fail(details);
  return status;
}

/**
 * GET /handyman/provider-availability — CR-HM-17 GAP PART 02 (B4) bounded
 * query parser. Requires `clientId` or `executionScopeId`, plus optional
 * `providerContextId`.
 */
export function parseProviderAvailabilityQuery(
  query: unknown,
): ListHandymanProviderAvailabilityInput {
  const source = isRecord(query) ? query : {};
  const details: Detail[] = [];

  const readOptionalUuid = (
    value: unknown,
    field: string,
  ): string | undefined => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    return readId(value, field, details);
  };

  const clientId = readOptionalUuid(source.clientId, 'clientId');
  const executionScopeId = readOptionalUuid(
    source.executionScopeId,
    'executionScopeId',
  );
  const providerContextId = readOptionalUuid(
    source.providerContextId,
    'providerContextId',
  );

  if (!clientId && !executionScopeId && details.length === 0) {
    details.push({
      field: 'clientId',
      message: 'clientId or executionScopeId is required.',
    });
  }
  if (details.length > 0) fail(details);

  return {
    ...(clientId ? { clientId } : {}),
    ...(executionScopeId ? { executionScopeId } : {}),
    ...(providerContextId ? { providerContextId } : {}),
  };
}
