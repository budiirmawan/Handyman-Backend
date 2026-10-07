import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { securityLogbookService } from './security-logbook.service';
import {
  parseCreateSecurityLogbookBody,
  parseSecurityLogbookListQuery,
  parseUpdateSecurityLogbookBody,
} from './security-logbook.validation';

/**
 * CR-BE-MOB-05 PART 03 — Security Logbook controllers.
 *
 * All endpoints are session-scoped: the entry's Workforce Profile is
 * resolved from the authenticated session and never accepted from the
 * request; timestamps are set by the backend. Building isolation is
 * enforced per operation (BE-02F/G).
 */

/** POST /buildings/:buildingId/security/logbook */
export async function createLogbookEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateSecurityLogbookBody(
      req.body as Record<string, unknown>,
    );
    const entry = await securityLogbookService.createLogbookEntry(
      input,
      req.auth.userId,
    );
    sendSuccess(res, entry, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /buildings/:buildingId/security/logbook */
export async function listLogbookEntriesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = String(req.params.buildingId);
    const filters = parseSecurityLogbookListQuery(
      req.query as Record<string, unknown>,
    );
    const entries = await securityLogbookService.listLogbookEntries(
      buildingId,
      filters,
      securityLogbookService.logbookRange(filters),
      req.auth.userId,
    );
    sendSuccess(res, entries);
  } catch (error) {
    next(error);
  }
}

/** GET /security/logbook/:id */
export async function getLogbookEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const entry = await securityLogbookService.getLogbookEntry(
      String(req.params.id),
      req.auth.userId,
    );
    sendSuccess(res, entry);
  } catch (error) {
    next(error);
  }
}

/** PATCH /security/logbook/:id */
export async function updateLogbookEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseUpdateSecurityLogbookBody(
      req.body as Record<string, unknown>,
    );
    const entry = await securityLogbookService.updateLogbookEntry(
      String(req.params.id),
      input,
      req.auth.userId,
    );
    sendSuccess(res, entry);
  } catch (error) {
    next(error);
  }
}
