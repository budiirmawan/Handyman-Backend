/** Operations proposal DTO only. Never accepts consent, actor, scope context or readiness facts. */
export const VISIT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFSET_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/;
export type VisitProposalBody = {
  kind: 'INSPECTION' | 'EXECUTION'; resourceId: string;
  executionScopeId: string | null; startAt?: string; endAt?: string;
};
const id = (v: unknown): v is string => typeof v === 'string' && VISIT_UUID.test(v);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function stamp(value: unknown): number {
  if (typeof value !== 'string' || !OFFSET_TIME.test(value)) throw new Error('INVALID_TIME_WINDOW');
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error('INVALID_TIME_WINDOW');
  return epoch;
}
/** Existing interval rules, also applied to server-resolved requested dates. */
export function parseVisitWindow(startAt: unknown, endAt: unknown): { startAt: string; endAt: string } {
  const start = stamp(startAt);
  const end = stamp(endAt);
  if (end <= start || end - start > 24 * 3600_000) throw new Error('INVALID_TIME_WINDOW');
  if (start <= Date.now()) throw new Error('PROPOSAL_REQUIRES_FUTURE_SLOT');
  return { startAt: startAt as string, endAt: endAt as string };
}
export function parseHandymanVisitProposal(value: unknown): VisitProposalBody {
  if (!record(value) || Object.keys(value).some(key =>
      !['kind', 'resourceId', 'executionScopeId', 'startAt', 'endAt'].includes(key))) {
    throw new Error('INVALID_PROPOSAL_FIELDS');
  }
  if (value.kind !== 'INSPECTION' && value.kind !== 'EXECUTION') throw new Error('INVALID_APPOINTMENT_KIND');
  if (!id(value.resourceId)) throw new Error('INVALID_RESOURCE_ID');
  const scopeId = value.executionScopeId ?? null;
  if (value.kind === 'INSPECTION' ? scopeId !== null : !id(scopeId)) throw new Error('INVALID_EXECUTION_SCOPE');
  // Execution may reuse the request's existing preferred window. Inspection
  // always supplies its own separate visit window. Partial pairs stay invalid.
  const interval = value.kind === 'EXECUTION' && value.startAt === undefined && value.endAt === undefined
    ? {} : parseVisitWindow(value.startAt, value.endAt);
  return { kind: value.kind, resourceId: value.resourceId.toLowerCase(),
    executionScopeId: typeof scopeId === 'string' ? scopeId.toLowerCase() : null, ...interval };
}
export function parseVisitParam(value: unknown): string {
  if (!id(value)) throw new Error('INVALID_UUID');
  return value.toLowerCase();
}
export function parseCancelBody(value: unknown): { version: number } {
  if (!record(value) || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.version) ||
      (value.version as number) < 1) throw new Error('INVALID_CANCEL_VERSION');
  return { version: value.version as number };
}
