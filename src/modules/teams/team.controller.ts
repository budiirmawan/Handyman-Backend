import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { teamService } from './team.service';
import {
  parseDepartmentIdParam,
  parseTeamIdParam,
  parseCreateTeamBody,
  parseUpdateTeamBody,
} from './team.validation';

/** Extract a string from Express v5 route params (typed as string|string[]). */
function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createTeamHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const departmentId = parseDepartmentIdParam(paramString(req.params.departmentId));
    const input = parseCreateTeamBody(req.body);
    const team = await teamService.createTeam({ ...input, departmentId });
    sendSuccess(res, team, 201);
  } catch (error) {
    next(error);
  }
}

export async function listTeamsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const departmentId = parseDepartmentIdParam(paramString(req.params.departmentId));
    const teams = await teamService.listTeamsByDepartment(departmentId);
    sendSuccess(res, teams);
  } catch (error) {
    next(error);
  }
}

export async function getTeamHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseTeamIdParam(paramString(req.params.id));
    const team = await teamService.getTeamById(id);
    sendSuccess(res, team);
  } catch (error) {
    next(error);
  }
}

export async function updateTeamHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseTeamIdParam(paramString(req.params.id));
    const input = parseUpdateTeamBody(req.body);
    const team = await teamService.updateTeam(id, input);
    sendSuccess(res, team);
  } catch (error) {
    next(error);
  }
}
