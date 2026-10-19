import type { NextFunction, Request, Response } from 'express';
import { auditContextFromRequest } from '../audit';
import { sendSuccess } from '../../shared/api-response';
import { buildPaginationMeta } from '../../shared/pagination';
import { clientService } from './client.service';
import { resolveClientReadScope } from './client.scope';
import {
  parseClientIdParam,
  parseClientListQuery,
  parseCreateClientBody,
  parseUpdateClientBody,
} from './client.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** Correlation + actor context for the security audit trail. */
function actorAudit(req: Request) {
  return { ...auditContextFromRequest(req), actorUserId: req.auth.userId };
}

export async function createClientHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateClientBody(req.body);
    const client = await clientService.createClient(input, actorAudit(req));
    sendSuccess(res, client, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * CR-HM-BE-CLIENT-MASTER-01 — registry listing.
 *
 * Authorization is unchanged at the RBAC layer (`client.read`). On top of it,
 * the response is limited to the caller's Client reach: the Owner
 * (PLATFORM_ADMIN) sees the installation-wide registry; every other caller
 * sees only the Clients reachable through their ACTIVE Building assignments.
 *
 * `status` / `search` filters and `page` / `pageSize` pagination are optional.
 * Without pagination parameters the endpoint keeps its historical unbounded
 * array response (no `meta`).
 */
export async function listClientsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = parseClientListQuery(req.query as Record<string, unknown>);
    const scope = await resolveClientReadScope(req.auth.userId);
    const options = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.search === undefined ? {} : { search: query.search }),
      scope,
      ...(query.pagination === undefined
        ? {}
        : { limit: query.pagination.limit, offset: query.pagination.offset }),
    };

    const clients = await clientService.listClients(options);

    if (!query.pagination) {
      sendSuccess(res, clients);
      return;
    }

    const total = await clientService.countClients(options);
    sendSuccess(
      res,
      clients,
      200,
      buildPaginationMeta(
        query.pagination.page,
        query.pagination.pageSize,
        total,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getClientHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseClientIdParam(paramString(req.params.id));
    const scope = await resolveClientReadScope(req.auth.userId);
    const client = await clientService.getClientById(id, scope);
    sendSuccess(res, client);
  } catch (error) {
    next(error);
  }
}

export async function updateClientHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseClientIdParam(paramString(req.params.id));
    const input = parseUpdateClientBody(req.body);
    const scope = await resolveClientReadScope(req.auth.userId);
    const client = await clientService.updateClient(id, input, scope, actorAudit(req));
    sendSuccess(res, client);
  } catch (error) {
    next(error);
  }
}
