import { getPool } from '../../database';
import type {
  ReportingDepartment,
  ReportingExternalAffiliation,
  ReportingOrganization,
  ReportingPosition,
  ReportingSupervisor,
  ReportingTeam,
  ReportingUser,
  ReportingWorkforceBuildingAssignment,
  ReportingWorkforceShift,
  ReportingWorkforceSkill,
  WorkforceReportingPage,
  WorkforceReportingRecord,
  WorkforceReportingScope,
} from './workforce-reporting.types';

type WorkforceReportingRow = {
  profile_id: string;
  employee_code: string;
  full_name: string;
  workforce_type: WorkforceReportingRecord['profile']['workforceType'];
  profile_status: WorkforceReportingRecord['profile']['status'];
  profile_user_id: string | null;
  profile_created_at: Date;
  profile_updated_at: Date;
  total_count: string;
  client_id: string;
  client_code: string;
  client_name: string;
  client_status: WorkforceReportingRecord['client']['status'];
  organization_id: string;
  organization_code: string;
  organization_name: string;
  organization_description: string | null;
  organization_status: ReportingOrganization['status'];
  department_id: string;
  department_code: string;
  department_name: string;
  department_description: string | null;
  department_status: ReportingDepartment['status'];
  team_id: string | null;
  team_code: string | null;
  team_name: string | null;
  team_description: string | null;
  team_status: ReportingTeam['status'] | null;
  position_id: string;
  position_code: string;
  position_name: string;
  position_description: string | null;
  position_department_id: string | null;
  position_status: ReportingPosition['status'];
  user_row_id: string | null;
  user_email: string | null;
  user_display_name: string | null;
  user_status: string | null;
  skills: ReportingWorkforceSkill[] | null;
  shifts: ReportingWorkforceShift[] | null;
  supervisor: ReportingSupervisor[] | null;
  direct_reports: ReportingSupervisor[] | null;
  building_assignments: ReportingWorkforceBuildingAssignment[] | null;
  external_affiliations: ReportingExternalAffiliation[] | null;
};

type NormalizedScope = Required<
  Pick<WorkforceReportingScope, 'asOf' | 'includeInactive'>
> & {
  profileId?: string;
  clientId?: string;
  organizationId?: string;
  departmentId?: string;
  teamId?: string;
  positionId?: string;
  buildingId?: string;
  shiftId?: string;
  externalOrganizationId?: string;
  workforceType?: WorkforceReportingRecord['profile']['workforceType'];
  status?: WorkforceReportingRecord['profile']['status'];
  accessibleBuildingIds: string[];
  requireAccessibleBuilding: boolean;
};

function normalizeScope(
  scope: WorkforceReportingScope = {},
): NormalizedScope | null {
  const accessibleBuildingIds = scope.accessibleBuildingIds
    ? [...new Set(scope.accessibleBuildingIds)].filter(Boolean)
    : [];

  if (scope.requireAccessibleBuilding && accessibleBuildingIds.length === 0) {
    return null;
  }

  if (!scope.clientId && accessibleBuildingIds.length === 0) {
    return null;
  }

  if (scope.accessibleBuildingIds !== undefined && accessibleBuildingIds.length === 0) {
    return null;
  }

  if (
    scope.buildingId &&
    accessibleBuildingIds.length > 0 &&
    !accessibleBuildingIds.includes(scope.buildingId)
  ) {
    return null;
  }

  return {
    profileId: scope.profileId,
    clientId: scope.clientId,
    organizationId: scope.organizationId,
    departmentId: scope.departmentId,
    teamId: scope.teamId,
    positionId: scope.positionId,
    buildingId: scope.buildingId,
    shiftId: scope.shiftId,
    externalOrganizationId: scope.externalOrganizationId,
    workforceType: scope.workforceType,
    status: scope.status,
    accessibleBuildingIds,
    requireAccessibleBuilding: scope.requireAccessibleBuilding ?? false,
    includeInactive: scope.includeInactive ?? false,
    asOf: scope.asOf ?? new Date(),
  };
}

function mapUser(row: WorkforceReportingRow): ReportingUser | null {
  if (!row.user_row_id || !row.user_email || !row.user_display_name) {
    return null;
  }

  return {
    id: row.user_row_id,
    email: row.user_email,
    displayName: row.user_display_name,
    status: row.user_status ?? 'ACTIVE',
  };
}

