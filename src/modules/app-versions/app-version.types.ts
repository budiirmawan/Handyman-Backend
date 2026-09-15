/**
 * BE-25M — App Version Metadata types.
 *
 * Read-only metadata contract: per-platform supported app versions. The
 * backend reports versions and flags; it never builds update delivery and
 * never hardcodes Flutter UI behavior (clients decide their own UX from the
 * flags).
 */

export const APP_VERSION_PLATFORMS = ['ANDROID', 'IOS'] as const;
export type AppVersionPlatform = (typeof APP_VERSION_PLATFORMS)[number];

export type AppVersionRecord = {
  id: string;
  platform: AppVersionPlatform;
  currentVersion: string;
  minimumVersion: string;
  releaseNotes: string | null;
  releaseDate: Date | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The mobile app version metadata contract.
 *
 *   - `platform` — ANDROID / IOS.
 *   - `currentVersion` — the latest supported version.
 *   - `minimumSupportedVersion` — the oldest version still supported.
 *   - `updateRequired` — true when the client's version is BELOW the
 *     minimum (must update to keep working).
 *   - `updateAvailable` — true when the client's version is below the
 *     current version (an update exists).
 *   - `release` — optional release metadata (version, notes, date).
 *
 * Flags are computed against the client-supplied `appVersion`; a client
 * that omits its version receives the metadata with the flags derived from
 * the current version only (updateAvailable=false, updateRequired=false).
 */
export type MobileAppVersionMetadata = {
  platform: AppVersionPlatform;
  currentVersion: string;
  minimumSupportedVersion: string;
  updateRequired: boolean;
  updateAvailable: boolean;
  release: {
    version: string;
    notes: string | null;
    date: string | null;
  } | null;
};
