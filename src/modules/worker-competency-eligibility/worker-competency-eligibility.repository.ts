import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  CandidateCrewRow,
  CrewWorkerRow,
  ScopeJobTypeRow,
  WorkerCertificationRow,
  WorkerSkillRow,
} from './worker-competency-eligibility.types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — read-only eligibility queries.
 *
 * Every query here is a SELECT. The evaluator deliberately owns no authority:
 *   - the scope/request/catalog chain is READ from CR-HM-06/02/01 tables;
 *   - worker registration stays in `handyman_worker_contexts` /
 *     `handyman_crew_memberships` (CR-HM-04);
 *   - proficiency stays in `workforce_skill_assignments` (BE-03D2);
 *   - certificates stay in `workforce_certifications` (PART 01/02).
 *
 * Nothing is copied into a new table, so there is exactly one source of truth
 * per fact and a corrected certificate is picked up on the next evaluation.
 */

async function resolveScopeJobType(
  executor: Pick<PoolClient, 'query'> = getPool(),
  executionScopeId: string,
): Promise<ScopeJobTypeRow | null> {
  const result = await executor.query(
    `SELECT es.id            AS "executionScopeId",
            es.client_id     AS "clientId",
            es.building_id   AS "buildingId",
            sr.service_catalog_id AS "serviceCatalogId",
            sc.code          AS "serviceCatalogCode",
            sc.status        AS "serviceCatalogStatus"
       FROM handyman_execution_scopes es
       JOIN handyman_service_requests sr
         ON sr.id = es.handyman_request_id
        AND sr.client_id = es.client_id
       JOIN service_catalog sc
         ON sc.id = sr.service_catalog_id
        AND sc.client_id = es.client_id
      WHERE es.id = $1`,
    [executionScopeId],
  );
  return result.rows[0] ?? null;
}

/**
 * ACTIVE members of the given crews, with the current Lead flagged.
 * `isLead` is derived from the LATEST `handyman_crew_leads` row (CR-HM-04 F4),
 * so the flag can never disagree with the Lead resolver.
 */
async function listCrewWorkers(
  executor: Pick<PoolClient, 'query'> = getPool(),
  crewIds: string[],
): Promise<CrewWorkerRow[]> {
  if (crewIds.length === 0) return [];
  const result = await executor.query(
    `SELECT cm.handyman_crew_id            AS "crewId",
            wc.id                          AS "workerContextId",
            wc.workforce_profile_id        AS "workforceProfileId",
            fp.full_name                   AS "workforceProfileName",
            (lead.handyman_crew_membership_id = cm.id) AS "isLead"
       FROM handyman_crew_memberships cm
       JOIN handyman_worker_contexts wc
         ON wc.id = cm.handyman_worker_context_id
        AND wc.client_id = cm.client_id
       JOIN workforce_profiles fp ON fp.id = wc.workforce_profile_id
       LEFT JOIN LATERAL (
         SELECT cl.handyman_crew_membership_id
           FROM handyman_crew_leads cl
          WHERE cl.handyman_crew_id = cm.handyman_crew_id
          ORDER BY cl.lead_seq DESC
          LIMIT 1
       ) lead ON TRUE
      WHERE cm.handyman_crew_id = ANY($1::uuid[])
        AND cm.status = 'ACTIVE'
      ORDER BY cm.handyman_crew_id ASC, "isLead" DESC, fp.full_name ASC`,
    [crewIds],
  );
  return result.rows;
}

/**
 * Effective skill assignments (ACTIVE, inside their own validity window) for the
 * given profiles. Same window semantics as BE-03D2
 * `workforceSkillRepository.listEffectiveSkills`.
 */
async function listEffectiveSkills(
  executor: Pick<PoolClient, 'query'> = getPool(),
  workforceProfileIds: string[],
): Promise<WorkerSkillRow[]> {
  if (workforceProfileIds.length === 0) return [];
  const result = await executor.query(
    `SELECT wsa.workforce_profile_id AS "workforceProfileId",
            s.id                    AS "skillId",
            wsa.proficiency_level   AS "proficiencyLevel"
       FROM workforce_skill_assignments wsa
       JOIN skills s ON s.id = wsa.skill_id AND s.status = 'ACTIVE'
      WHERE wsa.workforce_profile_id = ANY($1::uuid[])
        AND wsa.status = 'ACTIVE'
        AND (wsa.valid_from IS NULL OR wsa.valid_from <= CURRENT_TIMESTAMP)
        AND (wsa.valid_until IS NULL OR wsa.valid_until >= CURRENT_TIMESTAMP)`,
    [workforceProfileIds],
  );
  return result.rows;
}

/**
 * Certificates of the given profiles inside one Client. Rows are returned
 * UNFILTERED (including expired/inactive/unverified ones) because the evaluator
 * has to explain WHY a certificate does not count.
 */
async function listCertificationsForProfiles(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  workforceProfileIds: string[],
): Promise<WorkerCertificationRow[]> {
  if (workforceProfileIds.length === 0) return [];
  const result = await executor.query(
    `SELECT wc.id                AS "id",
            wc.workforce_profile_id AS "workforceProfileId",
            wc.skill_id          AS "skillId",
            wc.certificate_number AS "certificateNumber",
            wc.certificate_name  AS "certificateName",
            wc.issuing_authority AS "issuingAuthority",
            wc.issue_date        AS "issueDate",
            wc.expiry_date       AS "expiryDate",
            wc.status            AS "status",
            wc.verification_status AS "verificationStatus"
       FROM workforce_certifications wc
      WHERE wc.client_id = $1
        AND wc.workforce_profile_id = ANY($2::uuid[])
      ORDER BY wc.issue_date DESC`,
    [clientId, workforceProfileIds],
  );
  return result.rows;
}

/**
 * ACTIVE crews of the same Client whose provider context is ACTIVE — the
 * candidate pool for the "qualified candidates" read model. Building placement
 * and Lead validity are NOT evaluated here (the assignment authority owns
 * them); competency is the added dimension.
 */
async function listCandidateCrews(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
): Promise<CandidateCrewRow[]> {
  const result = await executor.query(
    `SELECT c.id   AS "crewId",
            c.code AS "crewCode",
            c.name AS "crewName",
            pc.id  AS "providerContextId",
            pc.status AS "providerContextStatus"
       FROM handyman_work_crews c
       JOIN handyman_provider_contexts pc
         ON pc.id = c.handyman_provider_context_id
        AND pc.client_id = c.client_id
      WHERE c.client_id = $1
        AND c.status = 'ACTIVE'
        AND pc.status = 'ACTIVE'
      ORDER BY c.code ASC`,
    [clientId],
  );
  return result.rows;
}

export const workerCompetencyEligibilityRepository = {
  listCandidateCrews,
  listCertificationsForProfiles,
  listCrewWorkers,
  listEffectiveSkills,
  resolveScopeJobType,
};
