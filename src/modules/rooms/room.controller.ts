import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { resolveAreaBuildingId, roomService } from './room.service';
import {
  parseCreateRoomBody,
  parseRoomAreaIdParam,
  parseRoomIdParam,
  parseUpdateRoomBody,
} from './room.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * Room routes carry no `buildingId` route parameter, so BE-02 Building
 * isolation is enforced here instead of via `requireBuildingAccess`: the
 * Area (or Room → Area) is resolved to its Building first (unknown parent →
 * 404), then the caller must hold an ACTIVE assignment to that Building
 * (otherwise 403 BUILDING_ACCESS_DENIED). Permission alone is never enough.
 */
async function assertAreaAccess(req: Request, areaId: string): Promise<void> {
  if (!req.auth) {
    throw authenticationRequiredError();
  }
  const buildingId = await resolveAreaBuildingId(areaId);
  await contextAccessService.assertBuildingAccess(req.auth.userId, buildingId);
}

export async function createRoomHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const areaId = parseRoomAreaIdParam(paramString(req.params.areaId));
    await assertAreaAccess(req, areaId);

    const input = parseCreateRoomBody(req.body);
    const room = await roomService.createRoom({ ...input, areaId });
    sendSuccess(res, room, 201);
  } catch (error) {
    next(error);
  }
}

export async function listAreaRoomsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const areaId = parseRoomAreaIdParam(paramString(req.params.areaId));
    await assertAreaAccess(req, areaId);

    const rooms = await roomService.listRoomsByArea(areaId);
    sendSuccess(res, rooms);
  } catch (error) {
    next(error);
  }
}

export async function getRoomHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseRoomIdParam(paramString(req.params.id));
    const room = await roomService.getRoomById(id);
    await assertAreaAccess(req, room.areaId);

    sendSuccess(res, room);
  } catch (error) {
    next(error);
  }
}

export async function updateRoomHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseRoomIdParam(paramString(req.params.id));
    const input = parseUpdateRoomBody(req.body);

    const existing = await roomService.getRoomById(id);
    await assertAreaAccess(req, existing.areaId);

    const room = await roomService.updateRoom(id, input);
    sendSuccess(res, room);
  } catch (error) {
    next(error);
  }
}
