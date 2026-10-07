import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { resolveRoomBuildingId, spaceService } from './space.service';
import {
  parseCreateSpaceBody,
  parseSpaceIdParam,
  parseSpaceRoomIdParam,
  parseUpdateSpaceBody,
} from './space.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * Space routes carry no `buildingId` route parameter, so BE-02 Building
 * isolation is enforced here instead of via `requireBuildingAccess`: the
 * Room (or Space → Room) is resolved to its Building first (unknown parent →
 * 404), then the caller must hold an ACTIVE assignment to that Building
 * (otherwise 403 BUILDING_ACCESS_DENIED). Permission alone is never enough.
 */
async function assertRoomAccess(req: Request, roomId: string): Promise<void> {
  if (!req.auth) {
    throw authenticationRequiredError();
  }
  const buildingId = await resolveRoomBuildingId(roomId);
  await contextAccessService.assertBuildingAccess(req.auth.userId, buildingId);
}

export async function createSpaceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const roomId = parseSpaceRoomIdParam(paramString(req.params.roomId));
    await assertRoomAccess(req, roomId);

    const input = parseCreateSpaceBody(req.body);
    const space = await spaceService.createSpace({ ...input, roomId });
    sendSuccess(res, space, 201);
  } catch (error) {
    next(error);
  }
}

export async function listRoomSpacesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const roomId = parseSpaceRoomIdParam(paramString(req.params.roomId));
    await assertRoomAccess(req, roomId);

    const spaces = await spaceService.listSpacesByRoom(roomId);
    sendSuccess(res, spaces);
  } catch (error) {
    next(error);
  }
}

export async function getSpaceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSpaceIdParam(paramString(req.params.id));
    const space = await spaceService.getSpaceById(id);
    await assertRoomAccess(req, space.roomId);

    sendSuccess(res, space);
  } catch (error) {
    next(error);
  }
}

export async function updateSpaceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSpaceIdParam(paramString(req.params.id));
    const input = parseUpdateSpaceBody(req.body);

    const existing = await spaceService.getSpaceById(id);
    await assertRoomAccess(req, existing.roomId);

    const space = await spaceService.updateSpace(id, input);
    sendSuccess(res, space);
  } catch (error) {
    next(error);
  }
}
