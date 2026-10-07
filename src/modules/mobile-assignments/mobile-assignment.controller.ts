import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import {
  buildPaginationMeta,
  hasPaginationParams,
  parsePagination,
} from '../../shared/pagination';
import { sendSuccess } from '../../shared/api-response';
import { mobileAssignmentService } from './mobile-assignment.service';
import type { MobileAssignmentProjectionMode } from './mobile-assignment.types';
import { MOBILE_ASSIGNMENT_SHIFT_PROJECTIONS } from './mobile-assignment.types';

/**
 * MOB-C04 PART 01A — Resolve the `shift` projection selector.
 *
 * Only `shift=current` is supported; it selects the now-live current-shift
 * projection and never carries building/shift/post authority (that stays
 * backend-derived). Absent → default (all accessible active assignments).
 * Any other `shift` value is a validation error rather than a silent fallback.
 */
function resolveShiftProjection(
  query: Record<string, unknown>,
): MobileAssignmentProjectionMode {
  const raw = query.shift;
  if (raw === undefined || raw === null) {
    return 'default';
  }
  if (typeof raw !== 'string' || Array.isArray(query.shift)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'shift', message: 'shift must be a single supported value.' },
    ]);
  }
  if (
    (MOBILE_ASSIGNMENT_SHIFT_PROJECTIONS as readonly string[]).includes(raw)
  ) {
    return raw === 'current' ? 'currentShift' : 'default';
  }
  throw AppError.validation('Request validation failed.', [
    {
      field: 'shift',
      message: `shift must be one of: ${MOBILE_ASSIGNMENT_SHIFT_PROJECTIONS.join(', ')}.`,
    },
  ]);
}

/**
 * BE-25C / MOB-C04 PART 01A — Mobile assignment feed handler.
 *
 *   GET /mobile/assignments                  (?page=&pageSize=)
 *   GET /mobile/assignments?shift=current    (?page=&pageSize=)
 *
 * Default returns every accessible active assignment. `shift=current` returns
 * only the work in the worker's authoritative current-shift buildings (200
 * with an empty array when not on shift). Requires `task.read` and
 * `work_order.read` (the union of the surfaced domains); `availableActions`
 * is additionally gated on the caller's `task.manage` / `work_order.manage`
 * permissions.
 */
export async function listMobileAssignmentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const pagination = hasPaginationParams(req.query)
      ? parsePagination(req.query)
      : null;
    const mode = resolveShiftProjection(req.query);
    const result = await mobileAssignmentService.listMobileAssignments(
      req.auth.userId,
      pagination,
      { mode },
    );
    if (pagination) {
      sendSuccess(
        res,
        result.items,
        200,
        buildPaginationMeta(pagination.page, pagination.pageSize, result.total),
      );
      return;
    }
    sendSuccess(res, result.items);
  } catch (error) {
    next(error);
  }
}
