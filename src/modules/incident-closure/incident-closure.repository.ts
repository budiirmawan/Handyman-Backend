import { getPool } from '../../database';
import type {
  IncidentClosureFacts,
  IncidentClosureFilters,
} from './incident-closure.types';

/**
 * BE-21K reads facts and writes NOTHING.
 *
 * Closure readiness is computed, so there is nothing to persist and this
 * module owns no table. The actual closing write lives on
 * `incidentRepository.closeReported`, because closure is a state change of
 * the BE-21A Incident — keeping that write in the foundation avoids a second
 * place that can move an Incident's status.
 *
 * THE LATEST-VERIFICATION SUBQUERY
 * --------------------------------
 * The interesting part below is `latest_decision`. A corrective action may
 * have MANY verifications over time — BE-21J deliberately preserves every
 * attempt rather than replacing them — so "the verification decision" is
 * always the most recent COMPLETED one. `DISTINCT ON (target_id) ... ORDER BY
 * target_id, reviewed_at DESC` collapses that history to exactly one row per
 * action.
 *
 * Getting this wrong in the obvious way — aggregating over ALL verifications
 * — would mean an action that was sent back for rework and then successfully
 * re-verified would still count as REWORK_REQUIRED forever, permanently
 * blocking closure of a genuinely resolved Incident.
 *
 * This join is the SINGLE mechanism enforcing that. An earlier draft also
 * filtered the rework and rejected counts on `ca.status <> 'VERIFIED'`, which
 * looked like harmless defence-in-depth but was worse than useless: it made
 * the superseded-history bug invisible to tests while leaving it live in
 * every case where the newer decision was not APPROVED (rework, then redone,
 * then REJECTED would still be reported as "needs rework"). One mechanism
 * that is exercised beats two where the redundant one hides the real one.
 */

/**
 * Required corrective actions are those still representing a live obligation.
 *
 * REJECTED (the proposal was refused) and CANCELLED (approved work called
 * off) are excluded: neither is work anyone still owes, and counting them
 * would make an Incident with one abandoned proposal impossible to close.
 */
const REQUIRED_ACTION_FILTER = `ca.status NOT IN ('REJECTED', 'CANCELLED')`;

const SELECT = `
  i.id AS "incidentId",
  i.client_id AS "clientId",
  i.building_id AS "buildingId",
  i.incident_number AS "incidentNumber",
  i.incident_type AS "incidentType",
  i.title,
  i.severity,
  i.priority,
  i.status,
  i.reported_at AS "reportedAt",
  i.closed_at AS "closedAt",
  i.closed_by_user_id AS "closedByUserId",
  i.closure_notes AS "closureNotes",
  COALESCE(ca.required, 0)::int AS "requiredActionCount",
  COALESCE(ca.unresolved, 0)::int AS "unresolvedActionCount",
  COALESCE(ca.unverified, 0)::int AS "unverifiedActionCount",
  COALESCE(ca.verified, 0)::int AS "verifiedActionCount",
  COALESCE(ca.rework, 0)::int AS "reworkRequiredCount",
  COALESCE(ca.rejected_verification, 0)::int AS "rejectedVerificationCount",
  COALESCE(ca.pending_verification, 0)::int AS "pendingVerificationCount"
`;

/**
 * One aggregate per Incident over its corrective actions, each already joined
 * to its single latest decision and its open-verification flag.
 */
const FROM = `
  FROM incidents i
  LEFT JOIN (
    SELECT
      ca.incident_id,
      COUNT(*) AS required,
      COUNT(*) FILTER (
        WHERE ca.status IN ('PROPOSED', 'APPROVED', 'IN_PROGRESS')
      ) AS unresolved,
      COUNT(*) FILTER (WHERE ca.status = 'COMPLETED') AS unverified,
      COUNT(*) FILTER (WHERE ca.status = 'VERIFIED') AS verified,
      COUNT(*) FILTER (WHERE latest.decision = 'REWORK_REQUIRED') AS rework,
      COUNT(*) FILTER (WHERE latest.decision = 'REJECTED')
        AS rejected_verification,
      COUNT(*) FILTER (WHERE pending.target_id IS NOT NULL) AS pending_verification
    FROM corrective_actions ca
    LEFT JOIN (
      SELECT DISTINCT ON (r.target_id) r.target_id, r.decision
      FROM reviews r
      WHERE r.target_type = 'CORRECTIVE_ACTION' AND r.status = 'COMPLETED'
      ORDER BY r.target_id, r.reviewed_at DESC, r.id DESC
    ) latest ON latest.target_id = ca.id
    LEFT JOIN (
      SELECT DISTINCT r.target_id
      FROM reviews r
      WHERE r.target_type = 'CORRECTIVE_ACTION' AND r.status = 'PENDING'
    ) pending ON pending.target_id = ca.id
    WHERE ${REQUIRED_ACTION_FILTER}
    GROUP BY ca.incident_id
  ) ca ON ca.incident_id = i.id
`;

export async function findFactsByIncidentId(
  incidentId: string,
): Promise<IncidentClosureFacts | null> {
  const result = await getPool().query<IncidentClosureFacts>(
    `SELECT ${SELECT} ${FROM} WHERE i.id = $1`,
    [incidentId],
  );
  return result.rows[0] ?? null;
}

/** Always constrained to the caller's accessible Buildings in SQL. */
export async function listFacts(
  filters: IncidentClosureFilters,
  accessibleBuildingIds: string[],
): Promise<IncidentClosureFacts[]> {
  if (accessibleBuildingIds.length === 0) return [];

  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['i.building_id = ANY($1::uuid[])'];

  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`i.building_id = $${values.length}`);
  }
  if (filters.incidentType) {
    values.push(filters.incidentType);
    conditions.push(`i.incident_type = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`i.status = $${values.length}`);
  }

  const result = await getPool().query<IncidentClosureFacts>(
    `SELECT ${SELECT} ${FROM}
     WHERE ${conditions.join(' AND ')}
     ORDER BY i.reported_at DESC, i.id DESC`,
    values,
  );
  return result.rows;
}

export const incidentClosureRepository = {
  findFactsByIncidentId,
  listFacts,
};
