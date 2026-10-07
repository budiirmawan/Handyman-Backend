import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { moduleService } from './module.service';
import {
  parseCreateModuleBody,
  parseModuleIdParam,
  parseUpdateModuleStatusBody,
} from './module.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createModuleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateModuleBody(req.body);
    const module = await moduleService.createModule(input);
    sendSuccess(res, module, 201);
  } catch (error) {
    next(error);
  }
}

export async function listModulesHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const modules = await moduleService.listModules();
    sendSuccess(res, modules);
  } catch (error) {
    next(error);
  }
}

export async function getModuleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseModuleIdParam(paramString(req.params.id));
    const module = await moduleService.getModuleById(id);
    sendSuccess(res, module);
  } catch (error) {
    next(error);
  }
}

export async function updateModuleStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseModuleIdParam(paramString(req.params.id));
    const input = parseUpdateModuleStatusBody(req.body);
    const module = await moduleService.updateModuleStatus(id, input);
    sendSuccess(res, module);
  } catch (error) {
    next(error);
  }
}
