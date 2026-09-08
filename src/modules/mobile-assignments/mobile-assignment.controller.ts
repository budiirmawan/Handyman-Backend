import type { NextFunction, Request, Response } from 'express';
import {
  buildPaginationMeta,
  hasPaginationParams,
  parsePagination,
} from '../../shared/pagination';
import { sendSuccess } from '../../shared/api-response';
import { mobileAssignmentService } from './mobile-assignment.service';

/**
 * BE-25C — Mobile assignment feed handler.
 *
 *   GET /mobile/assignments (?page=&pageSize=)
 *
 * Requires `task.read` and `work_order.read` (the union of the surfaced
 * domains); `availableActions` is additionally gated on the caller's
 * `task.manage` / `work_order.manage` permissions.
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
    const result = await mobileAssignmentService.listMobileAssignments(
      req.auth.userId,
      pagination,
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
