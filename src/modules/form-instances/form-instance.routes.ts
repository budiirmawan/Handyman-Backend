import { Router, Request, Response, NextFunction } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getPool } from '../../database';
import { sendSuccess } from '../../shared/api-response';
import { contextAccessService } from '../context-access';
import {
  createFormInstance,
  finishFormInstance,
  loadFormInstanceRow,
  saveFormResponses,
  startFormInstance,
  type FormInstanceRow,
} from './form-instance.service';

const p = (value: string | string[]): string =>
  Array.isArray(value) ? value[0] : value;

const toPublicFormInstance = (row: FormInstanceRow) => ({
  id: row.id,
  clientId: row.client_id,
  formTemplateVersionId: row.form_template_version_id,
  status: row.status,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  completedByUserId: row.completed_by_user_id ?? null,
  assigneeType: row.assignee_type ?? null,
  assignedWorkforceProfileId: row.assigned_workforce_profile_id ?? null,
  assignedTeamId: row.assigned_team_id ?? null,
  assignmentSnapshotAt: row.assignment_snapshot_at ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const row = await createFormInstance(p(req.params.versionId), req.auth.userId);
    sendSuccess(res, toPublicFormInstance(row), 201);
  } catch (error) {
    next(error);
  }
}

async function get(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(
      res,
      toPublicFormInstance(await loadFormInstanceRow(p(req.params.id), req.auth.userId)),
    );
  } catch (error) {
    next(error);
  }
}

async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const clientIds = await contextAccessService.getAccessibleClientIds(req.auth.userId);
    const result = await getPool().query<FormInstanceRow>(
      'SELECT * FROM form_instances WHERE client_id = ANY($1::uuid[]) ORDER BY created_at DESC',
      [clientIds],
    );
    sendSuccess(res, result.rows.map(toPublicFormInstance));
  } catch (error) {
    next(error);
  }
}

async function start(req: Request, res: Response, next: NextFunction) {
  try {
    const row = await startFormInstance(p(req.params.id), req.auth.userId);
    sendSuccess(res, toPublicFormInstance(row));
  } catch (error) {
    next(error);
  }
}

async function responses(req: Request, res: Response, next: NextFunction) {
  try {
    const instance = await loadFormInstanceRow(p(req.params.id), req.auth.userId);
    const result = await getPool().query(
      `SELECT r.*, f.code, f.field_type, f.required
         FROM form_responses r
         JOIN form_template_version_fields f ON f.id = r.version_field_id
        WHERE r.form_instance_id = $1`,
      [instance.id],
    );
    sendSuccess(res, result.rows);
  } catch (error) {
    next(error);
  }
}

async function save(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await saveFormResponses(p(req.params.id), req.auth.userId, req.body));
  } catch (error) {
    next(error);
  }
}

async function finish(req: Request, res: Response, next: NextFunction) {
  try {
    const action = req.path.endsWith('complete') ? 'complete' : 'cancel';
    const row = await finishFormInstance(p(req.params.id), req.auth.userId, action);
    sendSuccess(res, toPublicFormInstance(row));
  } catch (error) {
    next(error);
  }
}

export function createFormInstanceRouter() {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('form_template.manage');
  const read = requirePermission('form_template.read');

  router.post('/form-template-versions/:versionId/instances', auth, manage, create);
  router.get('/form-instances/:id', auth, read, get);
  router.get('/form-instances', auth, read, list);
  router.post('/form-instances/:id/start', auth, manage, start);
  router.get('/form-instances/:id/responses', auth, read, responses);
  router.put('/form-instances/:id/responses', auth, manage, save);
  router.post('/form-instances/:id/complete', auth, manage, finish);
  router.post('/form-instances/:id/cancel', auth, manage, finish);
  return router;
}
