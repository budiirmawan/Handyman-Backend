import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { readHandoffIntegrationSecret } from '../handyman-handoff/handoff-runtime.config';
import { handoffRuntimeRepository } from '../handyman-handoff/handoff-runtime.repository';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from './care-workspace.service';
import { handymanCareCatalogueRepository, type CatalogueSelection, type CareCatalogueProfile } from '../handyman-catalog/handyman-care-catalogue.repository';
import { projectHandymanMaterialReferencePrice } from '../handyman-catalog/handyman-common-material-profile.service';
import type { HandymanMaterialReferencePrice } from '../handyman-catalog/handyman-common-material-profile.types';
import { isPriceCatalogCurrency } from '../price-catalog-entries/price-catalog-entry.types';
import { resolveAuthorizedPriceCatalogEntry } from '../price-catalog-entries/price-catalog-lookup.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => AppError.validation('Invalid care catalogue query.');
const notFound = () => new AppError({ code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,
  message: 'Care workspace resource not found.', statusCode: 404 });
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}
function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update('HANDYMAN_CARE_CATALOGUE_CURSOR_V1\0' + payload).digest('base64url');
}

/** Care auth adapter only. Eligibility is read from the catalogue domain;
 * pricing is composed by the existing resolver, never in HTTP transport. */
export async function readCareWorkspaceCatalogue(token: string, propertyInput: unknown,
  kind: 'services' | 'profiles', query: unknown, profileInput?: unknown, body?: unknown) {
  const principal = await resolveCareWorkspacePrincipal(token);
  const propertyId = uuid(propertyInput);
  const profileId = profileInput === undefined ? null : uuid(profileInput);
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length))) throw invalid();
  const q = query as Record<string, unknown>;
  const allowed = profileId ? ['buildingId', 'currency', 'serviceVariantId'] :
    kind === 'services' ? ['limit', 'cursor', 'q', 'buildingId'] : ['limit', 'cursor', 'serviceCatalogId', 'serviceVariantId'];
  if (Object.keys(q).some(k => !allowed.includes(k))) throw invalid();
  const limit = q.limit === undefined ? 25 : typeof q.limit === 'string' && /^[1-9]\d{0,2}$/.test(q.limit) ? Number(q.limit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  if (q.q !== undefined && (typeof q.q !== 'string' || !q.q.trim().length || q.q.trim().length > 100 || q.q.includes('\0'))) throw invalid();
  const selection: CatalogueSelection = { kind, profileId, afterId: null, limit: profileId ? 1 : limit,
    q: typeof q.q === 'string' ? q.q.trim() : null,
    serviceCatalogId: q.serviceCatalogId === undefined ? null : uuid(q.serviceCatalogId),
    serviceVariantId: q.serviceVariantId === undefined ? null : uuid(q.serviceVariantId),
    buildingId: q.buildingId === undefined ? null : uuid(q.buildingId) };
  const currency = typeof q.currency === 'string' ? q.currency.trim().toUpperCase() : undefined;
  if (q.currency !== undefined && (!isPriceCatalogCurrency(currency) || !selection.buildingId)) throw invalid();
  const integration = await handoffRuntimeRepository.findIntegrationById(principal.integrationId);
  if (!integration) throw workspaceUnauthorized();
  const secret = readHandoffIntegrationSecret(integration.integrationCode);
  if (!secret) throw AppError.internal('Workspace pagination is unavailable.');
  const binding = JSON.stringify({ v: 1, sessionId: principal.sessionId, careActorId: principal.careActorId,
    integrationId: principal.integrationId, propertyId, ...selection, order: 'id:asc', expiresAt: principal.expiresAt });
  if (q.cursor !== undefined) {
    if (typeof q.cursor !== 'string' || q.cursor.length > 2048) throw invalid();
    const parts = q.cursor.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]) ||
        !timingSafeEqual(Buffer.from(sign(parts[0], secret)), Buffer.from(parts[1]))) throw invalid();
    try {
      const decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (decoded.binding !== binding || Date.parse(principal.expiresAt) <= Date.now()) throw invalid();
      selection.afterId = uuid(decoded.afterId);
    } catch { throw invalid(); }
  }
  const result = await handymanCareCatalogueRepository.readCatalogue(principal, propertyId, selection);
  if (!result.authenticated) throw workspaceUnauthorized();
  if (!result.accessible) throw notFound();
  if (profileId) {
    const profile = result.items[0] as CareCatalogueProfile;
    let referencePrice: HandymanMaterialReferencePrice | null = null;
    if (selection.buildingId && isPriceCatalogCurrency(currency) && profile.item.uomId && result.clientId) {
      referencePrice = projectHandymanMaterialReferencePrice(await resolveAuthorizedPriceCatalogEntry({
        sourceMode: 'MATERIAL', itemId: profile.inventoryItemId, uomId: profile.item.uomId,
        buildingId: selection.buildingId, currency, asOf: result.evaluatedAt.toISOString(),
      }, result.clientId, null));
    }
    // Price lookup may await multiple DB reads. Revalidate actor/session/grant,
    // active references and exact profile/UOM binding before releasing its result.
    const current = await handymanCareCatalogueRepository.readCatalogue(principal, propertyId, selection);
    if (!current.authenticated) throw workspaceUnauthorized();
    if (!current.accessible || current.clientId !== result.clientId ||
        JSON.stringify(current.items[0]) !== JSON.stringify(profile)) throw notFound();
    return { ...profile, referencePrice, evaluatedAt: result.evaluatedAt.toISOString() };
  }
  const items = result.items.slice(0, limit);
  let nextCursor: string | null = null;
  if (result.items.length > limit) {
    const payload = Buffer.from(JSON.stringify({ binding, afterId: items[items.length - 1].id })).toString('base64url');
    nextCursor = payload + '.' + sign(payload, secret);
  }
  return { items, nextCursor, evaluatedAt: result.evaluatedAt.toISOString() };
}
