import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { workforceSkillService } from './workforce-skill.service';
import {
  parseAssignWorkforceSkillBody,
  parseSkillIdParam,
  parseUpdateWorkforceSkillBody,
  parseWorkforceIdParam,
} from './workforce-skill.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function assignWorkforceSkillHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // The Workforce Profile always comes from the route, never from the body.
    const workforceProfileId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const input = parseAssignWorkforceSkillBody(req.body);
    const assignment = await workforceSkillService.assignSkillToWorkforce({
      ...input,
      workforceProfileId,
    });
    sendSuccess(res, assignment, 201);
  } catch (error) {
    next(error);
  }
}

export async function listWorkforceSkillsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const assignments =
      await workforceSkillService.listWorkforceSkills(workforceProfileId);
    sendSuccess(res, assignments);
  } catch (error) {
    next(error);
  }
}

/**
 * BE-03D3 — the currently-in-force Skills for a Workforce Profile.
 *
 * Distinct from the plain list endpoint, which returns the full assignment
 * history including deactivated and out-of-window rows.
 */
export async function listEffectiveWorkforceSkillsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const skills =
      await workforceSkillService.resolveEffectiveSkillsForWorkforce(
        workforceProfileId,
      );
    sendSuccess(res, skills);
  } catch (error) {
    next(error);
  }
}

/**
 * Updates an assignment. Deactivation is the same endpoint with
 * `{ "status": "INACTIVE" }` — the row is kept for auditability.
 */
export async function updateWorkforceSkillHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const skillId = parseSkillIdParam(paramString(req.params.skillId));
    const input = parseUpdateWorkforceSkillBody(req.body);
    const assignment =
      await workforceSkillService.updateWorkforceSkillAssignment(
        workforceProfileId,
        skillId,
        input,
      );
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}
