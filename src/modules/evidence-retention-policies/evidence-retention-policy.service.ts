import { AppError } from '../../shared/errors';
import { clientInactiveError, clientNotFoundError, clientRepository } from '../clients';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { resolveBuildingConfigurationContext } from '../building-configurations/building-configuration.service';
import { recordOperationalEvent } from '../operational-events';
import { evidenceRetentionPolicyRepository } from './evidence-retention-policy.repository';
import type {
  CreateEvidenceRetentionPolicyInput,
  EvidenceRetentionPolicyFilters,
  EvidenceRetentionPolicyRecord,
  PublicEvidenceRetentionPolicy,
  UpdateEvidenceRetentionPolicyInput,
} from './evidence-retention-policy.types';

/**
 * CR-BE-DOC-CONTROL-01 PART 03 — retention policy administration.
 *
 * Mirrors the SLA-definition service exactly: Client existence/access +
 * ACTIVE check, Building-to-Client hierarchy validation via the existing
 * building-configuration context resolver, and the BE-02G accessible scope.
 * Policy CRUD is audited via operational events (policies are configuration
 * whose later edits never rewrite governed evidence history — §6).
 */

const pub = (r: EvidenceRetentionPolicyRecord): PublicEvidenceRetentionPolicy => ({
  ...r,
  effectiveFrom: r.effectiveFrom.toISOString(),
  effectiveTo: r.effectiveTo?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

async function assertClient(userId: string, clientId: string) {
  const client = await clientRepository.findById(clientId);
  if (!client) throw clientNotFoundError();
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
  return client;
}

async function create(
  input: CreateEvidenceRetentionPolicyInput,
  userId: string,
): Promise<PublicEvidenceRetentionPolicy> {
  const client = await assertClient(userId, input.clientId);
  if (client.status !== 'ACTIVE') throw clientInactiveError();
  if (input.buildingId) {
    const context = await resolveBuildingConfigurationContext(input.buildingId, userId);
    if (context.clientId !== input.clientId) throw buildingAccessDeniedError();
  }
  try {
    const created = await evidenceRetentionPolicyRepository.create(input);
    await recordOperationalEvent({
      clientId: created.clientId,
      buildingId: created.buildingId,
      eventType: 'EVIDENCE_RETENTION_POLICY_CREATED',
      entityType: 'EVIDENCE_RETENTION_POLICY',
      entityId: created.id,
      actorUserId: userId,
      summary: `Evidence retention policy ${created.code} created`,
      metadata: {
        policyId: created.id,
        code: created.code,
        buildingId: created.buildingId,
        evidenceType: created.evidenceType,
        executionType: created.executionType,
        retentionDays: created.retentionDays,
        status: created.status,
      },
    });
    return pub(created);
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') {
      throw new AppError({
        code: 'BAD_REQUEST',
        message: 'An evidence retention policy with this code already exists for the client.',
        statusCode: 409,
      });
    }
    throw error;
  }
}

async function list(
  clientId: string,
  filters: EvidenceRetentionPolicyFilters,
  userId: string,
): Promise<PublicEvidenceRetentionPolicy[]> {
  await assertClient(userId, clientId);
  if (filters.buildingId) {
    const context = await resolveBuildingConfigurationContext(filters.buildingId, userId);
    if (context.clientId !== clientId) throw buildingAccessDeniedError();
  }
  return (await evidenceRetentionPolicyRepository.list(clientId, filters)).map(pub);
}

async function get(id: string, userId: string): Promise<PublicEvidenceRetentionPolicy> {
  const record = await evidenceRetentionPolicyRepository.findById(id);
  if (!record) throw AppError.notFound('Evidence retention policy not found.');
  if (record.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  } else {
    await assertClient(userId, record.clientId);
  }
  return pub(record);
}

async function update(
  id: string,
  input: UpdateEvidenceRetentionPolicyInput,
  userId: string,
): Promise<PublicEvidenceRetentionPolicy> {
  const record = await evidenceRetentionPolicyRepository.findById(id);
  if (!record) throw AppError.notFound('Evidence retention policy not found.');
  if (record.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  } else {
    await assertClient(userId, record.clientId);
  }

  const from = new Date(input.effectiveFrom ?? record.effectiveFrom);
  const to = Object.prototype.hasOwnProperty.call(input, 'effectiveTo')
    ? (input.effectiveTo ? new Date(input.effectiveTo) : null)
    : record.effectiveTo;
  if (to && to <= from) {
    throw AppError.validation('Request validation failed.', [
      { field: 'effectiveTo', message: 'effectiveTo must be later than effectiveFrom.' },
    ]);
  }

  const updated = (await evidenceRetentionPolicyRepository.update(id, input))!;
  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    eventType: 'EVIDENCE_RETENTION_POLICY_UPDATED',
    entityType: 'EVIDENCE_RETENTION_POLICY',
    entityId: updated.id,
    actorUserId: userId,
    summary: `Evidence retention policy ${updated.code} updated`,
    metadata: {
      policyId: updated.id,
      code: updated.code,
      changedFields: Object.keys(input),
      retentionDays: updated.retentionDays,
      status: updated.status,
    },
  });
  return pub(updated);
}

export const evidenceRetentionPolicyService = { create, list, get, update };
