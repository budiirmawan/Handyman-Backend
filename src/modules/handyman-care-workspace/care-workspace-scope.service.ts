import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { readHandoffIntegrationSecret } from '../handyman-handoff/handoff-runtime.config';
import { handoffRuntimeRepository } from '../handyman-handoff/handoff-runtime.repository';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from './care-workspace.service';
import { careWorkspaceSpacesRepository } from './care-workspace-spaces.repository';
import { careWorkspaceTenantsRepository } from './care-workspace-tenants.repository';
import { careWorkspaceScopeRepository } from './care-workspace-scope.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => AppError.validation('Invalid care workspace scope query.');

function parseQuery(query: unknown, searchable: boolean) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw invalid();
  const q = query as Record<string, unknown>;
  if (Object.keys(q).some(k => !(searchable ? ['limit', 'cursor', 'q', 'buildingId'] : ['limit', 'cursor']).includes(k))) throw invalid();
  const limit = q.limit === undefined ? 25 :
    typeof q.limit === 'string' && /^[1-9]\d{0,2}$/.test(q.limit) ? Number(q.limit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  if (q.cursor !== undefined && (typeof q.cursor !== 'string' || !q.cursor.length || q.cursor.length > 2048)) throw invalid();
  if (q.q !== undefined && (typeof q.q !== 'string' || !q.q.trim().length || q.q.trim().length > 100 || q.q.includes('\0'))) throw invalid();
  if (q.buildingId !== undefined && (typeof q.buildingId !== 'string' || !UUID.test(q.buildingId))) throw invalid();
  return { limit, cursor: q.cursor as string | undefined,
    search: typeof q.q === 'string' ? q.q.trim() : null,
    buildingId: typeof q.buildingId === 'string' ? q.buildingId.toLowerCase() : null };
}

/** Cursor is an opaque-to-consumers, server-MACed keyset handle, never an
 * authority credential. It contains no token/hash, grant history or counts.
 * The signing key is server-held integration secret material, NOT the bearer
 * token known to the caller. Scope, session, actor, limit and expiry are bound. */
function mac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update('HANDYMAN_CARE_SCOPE_CURSOR_V1\0' + payload).digest('base64url');
}

async function listWorkspaceCollection(token: string, query: unknown, propertyInput: unknown, body: unknown, collection: 'scope' | 'tenants' | 'spaces') {
  const principal = await resolveCareWorkspacePrincipal(token);
  const searchable = collection !== 'scope';
  const { limit, cursor, search, buildingId } = parseQuery(query, searchable);
  if (searchable && propertyInput === undefined) throw invalid();
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) throw invalid();
  if (propertyInput !== undefined && (typeof propertyInput !== 'string' || !UUID.test(propertyInput))) throw invalid();
  const propertyId = typeof propertyInput === 'string' ? propertyInput.toLowerCase() : null;
  const integration = await handoffRuntimeRepository.findIntegrationById(principal.integrationId);
  if (!integration) throw workspaceUnauthorized();
  const secret = readHandoffIntegrationSecret(integration.integrationCode);
  if (!secret) throw AppError.internal('Workspace pagination is unavailable.');
  const binding = JSON.stringify({ v: 1, sessionId: principal.sessionId, careActorId: principal.careActorId,
    integrationId: principal.integrationId, route: collection === 'spaces' ? 'spaces' : collection === 'tenants' ? 'tenant-companies' : propertyId ? 'buildings' : 'properties', propertyId,
    ...(searchable ? { q: search, buildingId } : {}),
    limit, order: 'id:asc', expiresAt: principal.expiresAt });
  let afterId: string | null = null;
  if (cursor !== undefined) {
    const parts = cursor.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw invalid();
    const expected = mac(parts[0], secret);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]))) throw invalid();
    try {
      const decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (decoded.binding !== binding || typeof decoded.afterId !== 'string' || !UUID.test(decoded.afterId) ||
          Date.parse(principal.expiresAt) <= Date.now()) throw invalid();
      afterId = decoded.afterId;
    } catch { throw invalid(); }
  }
  const result = collection === 'spaces'
    ? await careWorkspaceSpacesRepository.readSpaces(principal, propertyId!, afterId, limit, search, buildingId)
    : collection === 'tenants'
    ? await careWorkspaceTenantsRepository.readTenants(principal, propertyId!, afterId, limit, search, buildingId)
    : await careWorkspaceScopeRepository.readScope(principal, propertyId, afterId, limit);
  if (!result.authenticated) throw workspaceUnauthorized();
  if (!result.accessible) throw new AppError({ code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,
    message: 'Care workspace resource not found.', statusCode: 404 });
  const items = result.items.slice(0, limit);
  let nextCursor: string | null = null;
  if (result.items.length > limit) {
    const payload = Buffer.from(JSON.stringify({ binding, afterId: items[items.length - 1].id })).toString('base64url');
    nextCursor = payload + '.' + mac(payload, secret);
  }
  return { items, nextCursor, evaluatedAt: result.evaluatedAt.toISOString() };
}

/** Existing property/building reads retain their closed query/cursor contracts. */
export function listCareWorkspaceScope(token: string, query: unknown, propertyInput?: unknown, body?: unknown) {
  return listWorkspaceCollection(token, query, propertyInput, body, 'scope');
}

export function listCareWorkspaceTenants(token: string, query: unknown, propertyInput: unknown, body?: unknown) {
  return listWorkspaceCollection(token, query, propertyInput, body, 'tenants');
}

export function listCareWorkspaceSpaces(token: string, query: unknown, propertyInput: unknown, body?: unknown) {
  return listWorkspaceCollection(token, query, propertyInput, body, 'spaces');
}
