import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  buildPaginationMeta,
  hasPaginationParams,
  parsePagination,
} from '../../shared/pagination';
import { notificationHistoryService } from './notification-history.service';
import {
  parseHistoryChannelParam,
  parseHistoryFilters,
  parseHistoryIdParam,
} from './notification-history.validation';

/**
 * BE-26K — Notification history handlers.
 *
 *   GET /notification-history                     list the user's history
 *   GET /notification-history/:channel/:historyId get one history item
 *
 * Self-scoped reads of the authenticated user's own delivery history
 * (read model only — no create/update/delete).
 */

const param = (value: string | string[]): string =>
  Array.isArray(value) ? '' : value;

export async function listHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.auth.userId;
    const filters = parseHistoryFilters(req.query);

    if (hasPaginationParams(req.query)) {
      const pg = parsePagination(req.query);
      const total = await notificationHistoryService.countHistory(userId, filters);
      const items = await notificationHistoryService.listHistory(
        userId,
        filters,
        pg.limit,
        pg.offset,
      );
      sendSuccess(
        res,
        items,
        200,
        buildPaginationMeta(pg.page, pg.pageSize, total),
      );
      return;
    }

    sendSuccess(res, await notificationHistoryService.listHistory(userId, filters));
  } catch (error) {
    next(error);
  }
}

export async function getHistoryItemHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const channel = parseHistoryChannelParam(param(req.params.channel));
    const id = parseHistoryIdParam(param(req.params.historyId));
    sendSuccess(
      res,
      await notificationHistoryService.getHistoryItem(req.auth.userId, channel, id),
    );
  } catch (error) {
    next(error);
  }
}
