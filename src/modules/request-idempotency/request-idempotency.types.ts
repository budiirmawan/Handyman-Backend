import type { PoolClient } from 'pg';

/**
 * CR-BE-IDEMPOTENCY-CORE-01 PART 01 — generic request idempotency foundation.
 *
 * Identity:
 *   actorUserId + server-defined operationKey + SHA-256(normalized Idempotency-Key)
 *
 * Equivalence:
 *   SHA-256(stable canonical JSON request fingerprint)
 *
 * Retention cleanup is separate infrastructure governance; correctness does
 * not depend on deletion.
 */

export type RequestIdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED';

export type RequestIdempotencyRecord = {
  id: string;
  actorUserId: string;
  operationKey: string;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  status: RequestIdempotencyStatus;
  responseStatus: number | null;
  responseBody: unknown | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type TryClaimInput = {
  actorUserId: string;
  operationKey: string;
  idempotencyKeyHash: string;
  requestFingerprint: string;
};

export type CompleteInput = {
  id: string;
  responseStatus: number;
  responseBody: unknown;
};

export type ExecuteIdempotentInput = {
  actorUserId: string;
  operationKey: string;
  idempotencyKey: string; // normalized key
  requestFingerprint: string; // 64-char lowercase SHA-256 hex
  work: (client: PoolClient) => Promise<{
    responseStatus: number;
    responseBody: unknown;
  }>;
};

export type ExecuteIdempotentResult = {
  responseStatus: number;
  responseBody: unknown;
  replayed: boolean;
};
