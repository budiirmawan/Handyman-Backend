import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { securityPostService } from './security-post.service';
import {
  parseSecurityPostBuildingIdParam,
  parseSecurityPostFilter,
  parseSecurityPostIdParam,
  parseCreateSecurityPostBody,
  parseUpdateSecurityPostBody,
} from './security-post.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function createSecurityPostHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseSecurityPostBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const input = parseCreateSecurityPostBody(req.body);
    const securityPost = await securityPostService.createSecurityPost({
      ...input,
      buildingId,
    });
    sendSuccess(res, securityPost, 201);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingSecurityPostsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseSecurityPostBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const filter = parseSecurityPostFilter(
      req.query as Record<string, unknown>,
    );
    const securityPosts =
      await securityPostService.listSecurityPostsByBuilding(buildingId, filter);
    sendSuccess(res, securityPosts);
  } catch (error) {
    next(error);
  }
}

export async function getSecurityPostHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSecurityPostIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const securityPost = await securityPostService.getSecurityPostById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      securityPost.buildingId,
    );

    sendSuccess(res, securityPost);
  } catch (error) {
    next(error);
  }
}

export async function updateSecurityPostHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSecurityPostIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing = await securityPostService.getSecurityPostById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const input = parseUpdateSecurityPostBody(req.body);
    const updated = await securityPostService.updateSecurityPost(id, input);
    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}
