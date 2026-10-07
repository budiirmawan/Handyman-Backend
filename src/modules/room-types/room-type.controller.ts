import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { roomTypeService } from './room-type.service';
import {
  parseCreateRoomTypeBody,
  parseRoomTypeClientIdParam,
  parseRoomTypeIdParam,
  parseUpdateRoomTypeBody,
} from './room-type.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createRoomTypeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseRoomTypeClientIdParam(
      paramString(req.params.clientId),
    );
    const input = parseCreateRoomTypeBody(req.body);
    const roomType = await roomTypeService.createRoomType({
      ...input,
      clientId,
    });
    sendSuccess(res, roomType, 201);
  } catch (error) {
    next(error);
  }
}

export async function listClientRoomTypesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseRoomTypeClientIdParam(
      paramString(req.params.clientId),
    );
    const roomTypes = await roomTypeService.listRoomTypesByClient(clientId);
    sendSuccess(res, roomTypes);
  } catch (error) {
    next(error);
  }
}

export async function getRoomTypeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseRoomTypeIdParam(paramString(req.params.id));
    const roomType = await roomTypeService.getRoomTypeById(id);
    sendSuccess(res, roomType);
  } catch (error) {
    next(error);
  }
}

export async function updateRoomTypeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseRoomTypeIdParam(paramString(req.params.id));
    const input = parseUpdateRoomTypeBody(req.body);
    const roomType = await roomTypeService.updateRoomType(id, input);
    sendSuccess(res, roomType);
  } catch (error) {
    next(error);
  }
}
