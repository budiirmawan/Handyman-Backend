import { getPool } from '../../database';
import type { FindingAssigneeType } from '../finding-assignments';
import type { FindingStatus } from '../findings';
import { SECURITY_OUTSTANDING_FINDING_STATUSES } from '../security-finding-incident-kpi';
import type { ManagementCriticalFindingItem } from './management-critical-findings.types';

type CriticalFindingRow = {
  finding_id: string;
  client_id: string;
  building_id: string;
  finding_number: string;
  title: string;
  severity_id: string;
  severity_code: string;
  severity_name: string;
  severity_rank: number;
  source_type: string | null;
  source_id: string | null;
  context_type: ManagementCriticalFindingItem['context']['type'];
  context_id: string | null;
  status: FindingStatus;
  assignee_type: FindingAssigneeType | null;
  workforce_profile_id: string | null;
  team_id: string | null;
  vendor_id: string | null;
  reported_at: Date;
  overdue: boolean;
};

/**
 * BE-24 PART 03B direct read over BE-09 Findings and their existing context /
 * assignment bindings. Critical selection uses Client-configured severity rank;
 * outstanding status semantics are reused from BE-23F2.
 */
export async function listCriticalFindings(
  buildingIds: string[],
  start: Date | null,
  end: Date | null,
  overdueBefore: Date,
): Promise<ManagementCriticalFindingItem[]> {
  if (buildingIds.length === 0) return [];

  const result = await getPool().query<CriticalFindingRow>(
    `WITH ranked_severities AS (
       SELECT fs.*,
              max(fs.rank) OVER (PARTITION BY fs.client_id) AS maximum_rank
         FROM finding_severities fs
        WHERE fs.status = 'ACTIVE'
     ), critical_severities AS (
       SELECT * FROM ranked_severities WHERE rank = maximum_rank
     )
     SELECT
       f.id AS finding_id,
       f.client_id,
       f.building_id,
       f.finding_number,
       f.title,
       fs.id AS severity_id,
       fs.code AS severity_code,
       fs.name AS severity_name,
       fs.rank AS severity_rank,
       COALESCE(efl.source_type, hfl.source_type, sfl.source_type,
                f.source_type) AS source_type,
       COALESCE(efl.source_id, hfl.source_id, sfl.source_id,
                f.source_id) AS source_id,
       CASE
         WHEN efl.id IS NOT NULL THEN 'ENGINEERING'
         WHEN hfl.id IS NOT NULL THEN 'HOUSEKEEPING'
         WHEN sfl.id IS NOT NULL THEN 'SECURITY'
         ELSE 'GENERAL'
       END AS context_type,
       COALESCE(efl.id, hfl.id, sfl.id) AS context_id,
       f.status,
       fa.assignee_type,
       fa.workforce_profile_id,
       fa.team_id,
       fa.vendor_id,
       f.reported_at,
       (f.reported_at < $4) AS overdue
     FROM findings f
     JOIN critical_severities fs ON fs.id = f.severity_id
     LEFT JOIN finding_assignments fa
       ON fa.finding_id = f.id AND fa.status = 'ACTIVE'
     LEFT JOIN engineering_finding_links efl ON efl.finding_id = f.id
     LEFT JOIN housekeeping_finding_links hfl ON hfl.finding_id = f.id
     LEFT JOIN security_finding_links sfl ON sfl.finding_id = f.id
     WHERE f.building_id = ANY($1::uuid[])
       AND f.status = ANY($5::text[])
       AND ($2::timestamptz IS NULL OR f.reported_at >= $2)
       AND ($3::timestamptz IS NULL OR f.reported_at < $3)
     ORDER BY overdue DESC, f.reported_at ASC, f.id ASC`,
    [
      buildingIds,
      start,
      end,
      overdueBefore,
      SECURITY_OUTSTANDING_FINDING_STATUSES,
    ],
  );

  return result.rows.map((row) => ({
    findingId: row.finding_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    findingReference: row.finding_number,
    title: row.title,
    severity: {
      id: row.severity_id,
      code: row.severity_code,
      name: row.severity_name,
      rank: row.severity_rank,
    },
    source: { type: row.source_type, id: row.source_id },
    context: { type: row.context_type, id: row.context_id },
    status: row.status,
    responsibleParty: row.assignee_type
      ? {
          type: row.assignee_type,
          workforceProfileId: row.workforce_profile_id,
          teamId: row.team_id,
          vendorId: row.vendor_id,
        }
      : null,
    reportedAt: row.reported_at.toISOString(),
    overdue: row.overdue,
  }));
}

export const managementCriticalFindingsRepository = {
  listCriticalFindings,
};
