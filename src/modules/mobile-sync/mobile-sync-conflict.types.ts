/**
 * BE-25I — Sync Conflict Handling types.
 *
 * Conflict detection for BE-25G sync operations: the client sends the server
 * version it last saw (`baseVersion`, the resource's `updatedAt` ISO
 * timestamp). The server compares it with the CURRENT authoritative
 * `updatedAt` of the resource and, when the client's base is stale (older
 * than the current server version), returns a CONFLICT result carrying the
 * current server state/reference and retry/reload guidance — the write is
 * NOT executed and newer server data is never silently overwritten.
 *
 * No automatic merge logic exists (by design).
 */

export const MOBILE_SYNC_CONFLICT_CODE = 'SYNC_CONFLICT';

/** Per-operation conflict guidance embedded in the result. */
export type MobileSyncConflictGuidance = {
  /**
   * How the client should proceed. `reload` = re-fetch the resource and
   * re-apply the change on top of the fresh state (the backend never merges
   * automatically).
   */
  action: 'reload';
  /** The endpoint the client should re-fetch to get the current state. */
  reloadEndpoint: string;
  message: string;
};

/** The conflict payload returned in a CONFLICT result item. */
export type MobileSyncConflict = {
  code: typeof MOBILE_SYNC_CONFLICT_CODE;
  message: string;
  /** Current authoritative server state/reference of the resource. */
  current: unknown;
  /** Retry/reload guidance. */
  guidance: MobileSyncConflictGuidance;
};
