import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { findingService, parseFindingIdParam } from '../findings';
import { findingHistoryService } from './finding-history.service';
import { parseFindingHistoryFilters } from './finding-history.validation';

const param = (value: string | string[]) => Array.isArray(value) ? '' : value;
export async function getFindingHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const findingId = parseFindingIdParam(param(req.params.id));
    const finding = await findingService.getFindingById(findingId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      finding.buildingId,
    );
    sendSuccess(
      res,
      await findingHistoryService.getFindingHistory(
        findingId,
        parseFindingHistoryFilters(req.query),
      ),
    );
  } catch (error) { next(error); }
}
