import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { clientConfigurationService } from './client-configuration.service';
import {
  parseClientConfigurationClientIdParam,
  parseClientConfigurationFilters,
  parseClientConfigurationIdParam,
  parseCreateClientConfigurationBody,
  parseUpdateClientConfigurationBody,
} from './client-configuration.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function userId(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createClientConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseClientConfigurationClientIdParam(
      param(req.params.clientId),
    );
    const input = parseCreateClientConfigurationBody(req.body);
    sendSuccess(
      res,
      await clientConfigurationService.createClientConfiguration(
        { ...input, clientId },
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listClientConfigurationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseClientConfigurationClientIdParam(
      param(req.params.clientId),
    );
    const filters = parseClientConfigurationFilters(req.query.status);
    sendSuccess(
      res,
      await clientConfigurationService.listClientConfigurations(
        clientId,
        filters,
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getEffectiveClientConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseClientConfigurationClientIdParam(
      param(req.params.clientId),
    );
    sendSuccess(
      res,
      await clientConfigurationService.getEffectiveClientConfiguration(
        clientId,
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getClientConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await clientConfigurationService.getClientConfigurationById(
        parseClientConfigurationIdParam(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateClientConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await clientConfigurationService.updateClientConfiguration(
        parseClientConfigurationIdParam(param(req.params.id)),
        parseUpdateClientConfigurationBody(req.body),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
