import type {PoolClient} from 'pg';
import {getPool} from '../../database';
import {handymanCrewLeadInvalidError} from './handyman-work-crew.errors';
import {handymanWorkforceBindingRequiredError} from './handyman-worker-context.errors';

/** Read-only admission over existing registration and operational placement.
 * User Building access and workforce Building placement are independent.
 * Helpers may lack a login, but never a registered ACTIVE person/context.
 * No skills, delegation, booking, onboarding or new status authority.
 */
export async function findEligibleHandymanWorker(
  executor: Pick<PoolClient, 'query'> | undefined,
  input: {
    clientId: string;
    buildingId: string;
    workerContextId?: string;
    userId?: string;
    providerContextId?: string;
    requireLogin: boolean;
  },
): Promise<{workerContextId: string; userId: string | null} | null> {
  if (!input.workerContextId && !input.userId) {
    throw new TypeError('Worker admission requires an existing identity reference.');
  }
  const result = await (executor ?? getPool()).query<{
    workerContextId: string; userId: string | null;
  }>(`
    SELECT wc.id AS "workerContextId", fp.user_id AS "userId"
    FROM handyman_worker_contexts wc
    JOIN handyman_provider_contexts pc ON pc.id=wc.handyman_provider_context_id
      AND pc.client_id=wc.client_id AND pc.status='ACTIVE'
    JOIN vendors v ON v.id=pc.vendor_id AND v.client_id=pc.client_id AND v.status='ACTIVE'
    JOIN workforce_profiles fp ON fp.id=wc.workforce_profile_id
      AND fp.status='ACTIVE' AND fp.workforce_type='EXTERNAL'
    JOIN organizations o ON o.id=fp.organization_id AND o.client_id=wc.client_id
    LEFT JOIN users u ON u.id=fp.user_id
    WHERE wc.client_id=$1 AND wc.status='ACTIVE'
      AND ($3::uuid IS NULL OR wc.id=$3)
      AND ($4::uuid IS NULL OR fp.user_id=$4)
      AND ($6::uuid IS NULL OR pc.id=$6)
      AND (fp.user_id IS NULL OR u.status='ACTIVE')
      AND (NOT $5::boolean OR (fp.user_id IS NOT NULL AND u.status='ACTIVE'
        AND EXISTS (SELECT 1 FROM user_building_assignments access
          WHERE access.user_id=fp.user_id AND access.building_id=$2 AND access.status='ACTIVE')))
      AND EXISTS (
        SELECT 1 FROM vendor_workforce_bindings binding
        WHERE binding.vendor_id=pc.vendor_id AND binding.workforce_profile_id=fp.id
          AND binding.status='ACTIVE'
          AND (binding.effective_from IS NULL OR binding.effective_from<=CURRENT_TIMESTAMP)
          AND (binding.effective_until IS NULL OR binding.effective_until>CURRENT_TIMESTAMP)
      )
      AND EXISTS (
        SELECT 1 FROM workforce_building_assignments placement
        JOIN buildings b ON b.id=placement.building_id AND b.status='ACTIVE'
        JOIN properties p ON p.id=b.property_id AND p.client_id=wc.client_id
        WHERE placement.workforce_profile_id=fp.id AND placement.building_id=$2
          AND placement.status='ACTIVE'
          AND (placement.effective_from IS NULL OR placement.effective_from<=CURRENT_TIMESTAMP)
          AND (placement.effective_until IS NULL OR placement.effective_until>=CURRENT_TIMESTAMP)
      )
    LIMIT 1`, [input.clientId, input.buildingId, input.workerContextId ?? null,
    input.userId ?? null, input.requireLogin, input.providerContextId ?? null]);
  return result.rows[0] ?? null;
}

/** Revalidate every ACTIVE member; an invalid latest Lead never falls back.
 * Membership alone is not current registration, nor Building placement.
 */
export async function assertHandymanCrewWorkerEligibility(
  executor: Pick<PoolClient, 'query'> | undefined,
  input: {clientId: string; buildingId: string; crewId: string},
): Promise<void> {
  const db = executor ?? getPool();
  const members = await db.query<{
    membershipId: string; workerContextId: string; clientId: string;
    providerContextId: string; leadMembershipId: string;
  }>(`
    SELECT cm.id AS "membershipId", cm.handyman_worker_context_id AS "workerContextId",
      cm.client_id AS "clientId", crew.handyman_provider_context_id AS "providerContextId",
      lead.handyman_crew_membership_id AS "leadMembershipId"
    FROM handyman_work_crews crew
    JOIN LATERAL (
      SELECT cl.handyman_crew_membership_id, cl.client_id
      FROM handyman_crew_leads cl WHERE cl.handyman_crew_id=crew.id
      ORDER BY cl.lead_seq DESC LIMIT 1
    ) lead ON lead.client_id=crew.client_id
    JOIN handyman_crew_memberships cm ON cm.handyman_crew_id=crew.id AND cm.status='ACTIVE'
    WHERE crew.id=$1 AND crew.client_id=$2 AND crew.status='ACTIVE'`,
  [input.crewId,input.clientId]);
  if (!members.rows.length || !members.rows.some(member => member.membershipId===member.leadMembershipId)) {
    throw handymanCrewLeadInvalidError();
  }
  for (const member of members.rows) {
    if (member.clientId!==input.clientId || !await findEligibleHandymanWorker(db, {
      clientId: input.clientId, buildingId: input.buildingId,
      workerContextId: member.workerContextId, providerContextId: member.providerContextId,
      requireLogin: member.membershipId===member.leadMembershipId,
    })) {
      throw handymanWorkforceBindingRequiredError();
    }
  }
}
