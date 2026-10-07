import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { appVersionService } from './app-version.service';

/**
 * BE-25M — App version metadata handler.
 *
 *   GET /mobile/app-version/:platform?appVersion=<running version>
 *
 * Public (no authentication) so the app can check for a required update
 * before login. `appVersion` (the caller's running version) is optional and
 * only used to compute the update flags.
 */
export async function getAppVersionMetadataHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const platform = Array.isArray(req.params.platform) ? '' : req.params.platform;
    const appVersion =
      typeof req.query.appVersion === 'string' ? req.query.appVersion : undefined;
    const metadata = await appVersionService.getAppVersionMetadata(
      platform,
      appVersion,
    );
    sendSuccess(res, metadata);
  } catch (error) {
    next(error);
  }
}
