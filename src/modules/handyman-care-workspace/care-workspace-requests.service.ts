import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { readHandoffIntegrationSecret } from '../handyman-handoff/handoff-runtime.config';
import { handoffRuntimeRepository } from '../handyman-handoff/handoff-runtime.repository';
import { handymanServiceRequestRepository, type WorkspaceRequestSelection } from '../handyman-requests/handyman-service-request.repository';
import { toCustomerCarePublic } from '../handyman-requests/handyman-service-request.service';
import { isHandymanServiceRequestStatus } from '../handyman-requests/handyman-service-request.types';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from './care-workspace.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => AppError.validation('Invalid care request list query.');
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update('HANDYMAN_CARE_REQUEST_LIST_CURSOR_V1\0' + payload).digest('base64url');
}

/** Workspace identity never substitutes for represented-customer authority.
 * This adapter only lists the existing bounded request projection; no User/PIC
 * impersonation, historical exception or request-detail capability is added. */
export async function listCareWorkspaceRequests(token: string, query: unknown, body?: unknown) {
  const principal = await resolveCareWorkspacePrincipal(token);
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length))) throw invalid();
  const q = query as Record<string, unknown>;
  if (Object.keys(q).some(k => !['propertyId', 'tenantCompanyId', 'buildingId', 'spaceId',
    'status', 'channelAttributionId', 'limit', 'cursor'].includes(k))) throw invalid();
  const limit = q.limit === undefined ? 25 : typeof q.limit === 'string' && /^[1-9]\d{0,2}$/.test(q.limit) ? Number(q.limit) : NaN;
  if (!Number.isInteger(limit) || limit > 100) throw invalid();
  if (q.status !== undefined && !isHandymanServiceRequestStatus(q.status)) throw invalid();
  const selection: WorkspaceRequestSelection = {
    propertyId: uuid(q.propertyId), tenantCompanyId: uuid(q.tenantCompanyId), buildingId: uuid(q.buildingId),
    spaceId: q.spaceId === undefined ? null : uuid(q.spaceId),
    status: q.status === undefined ? null : q.status as WorkspaceRequestSelection['status'],
    channelAttributionId: q.channelAttributionId === undefined ? null : uuid(q.channelAttributionId),
    limit, afterId: null, afterCreatedAt: null,
  };
  const integration = await handoffRuntimeRepository.findIntegrationById(principal.integrationId);
  if (!integration) throw workspaceUnauthorized();
  const secret = readHandoffIntegrationSecret(integration.integrationCode);
  if (!secret) throw AppError.internal('Workspace pagination is unavailable.');
  const binding = JSON.stringify({ v: 1, route: '/handyman/care/requests', sessionId: principal.sessionId,
    careActorId: principal.careActorId, integrationId: principal.integrationId, ...selection,
    order: 'createdAt:desc,id:desc', expiresAt: principal.expiresAt });
  if (q.cursor !== undefined) {
    if (typeof q.cursor !== 'string' || q.cursor.length > 2048) throw invalid();
    const parts = q.cursor.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]) ||
        !timingSafeEqual(Buffer.from(sign(parts[0], secret)), Buffer.from(parts[1]))) throw invalid();
    try {
      const decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (decoded.binding !== binding || Date.parse(principal.expiresAt) <= Date.now() ||
          typeof decoded.afterCreatedAt !== 'string' ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(decoded.afterCreatedAt) ||
          !Number.isFinite(Date.parse(decoded.afterCreatedAt))) throw invalid();
      selection.afterId = uuid(decoded.afterId);
      selection.afterCreatedAt = decoded.afterCreatedAt;
    } catch { throw invalid(); }
  }
  const result = await handymanServiceRequestRepository.listWorkspaceProjectionsScoped(principal, selection);
  if (!result.authenticated) throw workspaceUnauthorized();
  if (!result.accessible) throw new AppError({ code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,
    message: 'Care workspace resource not found.', statusCode: 404 });
  const items = result.items.slice(0, limit);
  let nextCursor: string | null = null;
  if (result.items.length > limit) {
    const last = items[items.length - 1];
    const payload = Buffer.from(JSON.stringify({ binding, afterId: last.id, afterCreatedAt: last.cursorCreatedAt })).toString('base64url');
    nextCursor = payload + '.' + sign(payload, secret);
  }
  return { items: items.map(toCustomerCarePublic), nextCursor, evaluatedAt: result.evaluatedAt.toISOString() };
}
