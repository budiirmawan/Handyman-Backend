import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../shared/errors';

export function notFoundHandler(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next(AppError.notFound());
}
