import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { auditService, toPublicAuditEvent } from './audit.service';
import { parseAuditQuery } from './audit.validation';

export async function listAuditEventsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseAuditQuery(
      req.query as Record<string, unknown>,
    );
    const { items, total } = await auditService.listEvents(filters);

    sendSuccess(res, items.map(toPublicAuditEvent), 200, {
      limit: filters.limit,
      offset: filters.offset,
      total,
    });
  } catch (error) {
    next(error);
  }
}
