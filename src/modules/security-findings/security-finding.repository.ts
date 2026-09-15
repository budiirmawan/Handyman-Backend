import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  SecurityFindingLinkRecord,
  SecurityFindingListFilters,
  SecurityFindingSourceType,
} from './security-finding.types';

/**
 * BE-12H — Security Finding Binding repository.
 *
 * Holds the Security context link for BE-09 Findings and resolves the
 * Building / Client of Security source executions. The Finding itself
 * lives exclusively in BE-09's `findings` table — this repository never
 * writes Finding lifecycle data.
 */

type SecurityFindingLinkRow = {
  id: string;
  client_id: string;
  building_id: string;
  finding_id: string;
  start_security_post_id: string | null;
  patrol_route_id: string | null;
  source_type: SecurityFindingSourceType;
  source_id: string;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

export type SecurityFindingListRow = SecurityFindingLinkRow & {
  f_id: string;
  f_finding_number: string;
  f_title: string;
  f_description: string | null;
  f_classification_id: string | null;
  f_severity_id: string | null;
  f_status: string;
  f_reported_by_user_id: string;
  f_reported_at: Date;
  f_state_changed_at: Date;
  f_closed_at: Date | null;
  f_closed_by_user_id: string | null;
  f_closure_notes: string | null;
  f_created_at: Date;
  f_updated_at: Date;
};

function mapRow(row: SecurityFindingLinkRow): SecurityFindingLinkRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    findingId: row.finding_id,
    startSecurityPostId: row.start_security_post_id,
    patrolRouteId: row.patrol_route_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: {
    clientId: string;
    buildingId: string;
    findingId: string;
    startSecurityPostId: string | null;
    patrolRouteId: string | null;
    sourceType: SecurityFindingSourceType;
    sourceId: string;
    createdByUserId: string;
  },
): Promise<SecurityFindingLinkRecord> {
  const result = await getPool().query<SecurityFindingLinkRow>(
    `INSERT INTO security_finding_links
       (id, client_id, building_id, finding_id, start_security_post_id,
        patrol_route_id, source_type, source_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, client_id, building_id, finding_id, start_security_post_id,
               patrol_route_id, source_type, source_id, created_by_user_id,
               created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.findingId,
      input.startSecurityPostId,
      input.patrolRouteId,
      input.sourceType,
      input.sourceId,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<SecurityFindingLinkRecord | null> {
  const result = await getPool().query<SecurityFindingLinkRow>(
    `SELECT id, client_id, building_id, finding_id, start_security_post_id,
            patrol_route_id, source_type, source_id, created_by_user_id,
            created_at, updated_at
     FROM security_finding_links WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findByFindingId(
  findingId: string,
): Promise<SecurityFindingLinkRecord | null> {
  const result = await getPool().query<SecurityFindingLinkRow>(
    `SELECT id, client_id, building_id, finding_id, start_security_post_id,
            patrol_route_id, source_type, source_id, created_by_user_id,
            created_at, updated_at
     FROM security_finding_links WHERE finding_id = $1`,
    [findingId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findBySource(
  sourceType: SecurityFindingSourceType,
  sourceId: string,
): Promise<SecurityFindingLinkRecord | null> {
  const result = await getPool().query<SecurityFindingLinkRow>(
    `SELECT id, client_id, building_id, finding_id, start_security_post_id,
            patrol_route_id, source_type, source_id, created_by_user_id,
            created_at, updated_at
     FROM security_finding_links
     WHERE source_type = $1 AND source_id = $2`,
    [sourceType, sourceId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuildingIds(
  buildingIds: string[],
  filters: SecurityFindingListFilters,
): Promise<SecurityFindingListRow[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const result = await getPool().query<SecurityFindingListRow>(
    `SELECT
       l.id, l.client_id, l.building_id, l.finding_id, l.start_security_post_id,
       l.patrol_route_id, l.source_type, l.source_id,
       l.created_by_user_id, l.created_at, l.updated_at,
       f.id AS f_id, f.finding_number AS f_finding_number,
       f.title AS f_title, f.description AS f_description,
       f.classification_id AS f_classification_id,
       f.severity_id AS f_severity_id, f.status AS f_status,
       f.reported_by_user_id AS f_reported_by_user_id,
       f.reported_at AS f_reported_at,
       f.state_changed_at AS f_state_changed_at,
       f.closed_at AS f_closed_at, f.closed_by_user_id AS f_closed_by_user_id,
       f.closure_notes AS f_closure_notes,
       f.created_at AS f_created_at, f.updated_at AS f_updated_at
     FROM security_finding_links l
     JOIN findings f ON f.id = l.finding_id
     WHERE l.building_id = ANY($1::uuid[])
       AND ($2::uuid IS NULL OR l.start_security_post_id = $2)
       AND ($3::uuid IS NULL OR l.patrol_route_id = $3)
       AND ($4::text IS NULL OR l.source_type = $4)
       AND ($5::text IS NULL OR f.status = $5)
     ORDER BY f.reported_at DESC
     LIMIT 200`,
    [
      buildingIds,
      filters.startSecurityPostId ?? null,
      filters.patrolRouteId ?? null,
      filters.sourceType ?? null,
      filters.status ?? null,
    ],
  );
  return result.rows;
}

/**
 * Resolves the Building / Client of a Security source execution. Every
 * Security source type resolves to a Building (directly, or through the
 * shared BE-07 Task that represents a Patrol Execution / Daily Activity /
 * Shift Handover).
 */
export async function resolveSourceContext(
  sourceType: SecurityFindingSourceType,
  sourceId: string,
): Promise<{ clientId: string; buildingId: string } | null> {
  if (sourceType === 'PATROL_EXECUTION') {
    // A Patrol Execution is a shared BE-07 generated_task bound to a
    // BE-12C patrol_schedule_binding → BE-12B patrol_route. The Task
    // itself carries the Building.
    const result = await getPool().query<{
      client_id: string;
      building_id: string;
    }>(
      `SELECT client_id, building_id
       FROM generated_tasks WHERE id = $1`,
      [sourceId],
    );
    if (!result.rows[0]) {
      return null;
    }
    if (!result.rows[0].building_id) {
      return null;
    }
    return {
      clientId: result.rows[0].client_id,
      buildingId: result.rows[0].building_id,
    };
  }

  if (sourceType === 'PATROL_CHECKLIST') {
    // A Patrol Checklist execution is a BE-07 checklist_execution bound
    // to a BE-12E patrol_checklist_binding → building_id.
    const result = await getPool().query<{
      client_id: string;
      building_id: string | null;
    }>(
      `SELECT ce.client_id, pcb.building_id
       FROM checklist_executions ce
       LEFT JOIN patrol_checklist_bindings pcb
         ON pcb.id = ce.patrol_checklist_binding_id
       WHERE ce.id = $1`,
      [sourceId],
    );
    if (!result.rows[0] || !result.rows[0].building_id) {
      return null;
    }
    return {
      clientId: result.rows[0].client_id,
      buildingId: result.rows[0].building_id,
    };
  }

  if (sourceType === 'SHIFT_HANDOVER') {
    const result = await getPool().query<{
      client_id: string;
      building_id: string;
    }>(
      `SELECT client_id, building_id
       FROM shift_handovers WHERE id = $1`,
      [sourceId],
    );
    return result.rows[0]
      ? {
          clientId: result.rows[0].client_id,
          buildingId: result.rows[0].building_id,
        }
      : null;
  }

  if (sourceType === 'SECURITY_POST') {
    const result = await getPool().query<{
      client_id: string;
      building_id: string;
    }>(
      `SELECT client_id, building_id
       FROM security_posts WHERE id = $1`,
      [sourceId],
    );
    return result.rows[0]
      ? {
          clientId: result.rows[0].client_id,
          buildingId: result.rows[0].building_id,
        }
      : null;
  }

  // SECURITY_DAILY_ACTIVITY: there is no source row — the operational
  // dataset is a read-model projection per Building. The caller supplies
  // the Building id as `sourceId`; we resolve that Building's client.
  const result = await getPool().query<{
    client_id: string;
    property_id: string;
  }>(
    `SELECT p.client_id, b.property_id
     FROM buildings b
     JOIN properties p ON p.id = b.property_id
     WHERE b.id = $1`,
    [sourceId],
  );
  return result.rows[0]
    ? {
        clientId: result.rows[0].client_id,
        buildingId: sourceId,
      }
    : null;
}

export const securityFindingRepository = {
  create,
  findByFindingId,
  findById,
  findBySource,
  listByBuildingIds,
  resolveSourceContext,
};