function mapRow(row: WorkforceReportingRow): WorkforceReportingRecord {
  return {
    client: {
      id: row.client_id,
      code: row.client_code,
      name: row.client_name,
      status: row.client_status,
    },
    organization: {
      id: row.organization_id,
      clientId: row.client_id,
      code: row.organization_code,
      name: row.organization_name,
      description: row.organization_description,
      status: row.organization_status,
    },
    department: {
      id: row.department_id,
      organizationId: row.organization_id,
      clientId: row.client_id,
      code: row.department_code,
      name: row.department_name,
      description: row.department_description,
      status: row.department_status,
    },
    team:
      row.team_id === null
        ? null
        : {
            id: row.team_id,
            departmentId: row.department_id,
            organizationId: row.organization_id,
            clientId: row.client_id,
            code: row.team_code as string,
            name: row.team_name as string,
            description: row.team_description,
            status: row.team_status as ReportingTeam['status'],
          },
    position: {
      id: row.position_id,
      organizationId: row.organization_id,
      departmentId: row.position_department_id,
      clientId: row.client_id,
      code: row.position_code,
      name: row.position_name,
      description: row.position_description,
      status: row.position_status,
    },
    profile: {
      id: row.profile_id,
      employeeCode: row.employee_code,
      fullName: row.full_name,
      workforceType: row.workforce_type,
      status: row.profile_status,
      userId: row.profile_user_id,
      createdAt: row.profile_created_at,
      updatedAt: row.profile_updated_at,
    },
    user: mapUser(row),
    skills: row.skills ?? [],
    shifts: row.shifts ?? [],
    supervisor: row.supervisor?.[0] ?? null,
    directReports: row.direct_reports ?? [],
    buildingAssignments: row.building_assignments ?? [],
    externalAffiliations: row.external_affiliations ?? [],
  };
}

type BuildQueryResult = {
  sql: string;
  values: unknown[];
};

