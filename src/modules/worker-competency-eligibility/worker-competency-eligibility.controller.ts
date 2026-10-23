import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  buildPaginationMeta,
  parsePagination,
} from '../../shared/pagination';
import { isValidUuid } from '../clients';
import {
  listAssignmentCompetencyHistory,
  workerCompetencyEligibilityService,
} from './worker-competency-eligibility.service';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — eligibility / candidates transport.
 *
 * Both handlers are READ-ONLY and take the actor from the authenticated session.
 * The building scope (`assertBuildingScopedResourceAccess`) is enforced inside
 * the service, so a broad `tenant_company.read` never reaches another Client's
 * crews — the same rule the assignment surface already follows.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function uuidOrValidationError(value: string, field: string): string {
  const raw = value.trim();
  if (!isValidUuid(raw)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a UUID.` },
    ]);
  }
  return raw;
}

export async function getCrewCompetencyEligibilityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewIdRaw =
      (Array.isArray(req.query.crewId) ? req.query.crewId[0] : req.query.crewId) ??
      '';
    sendSuccess(
      res,
      await workerCompetencyEligibilityService.getCrewCompetencyEligibility(
        uuidOrValidationError(
          param(req.params.executionScopeId),
          'executionScopeId',
        ),
        uuidOrValidationError(String(crewIdRaw), 'crewId'),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listCompetencyCandidatesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await workerCompetencyEligibilityService.listCompetencyCandidates(
        uuidOrValidationError(
          param(req.params.executionScopeId),
          'executionScopeId',
        ),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

function queryString(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  return text === '' ? undefined : text;
}

function parseBoolean(value: unknown, field: string): boolean | undefined {
  const text = queryString(value);
  if (text === undefined) return undefined;
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw AppError.validation('Request validation failed.', [
    { field, message: `${field} must be either true or false.` },
  ]);
}

function parseEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const text = queryString(value);
  if (text === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(text)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be one of ${allowed.join(', ')}.` },
    ]);
  }
  return text as T;
}

/**
 * PART 03B1 — `GET /handyman/execution-scopes/:executionScopeId/competency/history`
 *
 * Append-only competency decision history for the scope, paginated through the
 * shared BE-25A contract (`page`/`pageSize`; `meta` then carries
 * `page/pageSize/total/totalPages`). Read-only: no surface can mutate or delete
 * a decision.
 */
export async function listAssignmentCompetencyHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assignmentId = queryString(req.query.assignmentId);
    const crewId = queryString(req.query.crewId);
    const workerContextId = queryString(req.query.workerContextId);
    for (const [field, value] of [
      ['assignmentId', assignmentId],
      ['crewId', crewId],
      ['workerContextId', workerContextId],
    ] as const) {
      if (value !== undefined && !isValidUuid(value)) {
        throw AppError.validation('Request validation failed.', [
          { field, message: `${field} must be a UUID.` },
        ]);
      }
    }

    const action = parseEnum(req.query.action, 'action', [
      'ASSIGNED',
      'REASSIGNED',
    ] as const);
    const enforcementLevel = parseEnum(
      req.query.enforcementLevel,
      'enforcementLevel',
      ['MANDATORY', 'RECOMMENDED'] as const,
    );
    const satisfied = parseBoolean(req.query.satisfied, 'satisfied');

    const pg = parsePagination(req.query);
    const result = await listAssignmentCompetencyHistory(
      uuidOrValidationError(
        param(req.params.executionScopeId),
        'executionScopeId',
      ),
      {
        ...(action ? { action } : {}),
        ...(assignmentId ? { assignmentId } : {}),
        ...(crewId ? { crewId } : {}),
        ...(workerContextId ? { workerContextId } : {}),
        ...(satisfied === undefined ? {} : { satisfied }),
        ...(enforcementLevel ? { enforcementLevel } : {}),
      },
      { limit: pg.pageSize, offset: pg.offset },
      actor(req),
    );

    sendSuccess(
      res,
      result.items,
      200,
      buildPaginationMeta(pg.page, pg.pageSize, result.total),
    );
  } catch (error) {
    next(error);
  }
}
