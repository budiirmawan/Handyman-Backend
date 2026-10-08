import { createHash, randomUUID } from 'node:crypto';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { resolveHandoffContext } from '../handyman-handoff/handoff-context.service';
import { isCurrentCareRepresentation } from '../handyman-handoff/care-representation.service';
import { generateHandoffExchangeToken, hashHandoffExchangeToken } from '../handyman-handoff/handoff-runtime.crypto';
import { readHandoffRuntimeConfig } from '../handyman-handoff/handoff-runtime.config';
import { handoffRuntimeRepository } from '../handyman-handoff/handoff-runtime.repository';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from './care-workspace.service';
import { careCreateContextNotFound, lockCareCreateWorkspaceScope } from './care-create-exchange.scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw AppError.validation('Invalid care create-exchange selection.');
  return value.toLowerCase();
}

/** Issue a fresh, server-attested representation using the already attested
 * workspace principal. No BM secret/signature is fabricated, no PIC/User
 * linkage is accepted, and no attribution or request is created here. */
export async function issueCareCreateExchange(token: string, propertyInput: unknown, body: unknown, query: unknown = {}) {
  const principal = await resolveCareWorkspacePrincipal(token);
  const propertyId = id(propertyInput);
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(k => !['tenantCompanyId', 'buildingId', 'spaceId'].includes(k)) ||
      !query || typeof query !== 'object' || Object.keys(query).length) {
    throw AppError.validation('Invalid care create-exchange selection.');
  }
  const fields = body as Record<string, unknown>;
  const selection = { tenantCompanyId: id(fields.tenantCompanyId), buildingId: id(fields.buildingId),
    ...(fields.spaceId === undefined ? {} : { spaceId: id(fields.spaceId) }) };
  let resolved;
  try { resolved = await resolveHandoffContext(selection); }
  catch (error) { if (error instanceof AppError) throw careCreateContextNotFound(); throw error; }
  return withTransaction(async tx => {
    const scope = await lockCareCreateWorkspaceScope(tx, { ...principal, ...selection, propertyId, spaceId: selection.spaceId ?? null });
    if (scope.clientId !== resolved.clientId) throw careCreateContextNotFound();
    const actor = { actorType: 'CUSTOMER_CARE' as const, careActorId: principal.careActorId,
      integrationId: principal.integrationId, integrationCode: scope.integrationCode, actorReference: scope.actorReference };
    const snapshot = { ...resolved, actorType: actor.actorType, careActorId: actor.careActorId, actorReference: actor.actorReference };
    if (!(await isCurrentCareRepresentation(snapshot, tx))) throw careCreateContextNotFound();
    const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const now = clock.rows[0].now;
    if (scope.expiresAt <= now) throw workspaceUnauthorized();
    const ttlSeconds = Math.min(120, readHandoffRuntimeConfig().exchangeTtlSeconds);
    const expiresAt = new Date(Math.min(scope.expiresAt.getTime(), now.getTime() + ttlSeconds * 1000));
    const exchangeToken = generateHandoffExchangeToken();
    // Existing append-only assertion table records a server issuance receipt,
    // not a new externally signed assertion. Its reference preserves workspace
    // lineage for existing BM_SUPER_APP attribution binding, without raw tokens.
    const assertionId = `workspace-create:${principal.sessionId}:${randomUUID()}`;
    const receipt = await handoffRuntimeRepository.insertAssertion({ integrationId: principal.integrationId,
      assertionId, assertionHash: createHash('sha256').update(stableJson({ purpose: 'CARE_CREATE',
        workspaceSessionId: principal.sessionId, propertyId, context: snapshot,
        originChannel: 'BM_SUPER_APP', assertionId, expiresAt: expiresAt.toISOString() })).digest('hex'), expiresAt }, tx);
    await handoffRuntimeRepository.createExchange({ integrationId: principal.integrationId, handoffAssertionId: receipt.id,
      tokenHash: hashHandoffExchangeToken(exchangeToken), context: resolved, actor, expiresAt,
      purpose: 'CARE_CREATE', workspaceSessionId: principal.sessionId, carePropertyId: propertyId }, tx);
    return { exchangeToken, expiresAt: expiresAt.toISOString(),
      context: { ...snapshot, propertyId, originChannel: 'BM_SUPER_APP' as const } };
  });
}