function buildReportingQuery(
  normalized: NormalizedScope,
  pagination?: { limit: number; offset: number },
): BuildQueryResult {
  const values: unknown[] = [normalized.asOf];
  const clauses: string[] = [];
  let accessibleBuildingIdsParam: number | null = null;

  if (normalized.accessibleBuildingIds.length > 0) {
    values.push(normalized.accessibleBuildingIds);
    accessibleBuildingIdsParam = values.length;
  }

  if (normalized.includeInactive) {
    if (normalized.status) {
      values.push(normalized.status);
      clauses.push(`p.status = $${values.length}`);
    }
  } else if (normalized.status) {
    values.push(normalized.status);
    clauses.push(`p.status = $${values.length}`);
  } else {
    clauses.push(`p.status = 'ACTIVE'`);
  }

  if (normalized.workforceType) {
    values.push(normalized.workforceType);
    clauses.push(`p.workforce_type = $${values.length}`);
  }
  if (normalized.profileId) {
    values.push(normalized.profileId);
    clauses.push(`p.id = $${values.length}`);
  }
  if (normalized.clientId) {
    values.push(normalized.clientId);
    clauses.push(`o.client_id = $${values.length}`);
  }
  if (normalized.organizationId) {
    values.push(normalized.organizationId);
    clauses.push(`p.organization_id = $${values.length}`);
  }
  if (normalized.departmentId) {
    values.push(normalized.departmentId);
    clauses.push(`p.department_id = $${values.length}`);
  }
  if (normalized.teamId) {
    values.push(normalized.teamId);
    clauses.push(`p.team_id = $${values.length}`);
  }
  if (normalized.positionId) {
    values.push(normalized.positionId);
    clauses.push(`p.position_id = $${values.length}`);
  }
  if (normalized.buildingId) {
    values.push(normalized.buildingId);
    clauses.push(`EXISTS (
      SELECT 1
      FROM workforce_building_assignments filter_wba
      WHERE filter_wba.workforce_profile_id = p.id
        AND filter_wba.building_id = $${values.length}
        AND filter_wba.status = 'ACTIVE'
        AND (filter_wba.effective_from IS NULL OR filter_wba.effective_from <= $1)
        AND (filter_wba.effective_until IS NULL OR filter_wba.effective_until >= $1)
    )`);
  }
  if (normalized.shiftId) {
    values.push(normalized.shiftId);
    const shiftAccess = accessibleBuildingIdsParam
      ? `AND filter_sh.building_id = ANY($${accessibleBuildingIdsParam}::uuid[])`
      : '';
    clauses.push(`EXISTS (
      SELECT 1
      FROM workforce_shift_assignments filter_wsh
      JOIN shifts filter_sh ON filter_sh.id = filter_wsh.shift_id
      WHERE filter_wsh.workforce_profile_id = p.id
        AND filter_wsh.shift_id = $${values.length}
        AND filter_wsh.status = 'ACTIVE'
        AND filter_sh.status = 'ACTIVE'
        ${shiftAccess}
        AND (filter_wsh.effective_from IS NULL OR filter_wsh.effective_from <= $1)
        AND (filter_wsh.effective_until IS NULL OR filter_wsh.effective_until >= $1)
    )`);
  }
  if (normalized.externalOrganizationId) {
    values.push(normalized.externalOrganizationId);
    clauses.push(`EXISTS (
      SELECT 1
      FROM external_workforce_links filter_ewl
      JOIN external_organizations filter_eo
        ON filter_eo.id = filter_ewl.external_organization_id
      JOIN organizations filter_o ON filter_o.id = p.organization_id
      WHERE filter_ewl.workforce_profile_id = p.id
        AND filter_ewl.external_organization_id = $${values.length}
        AND filter_eo.client_id = filter_o.client_id
        AND filter_ewl.status = 'ACTIVE'
        AND (filter_ewl.effective_from IS NULL OR filter_ewl.effective_from <= $1)
        AND (filter_ewl.effective_until IS NULL OR filter_ewl.effective_until >= $1)
    )`);
  }
  if (accessibleBuildingIdsParam) {
    clauses.push(`(
      EXISTS (
        SELECT 1
        FROM workforce_building_assignments access_wba
        JOIN buildings access_b ON access_b.id = access_wba.building_id
        WHERE access_wba.workforce_profile_id = p.id
          AND access_b.id = ANY($${accessibleBuildingIdsParam}::uuid[])
          AND access_wba.status = 'ACTIVE'
          AND access_b.status = 'ACTIVE'
          AND (access_wba.effective_from IS NULL OR access_wba.effective_from <= $1)
          AND (access_wba.effective_until IS NULL OR access_wba.effective_until >= $1)
      )
      OR EXISTS (
        SELECT 1
        FROM workforce_shift_assignments access_wsh
        JOIN shifts access_sh ON access_sh.id = access_wsh.shift_id
        WHERE access_wsh.workforce_profile_id = p.id
          AND access_sh.building_id = ANY($${accessibleBuildingIdsParam}::uuid[])
          AND access_wsh.status = 'ACTIVE'
          AND access_sh.status = 'ACTIVE'
          AND (access_wsh.effective_from IS NULL OR access_wsh.effective_from <= $1)
          AND (access_wsh.effective_until IS NULL OR access_wsh.effective_until >= $1)
      )
    )`);
  }

  const buildingAssignmentAccessClause = accessibleBuildingIdsParam
    ? `AND ba_building.id = ANY($${accessibleBuildingIdsParam}::uuid[])`
    : '';
  const shiftAccessClause = accessibleBuildingIdsParam
    ? `AND sh.building_id = ANY($${accessibleBuildingIdsParam}::uuid[])`
    : '';

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join('\n    AND ')}` : '';
  const paginationSql = pagination
    ? `LIMIT $${values.push(pagination.limit)} OFFSET $${values.push(pagination.offset)}`
    : '';

  const sql = `
    WITH filtered_profiles AS (
      SELECT p.*, COUNT(*) OVER() AS total_count
      FROM workforce_profiles p
      JOIN organizations o ON o.id = p.organization_id
      JOIN departments d ON d.id = p.department_id
      LEFT JOIN teams t ON t.id = p.team_id
      JOIN positions pos ON pos.id = p.position_id
      ${whereSql}
      ${pagination ? '' : ''}
    ),
    paged_profiles AS (
      SELECT *
      FROM filtered_profiles
      ${paginationSql}
    )
    SELECT
      p.id AS profile_id,
      p.employee_code,
      p.full_name,
      p.workforce_type,
      p.status AS profile_status,
      p.user_id AS profile_user_id,
      p.created_at AS profile_created_at,
      p.updated_at AS profile_updated_at,
      p.total_count,
      c.id AS client_id,
      c.code AS client_code,
      c.name AS client_name,
      c.status AS client_status,
      o.id AS organization_id,
      o.code AS organization_code,
      o.name AS organization_name,
      o.description AS organization_description,
      o.status AS organization_status,
      d.id AS department_id,
      d.code AS department_code,
      d.name AS department_name,
      d.description AS department_description,
      d.status AS department_status,
      t.id AS team_id,
      t.code AS team_code,
      t.name AS team_name,
      t.description AS team_description,
      t.status AS team_status,
      pos.id AS position_id,
      pos.code AS position_code,
      pos.name AS position_name,
      pos.description AS position_description,
      pos.department_id AS position_department_id,
      pos.status AS position_status,
      u.id AS user_row_id,
      u.email AS user_email,
      u.display_name AS user_display_name,
      u.status AS user_status,
      (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', wsa.id,
          'skillId', s.id,
          'code', s.code,
          'name', s.name,
          'category', s.category,
          'status', s.status,
          'assignmentStatus', wsa.status,
          'proficiencyLevel', wsa.proficiency_level,
          'validFrom', wsa.valid_from,
          'validUntil', wsa.valid_until
        ) ORDER BY s.code ASC), '[]'::jsonb)
        FROM workforce_skill_assignments wsa
        JOIN skills s ON s.id = wsa.skill_id
        WHERE wsa.workforce_profile_id = p.id
          AND wsa.status = 'ACTIVE'
          AND s.status = 'ACTIVE'
          AND (wsa.valid_from IS NULL OR wsa.valid_from <= $1)
          AND (wsa.valid_until IS NULL OR wsa.valid_until >= $1)
      ) AS skills,
      (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', wsh.id,
          'shiftId', sh.id,
          'code', sh.code,
          'name', sh.name,
          'startTime', sh.start_time::text,
          'endTime', sh.end_time::text,
          'buildingId', sh.building_id,
          'buildingCode', sh_b.code,
          'buildingName', sh_b.name,
          'shiftStatus', sh.status,
          'assignmentStatus', wsh.status,
          'effectiveFrom', wsh.effective_from,
          'effectiveUntil', wsh.effective_until
        ) ORDER BY sh.code ASC), '[]'::jsonb)
        FROM workforce_shift_assignments wsh
        JOIN shifts sh ON sh.id = wsh.shift_id
        JOIN buildings sh_b ON sh_b.id = sh.building_id
        WHERE wsh.workforce_profile_id = p.id
          AND wsh.status = 'ACTIVE'
          AND sh.status = 'ACTIVE'
          ${shiftAccessClause}
          AND (wsh.effective_from IS NULL OR wsh.effective_from <= $1)
          AND (wsh.effective_until IS NULL OR wsh.effective_until >= $1)
      ) AS shifts,
      (
        SELECT jsonb_agg(jsonb_build_object(
          'reportingLineId', rl.id,
          'workforceProfileId', sup.id,
          'employeeCode', sup.employee_code,
          'fullName', sup.full_name,
          'assignmentStatus', rl.status,
          'effectiveFrom', rl.effective_from,
          'effectiveUntil', rl.effective_until
        ) ORDER BY sup.employee_code ASC)
        FROM workforce_reporting_lines rl
        JOIN workforce_profiles sup ON sup.id = rl.supervisor_workforce_profile_id
        WHERE rl.workforce_profile_id = p.id
          AND rl.status = 'ACTIVE'
          AND sup.status = 'ACTIVE'
          AND (rl.effective_from IS NULL OR rl.effective_from <= $1)
          AND (rl.effective_until IS NULL OR rl.effective_until >= $1)
        LIMIT 1
      ) AS supervisor,
      (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'reportingLineId', rl.id,
          'workforceProfileId', rep.id,
          'employeeCode', rep.employee_code,
          'fullName', rep.full_name,
          'assignmentStatus', rl.status,
          'effectiveFrom', rl.effective_from,
          'effectiveUntil', rl.effective_until
        ) ORDER BY rep.employee_code ASC), '[]'::jsonb)
        FROM workforce_reporting_lines rl
        JOIN workforce_profiles rep ON rep.id = rl.workforce_profile_id
        WHERE rl.supervisor_workforce_profile_id = p.id
          AND rl.status = 'ACTIVE'
          AND rep.status = 'ACTIVE'
          AND (rl.effective_from IS NULL OR rl.effective_from <= $1)
          AND (rl.effective_until IS NULL OR rl.effective_until >= $1)
      ) AS direct_reports,
      (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', wba.id,
          'buildingId', ba_building.id,
          'buildingCode', ba_building.code,
          'buildingName', ba_building.name,
          'propertyId', pr.id,
          'propertyCode', pr.code,
          'propertyName', pr.name,
          'clientId', c.id,
          'buildingStatus', ba_building.status,
          'assignmentStatus', wba.status,
          'effectiveFrom', wba.effective_from,
          'effectiveUntil', wba.effective_until
        ) ORDER BY ba_building.code ASC), '[]'::jsonb)
        FROM workforce_building_assignments wba
        JOIN buildings ba_building ON ba_building.id = wba.building_id
        JOIN properties pr ON pr.id = ba_building.property_id
        WHERE wba.workforce_profile_id = p.id
          AND wba.status = 'ACTIVE'
          AND ba_building.status = 'ACTIVE'
          ${buildingAssignmentAccessClause}
          AND (wba.effective_from IS NULL OR wba.effective_from <= $1)
          AND (wba.effective_until IS NULL OR wba.effective_until >= $1)
      ) AS building_assignments,
      (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', ewl.id,
          'externalOrganizationId', eo.id,
          'externalOrganizationCode', eo.code,
          'externalOrganizationName', eo.name,
          'externalOrganizationStatus', eo.status,
          'externalPersonnelCode', ewl.external_personnel_code,
          'assignmentStatus', ewl.status,
          'effectiveFrom', ewl.effective_from,
          'effectiveUntil', ewl.effective_until
        ) ORDER BY eo.code ASC), '[]'::jsonb)
        FROM external_workforce_links ewl
        JOIN external_organizations eo
          ON eo.id = ewl.external_organization_id
        WHERE ewl.workforce_profile_id = p.id
          AND ewl.status = 'ACTIVE'
          AND eo.status = 'ACTIVE'
          AND (ewl.effective_from IS NULL OR ewl.effective_from <= $1)
          AND (ewl.effective_until IS NULL OR ewl.effective_until >= $1)
      ) AS external_affiliations
    FROM paged_profiles p
    JOIN organizations o ON o.id = p.organization_id
    JOIN clients c ON c.id = o.client_id
    JOIN departments d ON d.id = p.department_id
    LEFT JOIN teams t ON t.id = p.team_id
    JOIN positions pos ON pos.id = p.position_id
    LEFT JOIN users u ON u.id = p.user_id
    ORDER BY c.code ASC, o.code ASC, d.code ASC,
      COALESCE(t.code, '') ASC, p.employee_code ASC, p.id ASC
  `;

  return { sql, values };
}

async function listWorkforceReporting(
  scope: WorkforceReportingScope = {},
): Promise<WorkforceReportingRecord[]> {
  const normalized = normalizeScope(scope);
  if (!normalized) {
    return [];
  }

  const { sql, values } = buildReportingQuery(normalized);
  const result = await getPool().query<WorkforceReportingRow>(sql, values);
  return result.rows.map(mapRow);
}

async function listWorkforceReportingPage(
  scope: WorkforceReportingScope,
  page: number,
  limit: number,
): Promise<WorkforceReportingPage> {
  const normalized = normalizeScope(scope);
  if (!normalized) {
    return { items: [], page, limit, total: 0 };
  }

  const offset = (page - 1) * limit;
  const { sql, values } = buildReportingQuery(normalized, { limit, offset });
  const result = await getPool().query<WorkforceReportingRow>(sql, values);
  const total = Number.parseInt(result.rows[0]?.total_count ?? '0', 10);
  return {
    items: result.rows.map(mapRow),
    page,
    limit,
    total,
  };
}

async function findWorkforceReportingById(
  workforceProfileId: string,
  scope: WorkforceReportingScope = {},
): Promise<WorkforceReportingRecord | null> {
  const records = await listWorkforceReporting({
    ...scope,
    profileId: workforceProfileId,
  });
  return records[0] ?? null;
}

export const workforceReportingRepository = {
  findWorkforceReportingById,
  listWorkforceReporting,
  listWorkforceReportingPage,
};
