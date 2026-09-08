import { getPool } from '../../database';
import type {
  IncidentReadinessFacts,
  InvestigationReadinessFilters,
} from './investigation-readiness.types';

/**
 * BE-21F reads facts and writes NOTHING.
 *
 * There is no create, update, or delete in this module and no table of its
 * own — readiness is computed, so there is nothing to persist. The repository
 * exists only to gather, in a single query, the facts the rules need.
 */

/**
 * The fact-gathering projection.
 *
 * `hasTypeDetail` resolves the BE-21B/C/D row that MATCHES the discriminator,
 * so an Incident cannot be considered prepared because some unrelated
 * specialization happens to exist. The immediate action counts are aggregated
 * in SQL rather than by loading rows: readiness needs the counts, not the
 * actions themselves, and listing readiness across a Building must not become
 * one query per Incident.
 *
 * NULLIF(TRIM(...), '') is what makes `hasDescription` mean "has an actual
 * account" rather than "the column is non-null" — a whitespace description
 * would otherwise satisfy the rule while telling an investigator nothing.
 */
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
  (NULLIF(TRIM(COALESCE(i.description, '')), '') IS NOT NULL) AS "hasDescription",
  (
    CASE i.incident_type
      WHEN 'OPERATIONAL' THEN EXISTS (
        SELECT 1 FROM operational_incidents oi WHERE oi.incident_id = i.id
      )
      WHEN 'ASSET_FAILURE' THEN EXISTS (
        SELECT 1 FROM asset_failure_incidents af WHERE af.incident_id = i.id
      )
      WHEN 'FINDING_ESCALATION' THEN EXISTS (
        SELECT 1 FROM finding_escalation_incidents fe WHERE fe.incident_id = i.id
      )
      ELSE FALSE
    END
  ) AS "hasTypeDetail",
  COALESCE(ia.total, 0)::int AS "immediateActionCount",
  COALESCE(ia.unsettled, 0)::int AS "unsettledImmediateActionCount",
  COALESCE(ia.completed, 0)::int AS "completedImmediateActionCount"
`;

const FROM = `
  FROM incidents i
  LEFT JOIN (
    SELECT
      incident_id,
      COUNT(*) AS total,
      COUNT(*) FILTER (
        WHERE status IN ('PLANNED', 'IN_PROGRESS')
      ) AS unsettled,
      COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed
    FROM immediate_actions
    GROUP BY incident_id
  ) ia ON ia.incident_id = i.id
`;

/** Gathers facts for one Incident. Returns null if the Incident is unknown. */
async function findFactsByIncidentId(
  incidentId: string,
): Promise<IncidentReadinessFacts | null> {
  const result = await getPool().query<IncidentReadinessFacts>(
    `SELECT ${SELECT} ${FROM} WHERE i.id = $1`,
    [incidentId],
  );
  return result.rows[0] ?? null;
}

/**
 * Gathers facts for every accessible Incident in ONE query.
 *
 * Isolation is applied in SQL, so an Incident outside the caller's Buildings
 * is never evaluated — readiness is not computed and then filtered away.
 * The `ready` filter cannot live here: it is a property of the computed
 * verdict, not of any column, and the service applies it after evaluation.
 */
async function listFacts(
  filters: InvestigationReadinessFilters,
  accessibleBuildingIds: string[],
): Promise<IncidentReadinessFacts[]> {
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

  const result = await getPool().query<IncidentReadinessFacts>(
    `SELECT ${SELECT} ${FROM}
     WHERE ${conditions.join(' AND ')}
     ORDER BY i.reported_at DESC, i.id DESC`,
    values,
  );
  return result.rows;
}

export const investigationReadinessRepository = {
  findFactsByIncidentId,
  listFacts,
};
