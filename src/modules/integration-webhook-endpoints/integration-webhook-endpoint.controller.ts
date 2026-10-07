import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { integrationWebhookEndpointService as service } from './integration-webhook-endpoint.service';
import {
  parseCreateIntegrationWebhookEndpointBody,
  parseIntegrationWebhookEndpointFilters,
  parseIntegrationWebhookEndpointIdParam,
  parseUpdateIntegrationWebhookEndpointBody,
} from './integration-webhook-endpoint.validation';

/**
 * CR-BE-INTEG-01 PART 02 — webhook endpoint configuration handlers.
 *
 * The signing secret appears in exactly two responses: create (201) and
 * rotate-secret (200). Every other handler serves the secret-free
 * projection.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function userId(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createIntegrationWebhookEndpointHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateIntegrationWebhookEndpointBody(req.body);
    sendSuccess(
      res,
      await service.createIntegrationWebhookEndpoint(input, userId(req)),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listIntegrationWebhookEndpointsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseIntegrationWebhookEndpointFilters(req.query);
    sendSuccess(res, await service.listIntegrationWebhookEndpoints(filters, userId(req)));
  } catch (error) {
    next(error);
  }
}

export async function getIntegrationWebhookEndpointHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseIntegrationWebhookEndpointIdParam(param(req.params.id));
    sendSuccess(res, await service.getIntegrationWebhookEndpointById(id, userId(req)));
  } catch (error) {
    next(error);
  }
}

export async function updateIntegrationWebhookEndpointHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseIntegrationWebhookEndpointIdParam(param(req.params.id));
    const input = parseUpdateIntegrationWebhookEndpointBody(req.body);
    sendSuccess(
      res,
      await service.updateIntegrationWebhookEndpoint(id, input, userId(req)),
    );
  } catch (error) {
    next(error);
  }
}

export async function rotateIntegrationWebhookEndpointSecretHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseIntegrationWebhookEndpointIdParam(param(req.params.id));
    sendSuccess(
      res,
      await service.rotateIntegrationWebhookEndpointSecret(id, userId(req)),
    );
  } catch (error) {
    next(error);
  }
}
