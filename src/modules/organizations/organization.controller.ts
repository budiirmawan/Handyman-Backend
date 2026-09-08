import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { organizationService } from './organization.service';
import {
  parseClientIdParam,
  parseOrganizationIdParam,
  parseCreateOrganizationBody,
  parseUpdateOrganizationBody,
} from './organization.validation';

/** Extract a string from Express v5 route params (typed as string|string[]). */
function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** Extract a string from Express v5 query params (typed as ParsedQs). */
function queryString(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return '';
}

export async function createOrganizationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateOrganizationBody(req.body);
    const org = await organizationService.createOrganization(input);
    sendSuccess(res, org, 201);
  } catch (error) {
    next(error);
  }
}

export async function listOrganizationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseClientIdParam(queryString(req.query.clientId));
    const orgs = await organizationService.listOrganizationsByClient(clientId);
    sendSuccess(res, orgs);
  } catch (error) {
    next(error);
  }
}

export async function getOrganizationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseOrganizationIdParam(paramString(req.params.id));
    const org = await organizationService.getOrganizationById(id);
    sendSuccess(res, org);
  } catch (error) {
    next(error);
  }
}

export async function updateOrganizationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseOrganizationIdParam(paramString(req.params.id));
    const input = parseUpdateOrganizationBody(req.body);
    const org = await organizationService.updateOrganization(id, input);
    sendSuccess(res, org);
  } catch (error) {
    next(error);
  }
}
