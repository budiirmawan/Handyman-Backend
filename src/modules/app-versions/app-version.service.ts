import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import type {
  AppVersionRecord,
  AppVersionPlatform,
  MobileAppVersionMetadata,
} from './app-version.types';

/**
 * BE-25M — App version metadata service (read-only).
 *
 * Returns the platform's supported version metadata. The contract is public
 * (no authentication required) so the app can check for required updates
 * before login; it carries no sensitive data.
 */

const VERSION_PATTERN = /^\d+(\.\d+){0,3}$/;

function isVersionBelow(value: string, reference: string): boolean {
  const a = value.split('.').map((part) => Number(part) || 0);
  const b = reference.split('.').map((part) => Number(part) || 0);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) {
      return av < bv;
    }
  }
  return false;
}

function toPublicRecord(row: AppVersionRecord): MobileAppVersionMetadata {
  return {
    platform: row.platform,
    currentVersion: row.currentVersion,
    minimumSupportedVersion: row.minimumVersion,
    updateRequired: false,
    updateAvailable: false,
    release: {
      version: row.currentVersion,
      notes: row.releaseNotes,
      date: row.releaseDate?.toISOString() ?? null,
    },
  };
}

/**
 * Returns the ACTIVE app version metadata for a platform. When the client
 * supplies its running `appVersion`, the update flags are computed against
 * the authoritative versions; otherwise the flags default to false.
 */
export async function getAppVersionMetadata(
  platform: string,
  appVersion?: string | null,
): Promise<MobileAppVersionMetadata> {
  if (platform !== 'ANDROID' && platform !== 'IOS') {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'platform',
        message: 'platform must be ANDROID or IOS.',
      },
    ]);
  }
  if (appVersion !== undefined && appVersion !== null) {
    if (typeof appVersion !== 'string' || !VERSION_PATTERN.test(appVersion)) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'appVersion',
          message: 'appVersion must be a numeric version string like "1.2.3".',
        },
      ]);
    }
  }

  const result = await getPool().query<AppVersionRecord>(
    `SELECT id, platform, current_version AS "currentVersion",
            minimum_version AS "minimumVersion", release_notes AS "releaseNotes",
            release_date AS "releaseDate", status, created_at AS "createdAt",
            updated_at AS "updatedAt"
       FROM mobile_app_versions
      WHERE platform = $1 AND status = 'ACTIVE'
      ORDER BY updated_at DESC
      LIMIT 1`,
    [platform],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError({
      code: ERROR_CODES.NOT_FOUND,
      message: 'No active app version metadata for this platform.',
      statusCode: 404,
      resource: { type: 'APP_VERSION', id: platform },
    });
  }

  const metadata = toPublicRecord(row);
  if (appVersion) {
    metadata.updateRequired = isVersionBelow(appVersion, row.minimumVersion);
    metadata.updateAvailable = isVersionBelow(appVersion, row.currentVersion);
  }
  return metadata;
}

export const appVersionService = { getAppVersionMetadata };
