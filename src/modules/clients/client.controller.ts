import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { clientService } from './client.service';
import {
  parseClientIdParam,
  parseCreateClientBody,
  parseUpdateClientBody,
} from './client.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createClientHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateClientBody(req.body);
    const client = await clientService.createClient(input);
    sendSuccess(res, client, 201);
  } catch (error) {
    next(error);
  }
}

export async function listClientsHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clients = await clientService.listClients();
    sendSuccess(res, clients);
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
    const client = await clientService.getClientById(id);
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
    const client = await clientService.updateClient(id, input);
    sendSuccess(res, client);
  } catch (error) {
    next(error);
  }
}
