import type { Response } from 'express';
import { AppError, categoryForError, isRetryableStatus } from './errors';
import type { ErrorCategory } from './errors';

export type ApiSuccess<T> = {
  success: true;
  data: T;
  meta: Record<string, unknown>;
};

/**
 * BE-25K — Mobile error contract body.
 *
 * Additive extensions to the shared error envelope (Web compatibility is
 * preserved — `code` / `message` / `details` are unchanged):
 *   - `category`      — stable machine-readable classification
 *     (VALIDATION / UNAUTHORIZED / FORBIDDEN / NOT_FOUND / CONFLICT /
 *     RATE_LIMITED / SERVER),
 *   - `retryable`     — true for 5xx / 429, false for client errors,
 *   - `requestId`     — correlation id (same as the X-Request-ID header),
 *   - `resource`      — resource/context reference where useful,
 *   - `conflict`      — conflict metadata where applicable (BE-25I shape).
 * Stack traces and sensitive details are never included.
 */
export type ApiErrorBody = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown[];
    category?: ErrorCategory;
    retryable?: boolean;
    requestId?: string;
    resource?: { type: string; id: string };
    conflict?: unknown;
  };
};

export type ErrorMeta = {
  requestId?: string;
};

export function sendSuccess<T>(
  res: Response,
  data: T,
  status = 200,
  meta: Record<string, unknown> = {},
): void {
  const body: ApiSuccess<T> = {
    success: true,
    data,
    meta,
  };
  res.status(status).json(body);
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown[],
  meta: ErrorMeta = {},
): void {
  const body: ApiErrorBody = {
    success: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      category: categoryForError(status, code),
      retryable: isRetryableStatus(status),
      ...(meta.requestId ? { requestId: meta.requestId } : {}),
    },
  };
  res.status(status).json(body);
}

export function sendAppError(
  res: Response,
  error: AppError,
  meta: ErrorMeta = {},
): void {
  const body: ApiErrorBody = {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      category: categoryForError(error.statusCode, error.code),
      retryable: isRetryableStatus(error.statusCode),
      ...(meta.requestId ? { requestId: meta.requestId } : {}),
      ...(error.resource ? { resource: error.resource } : {}),
      ...(error.conflict !== undefined ? { conflict: error.conflict } : {}),
    },
  };
  res.status(error.statusCode).json(body);
}
