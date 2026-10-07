import { getPool } from '../../database';
import type {
  ManagementWorkforceDepartmentRow,
  ManagementWorkforceTeamRow,
} from './management-workforce-summary.types';

type DepartmentRow = {
  department_id: string;
  department_code: string;
  department_name: string;
  total_workforce: number;
  active_workforce: number;
};

type TeamRow = DepartmentRow & {
  team_id: string;
  team_code: string;
  team_name: string;
};

/**
 * BE-03 hierarchy breakdown using the same ACTIVE Workforce-Building binding
 * that BE-23G uses for headcount. EXISTS prevents double-counting a person who
 * works in more than one selected Building.
 */
export async function getWorkforceHierarchyBreakdowns(
  buildingIds: string[],
): Promise<{
  byDepartment: ManagementWorkforceDepartmentRow[];
  byTeam: ManagementWorkforceTeamRow[];
}> {
  if (buildingIds.length === 0) {
    return { byDepartment: [], byTeam: [] };
  }

  const scope = `EXISTS (
    SELECT 1 FROM workforce_building_assignments wba
     WHERE wba.workforce_profile_id = wp.id
       AND wba.building_id = ANY($1::uuid[])
       AND wba.status = 'ACTIVE'
  )`;

  const [departments, teams] = await Promise.all([
    getPool().query<DepartmentRow>(
      `SELECT
         d.id AS department_id,
         d.code AS department_code,
         d.name AS department_name,
         count(*)::int AS total_workforce,
         count(*) FILTER (WHERE wp.status = 'ACTIVE')::int AS active_workforce
       FROM workforce_profiles wp
       JOIN departments d ON d.id = wp.department_id
       WHERE ${scope}
       GROUP BY d.id, d.code, d.name
       ORDER BY d.code ASC, d.id ASC`,
      [buildingIds],
    ),
    getPool().query<TeamRow>(
      `SELECT
         t.id AS team_id,
         t.code AS team_code,
         t.name AS team_name,
         d.id AS department_id,
         d.code AS department_code,
         d.name AS department_name,
         count(*)::int AS total_workforce,
         count(*) FILTER (WHERE wp.status = 'ACTIVE')::int AS active_workforce
       FROM workforce_profiles wp
       JOIN teams t ON t.id = wp.team_id
       JOIN departments d ON d.id = wp.department_id
       WHERE ${scope}
       GROUP BY t.id, t.code, t.name, d.id, d.code, d.name
       ORDER BY d.code ASC, t.code ASC, t.id ASC`,
      [buildingIds],
    ),
  ]);

  return {
    byDepartment: departments.rows.map((row) => ({
      departmentId: row.department_id,
      departmentCode: row.department_code,
      departmentName: row.department_name,
      totalWorkforce: row.total_workforce,
      activeWorkforce: row.active_workforce,
    })),
    byTeam: teams.rows.map((row) => ({
      teamId: row.team_id,
      teamCode: row.team_code,
      teamName: row.team_name,
      departmentId: row.department_id,
      departmentCode: row.department_code,
      departmentName: row.department_name,
      totalWorkforce: row.total_workforce,
      activeWorkforce: row.active_workforce,
    })),
  };
}

export const managementWorkforceSummaryRepository = {
  getWorkforceHierarchyBreakdowns,
};
