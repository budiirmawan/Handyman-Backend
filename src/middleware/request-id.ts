import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  REQUEST_CONTEXT_SOURCE,
  runWithRequestContext,
} from '../shared/request-context';

/**
 * The response header is also the public name of the canonical request id.
 * Caller-supplied values are deliberately not used as the authority.
 */
const REQUEST_ID_HEADER = 'X-Request-ID';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Creates the authoritative server-generated request id.
 *
 * The optional argument remains accepted for source compatibility with the
 * previous helper, but is intentionally ignored. A request id is a server
 * authority, not a caller-selected correlation or security value.
 */
export function resolveRequestId(_callerSuppliedId?: string): string {
  return randomUUID();
}

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = resolveRequestId(req.header('X-Request-ID'));
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  runWithRequestContext(
    { requestId, source: REQUEST_CONTEXT_SOURCE },
    () => next(),
  );
}
