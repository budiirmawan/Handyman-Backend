import { getPool } from '../../database';
import { SECURITY_OUTSTANDING_FINDING_STATUSES } from '../security-finding-incident-kpi';

type OperationalSourceRow = {
  open_findings: number;
  closed_findings: number;
  incident_count: number;
};

/** Generic BE-09/BE-21 counts absent from the domain-specific BE-23 KPIs. */
export async function getOperationalSourceCounts(
  buildingIds: string[],
  start: Date | null,
  end: Date | null,
): Promise<OperationalSourceRow> {
  const result = await getPool().query<OperationalSourceRow>(
    `SELECT
       (SELECT count(*)::int
          FROM findings f
         WHERE f.building_id = ANY($1::uuid[])
           AND f.status = ANY($4::text[])
           AND ($2::timestamptz IS NULL OR f.reported_at >= $2)
           AND ($3::timestamptz IS NULL OR f.reported_at < $3)
       ) AS open_findings,
       (SELECT count(*)::int
          FROM findings f
         WHERE f.building_id = ANY($1::uuid[])
           AND f.status = 'CLOSED'
           AND ($2::timestamptz IS NULL OR f.reported_at >= $2)
           AND ($3::timestamptz IS NULL OR f.reported_at < $3)
       ) AS closed_findings,
       (SELECT count(*)::int
          FROM incidents i
         WHERE i.building_id = ANY($1::uuid[])
           AND ($2::timestamptz IS NULL OR i.reported_at >= $2)
           AND ($3::timestamptz IS NULL OR i.reported_at < $3)
       ) AS incident_count`,
    [buildingIds, start, end, SECURITY_OUTSTANDING_FINDING_STATUSES],
  );
  return (
    result.rows[0] ?? {
      open_findings: 0,
      closed_findings: 0,
      incident_count: 0,
    }
  );
}

export const managementOperationalKpiRepository = {
  getOperationalSourceCounts,
};
