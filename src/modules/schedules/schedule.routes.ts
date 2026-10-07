import { Router, Request, Response, NextFunction } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getPool } from '../../database';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';

const p = (value: string | string[]): string =>
  Array.isArray(value) ? value[0] : value;

const targets = [
  'FORM_TEMPLATE',
  'FORM_VERSION',
  'CHECKLIST_TEMPLATE',
  'UTILITY_METER',
];

const out = (row: any) => ({
  id: row.id,
  clientId: row.client_id,
  code: row.code,
  name: row.name,
  targetType: row.target_type,
  targetId: row.target_id,
  buildingId: row.building_id,
  startAt: row.start_at,
  endAt: row.end_at,
  timezone: row.timezone,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

type ScheduleTargetRow = {
  id: string;
  status: string;
  client_id: string;
  building_id?: string | null;
};

/**
 * MOB-C07 PART 01D — FORM_VERSION schedule authority.
 *
 * A FORM_VERSION target is the exact published version identity. Ownership
 * comes from the parent form template (form_template_versions has no
 * client_id). FORM_TEMPLATE / CHECKLIST_TEMPLATE / UTILITY_METER keep the
 * previous SELECT * + INACTIVE + client_id path.
 */
async function target(
  targetType: string,
  targetId: string,
): Promise<ScheduleTargetRow> {
  if (targetType === 'FORM_VERSION') {
    const result = await getPool().query<{
      id: string;
      version_status: string;
      form_template_id: string;
      template_status: string;
      client_id: string;
    }>(
      `SELECT v.id,
              v.status AS version_status,
              v.form_template_id,
              t.status AS template_status,
              t.client_id
         FROM form_template_versions v
         JOIN form_templates t ON t.id = v.form_template_id
        WHERE v.id = $1`,
      [targetId],
    );
    const row = result.rows[0];
    if (!row) {
      throw AppError.badRequest('Schedule target does not exist.');
    }
    if (row.version_status !== 'PUBLISHED') {
      throw AppError.badRequest(
        'Only published template versions can receive a schedule.',
      );
    }
    if (row.template_status !== 'ACTIVE') {
      throw AppError.badRequest(
        'Inactive target cannot receive an active schedule.',
      );
    }
    return {
      id: row.id,
      status: row.version_status,
      client_id: row.client_id,
    };
  }

  const map: Record<string, string> = {
    FORM_TEMPLATE: 'form_templates',
    CHECKLIST_TEMPLATE: 'checklist_templates',
    UTILITY_METER: 'utility_meters',
  };
  const table = map[targetType];
  const result = await getPool().query(`SELECT * FROM ${table} WHERE id = $1`, [
    targetId,
  ]);
  if (!result.rowCount) {
    throw AppError.badRequest('Schedule target does not exist.');
  }
  return result.rows[0];
}

async function get(id: string | string[], userId: string) {
  const result = await getPool().query(
    'SELECT * FROM schedule_definitions WHERE id = $1',
    [p(id)],
  );
  if (!result.rowCount) {
    throw AppError.notFound('Schedule not found.');
  }
  const row = result.rows[0];
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (
    !(
      (row.building_id && buildingIds.includes(row.building_id)) ||
      (!row.building_id && clientIds.includes(row.client_id))
    )
  ) {
    throw buildingAccessDeniedError();
  }
  return row;
}

async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body || {};
    if (
      !targets.includes(body.targetType) ||
      !body.targetId ||
      !body.code ||
      !body.name ||
      !body.startAt ||
      !body.timezone
    ) {
      throw AppError.validation();
    }
    const resolved = await target(body.targetType, body.targetId);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: body.timezone });
    } catch {
      throw AppError.badRequest('Invalid timezone.');
    }
    if (body.endAt && new Date(body.startAt) > new Date(body.endAt)) {
      throw AppError.badRequest('startAt must not exceed endAt.');
    }
    if (resolved.status === 'INACTIVE') {
      throw AppError.badRequest(
        'Inactive target cannot receive an active schedule.',
      );
    }
    const clientIds = await contextAccessService.getAccessibleClientIds(
      req.auth.userId,
    );
    if (!clientIds.includes(resolved.client_id)) {
      throw buildingAccessDeniedError();
    }
    const effectiveBuildingId =
      body.targetType === 'UTILITY_METER'
        ? resolved.building_id
        : body.buildingId || null;
    if (
      body.targetType === 'UTILITY_METER' &&
      body.buildingId &&
      body.buildingId !== resolved.building_id
    ) {
      throw AppError.badRequest('Invalid building context.');
    }
    if (effectiveBuildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        effectiveBuildingId,
      );
      const building = await getPool().query(
        'SELECT b.id, p.client_id FROM buildings b JOIN properties p ON p.id = b.property_id WHERE b.id = $1',
        [effectiveBuildingId],
      );
      if (!building.rowCount || building.rows[0].client_id !== resolved.client_id) {
        throw AppError.badRequest('Invalid building context.');
      }
    }
    const created = await getPool().query(
      `INSERT INTO schedule_definitions (
         id, client_id, code, name, target_type, target_id, building_id,
         start_at, end_at, timezone, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        randomUUID(),
        resolved.client_id,
        body.code.toUpperCase(),
        body.name,
        body.targetType,
        body.targetId,
        effectiveBuildingId,
        body.startAt,
        body.endAt || null,
        body.timezone,
        body.status || 'ACTIVE',
      ],
    );
    sendSuccess(res, out(created.rows[0]), 201);
  } catch (error: any) {
    if (error.code === '23505') {
      return next(AppError.badRequest('Conflicting active schedule.'));
    }
    next(error);
  }
}

async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const buildingIds = await contextAccessService.getAccessibleBuildingIds(
      req.auth.userId,
    );
    const clientIds = await contextAccessService.getAccessibleClientIds(
      req.auth.userId,
    );
    const result = await getPool().query(
      `SELECT * FROM schedule_definitions
        WHERE ($1::uuid IS NULL OR client_id = $1)
          AND ($2::uuid IS NULL OR building_id = $2)
          AND ($3::text IS NULL OR target_type = $3)
          AND (building_id = ANY($4::uuid[])
            OR (building_id IS NULL AND client_id = ANY($5::uuid[])))
        ORDER BY start_at`,
      [
        req.query.clientId || null,
        req.query.buildingId || null,
        req.query.targetType || null,
        buildingIds,
        clientIds,
      ],
    );
    sendSuccess(res, result.rows.map(out));
  } catch (error) {
    next(error);
  }
}

async function one(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, out(await get(req.params.id, req.auth.userId)));
  } catch (error) {
    next(error);
  }
}

async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const current = await get(req.params.id, req.auth.userId);
    const body = req.body || {};
    const vals: any[] = [];
    if (body.startAt && body.endAt && new Date(body.startAt) > new Date(body.endAt)) {
      throw AppError.badRequest('startAt must not exceed endAt.');
    }
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: body.timezone });
      } catch {
        throw AppError.badRequest('Invalid timezone.');
      }
    }
    const map: any = {
      name: 'name',
      startAt: 'start_at',
      endAt: 'end_at',
      timezone: 'timezone',
      status: 'status',
    };
    const sets = Object.keys(map)
      .filter((key) => body[key] !== undefined)
      .map((key) => {
        vals.push(body[key]);
        return `${map[key]}=$${vals.length}`;
      });
    if (!sets.length) {
      return sendSuccess(res, out(current));
    }
    vals.push(current.id);
    sendSuccess(
      res,
      out(
        (
          await getPool().query(
            `UPDATE schedule_definitions SET ${sets.join(',')}, updated_at = NOW()
              WHERE id = $${vals.length}
              RETURNING *`,
            vals,
          )
        ).rows[0],
      ),
    );
  } catch (error) {
    next(error);
  }
}

export function createScheduleRouter() {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('schedule.manage');
  const read = requirePermission('schedule.read');
  router.post('/schedules', auth, manage, create);
  router.get('/schedules', auth, read, list);
  router.get('/schedules/:id', auth, read, one);
  router.patch('/schedules/:id', auth, manage, update);
  return router;
}
