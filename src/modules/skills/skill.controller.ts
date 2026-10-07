import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { skillService } from './skill.service';
import {
  parseCreateSkillBody,
  parseSkillClientIdParam,
  parseSkillIdParam,
} from './skill.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createSkillHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // The Client always comes from the route, never from the body, so a Skill
    // cannot be planted into a different Client's catalog.
    const clientId = parseSkillClientIdParam(paramString(req.params.clientId));
    const input = parseCreateSkillBody(req.body);
    const skill = await skillService.createSkill({ ...input, clientId });
    sendSuccess(res, skill, 201);
  } catch (error) {
    next(error);
  }
}

export async function listClientSkillsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseSkillClientIdParam(paramString(req.params.clientId));
    const skills = await skillService.listSkillsByClient(clientId);
    sendSuccess(res, skills);
  } catch (error) {
    next(error);
  }
}

export async function getSkillHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSkillIdParam(paramString(req.params.id));
    const skill = await skillService.getSkillById(id);
    sendSuccess(res, skill);
  } catch (error) {
    next(error);
  }
}
