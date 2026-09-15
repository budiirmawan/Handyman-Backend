import { getPool } from '../../database';
import { DUE_ITEM_RETRIEVAL_LIMIT } from '../../shared/due-retrieval';
import { recordOperationalEvent } from '../operational-events';
import { createEvidenceStorage, isEvidenceStorageKey } from '../evidence/storage';
import type { EvidenceStorage } from '../evidence/storage';

/**
 * CR-BE-DOC-CONTROL-01 PART 04 — retention lifecycle + due execution
 * (START GOVERNANCE §7, §8).
 *
 * Lifecycle: ACTIVE → RETENTION_DUE → PURGED, with `retention_hold`
 * blocking only the final transition.
 *
 * PURGE = BINARY DISPOSAL + METADATA TOMBSTONE — NEVER ROW DELETION.
 * `bast_evidence_bindings` and `utility_meter_ocr_candidates` hold hard FKs into
 * `evidence_submissions`, and the engine's own rule is soft-remove /
 * append-only, so the row survives as a tombstone: retention snapshot,
 * `content_sha256`, `file_size`, `mime_type`, `original_file_name` and the
 * opaque `file_reference` are all retained; only the stored bytes are
 * removed (through the single existing storage abstraction — no new
 * storage system) and `retention_state = 'PURGED'` + `purged_at` are set.
 *
 * IDEMPOTENCY / RETRY SAFETY
 * --------------------------
 * - Due marking claims rows with `FOR UPDATE SKIP LOCKED` and a
 *   state-predicated UPDATE; a second run finds nothing to mark.
 * - Purging is guarded by `WHERE retention_state = 'RETENTION_DUE' AND
 *   retention_hold = false`; `storage.remove` is an idempotent no-op when
 *   the object is already absent, so a crash between removal and the state
 *   UPDATE is healed by the next tick (re-remove is a no-op, then the state
 *   lands).
 * - A storage failure leaves the row `RETENTION_DUE` (no partial tombstone
 *   — the state is only set AFTER successful disposal), records
 *   `EVIDENCE_PURGE_FAILED`, and the next tick retries naturally. Failures
 *   are isolated per row.
 * - A held row is never purged; `EVIDENCE_PURGE_HELD` is recorded once per
 *   hold (deduplicated against events since the hold was set), not per tick.
 *
 * Executed by the EXISTING due-job dispatcher (`processDueOperationalJobs`)
 * as one additive domain — no new scheduler. Batches are bounded by the
 * shared DUE_ITEM_RETRIEVAL_LIMIT so a large backlog cannot monopolize a
 * tick; leftovers stay due for the next pass.
 */

export type EvidenceRetentionExecutionResult = {
  /** Governed ACTIVE rows transitioned to RETENTION_DUE this run. */
  dueMarked: number;
  /** RETENTION_DUE rows whose binary was disposed and tombstone set. */
  purged: number;
  /** Due rows skipped because a retention hold blocks purging. */
  held: number;
  /** Per-row unexpected/storage failures (row stays RETENTION_DUE). */
  failures: number;
};

type DueRow = {
  id: string;
  client_id: string;
  file_reference: string | null;
  retained_until: Date;
  retention_policy_id: string | null;
  retention_policy_code: string | null;
  retention_hold: boolean;
  retention_hold_set_at: Date | null;
};

/** ACTIVE → RETENTION_DUE for governed rows whose retained_until elapsed. */
async function markRetentionDue(before: Date): Promise<DueRow[]> {
  const result = await getPool().query<DueRow>(
    `WITH due AS (
       SELECT id FROM evidence_submissions
        WHERE retention_state = 'ACTIVE'
          AND retained_until IS NOT NULL
          AND retained_until <= $1
        ORDER BY retained_until, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE evidence_submissions e
        SET retention_state = 'RETENTION_DUE', updated_at = NOW()
       FROM due
      WHERE e.id = due.id
      RETURNING e.id, e.client_id, e.file_reference, e.retained_until,
                e.retention_policy_id, e.retention_policy_code,
                e.retention_hold, e.retention_hold_set_at`,
    [before, DUE_ITEM_RETRIEVAL_LIMIT],
  );
  return result.rows;
}

/** Emits EVIDENCE_PURGE_HELD at most once per hold (never per tick). */
async function recordHeldOncePerHold(row: DueRow): Promise<void> {
  const existing = await getPool().query(
    `SELECT 1 FROM operational_events
      WHERE entity_type = 'EVIDENCE_SUBMISSION' AND entity_id = $1
        AND event_type = 'EVIDENCE_PURGE_HELD'
        AND occurred_at >= $2
      LIMIT 1`,
    [row.id, row.retention_hold_set_at],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    return;
  }
  await recordOperationalEvent({
    clientId: row.client_id,
    eventType: 'EVIDENCE_PURGE_HELD',
    entityType: 'EVIDENCE_SUBMISSION',
    entityId: row.id,
    actorUserId: null,
    summary: 'Retention hold prevented evidence purge',
    metadata: {
      evidenceId: row.id,
      retainedUntil: row.retained_until.toISOString(),
      policyId: row.retention_policy_id,
      policyCode: row.retention_policy_code,
    },
  });
}

/** Disposes the binary and sets the tombstone for one due row. */
async function purgeOne(row: DueRow, storage: EvidenceStorage): Promise<boolean> {
  // Dispose the stored bytes FIRST; the tombstone is only set after a
  // successful disposal so a crash in between is healed by the retry
  // (storage.remove is a no-op when already absent). References that are
  // not backend storage keys hold no backend-stored binary — there is
  // nothing to dispose, only the tombstone applies.
  const isStorageKey =
    !!row.file_reference && isEvidenceStorageKey(row.file_reference);
  if (isStorageKey) {
    await storage.remove(row.file_reference!);
  }

  const updated = await getPool().query<{ purged_at: Date }>(
    `UPDATE evidence_submissions
        SET retention_state = 'PURGED',
            purged_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND retention_state = 'RETENTION_DUE'
        AND retention_hold = false
      RETURNING purged_at`,
    [row.id],
  );
  if (updated.rowCount === 0) {
    // Lost the guard (state/hold changed concurrently) — not a failure;
    // the row is simply no longer purgeable this run.
    return false;
  }

  await recordOperationalEvent({
    clientId: row.client_id,
    eventType: 'EVIDENCE_PURGED',
    entityType: 'EVIDENCE_SUBMISSION',
    entityId: row.id,
    actorUserId: null,
    summary: 'Evidence purged by retention policy',
    metadata: {
      evidenceId: row.id,
      policyId: row.retention_policy_id,
      policyCode: row.retention_policy_code,
      retainedUntil: row.retained_until.toISOString(),
      purgedAt: updated.rows[0].purged_at.toISOString(),
      storageObjectRemoved: isStorageKey,
    },
  });
  return true;
}

/**
 * Runs one bounded retention execution pass for evidence due at or before
 * `before`. Safe to call repeatedly and with an empty due window. `storage`
 * is injectable for tests only; production always uses the configured
 * single storage abstraction.
 */
export async function processDueEvidenceRetention(
  before: Date = new Date(),
  storage: EvidenceStorage = createEvidenceStorage(),
): Promise<EvidenceRetentionExecutionResult> {
  const result: EvidenceRetentionExecutionResult = {
    dueMarked: 0,
    purged: 0,
    held: 0,
    failures: 0,
  };

  // Step 1 — ACTIVE → RETENTION_DUE (audited per row; due-ness is a fact
  // even for held rows — the hold blocks only the purge below).
  const marked = await markRetentionDue(before);
  for (const row of marked) {
    result.dueMarked += 1;
    try {
      await recordOperationalEvent({
        clientId: row.client_id,
        eventType: 'EVIDENCE_RETENTION_DUE',
        entityType: 'EVIDENCE_SUBMISSION',
        entityId: row.id,
        actorUserId: null,
        summary: 'Evidence retention became due',
        metadata: {
          evidenceId: row.id,
          retainedUntil: row.retained_until.toISOString(),
          policyId: row.retention_policy_id,
          policyCode: row.retention_policy_code,
        },
      });
    } catch {
      // Event failure must not abort the pass; the state transition stands.
      result.failures += 1;
    }
  }

  // Step 2 — purge RETENTION_DUE rows (bounded batch; held rows skipped).
  const due = await getPool().query<DueRow>(
    `SELECT id, client_id, file_reference, retained_until,
            retention_policy_id, retention_policy_code,
            retention_hold, retention_hold_set_at
       FROM evidence_submissions
      WHERE retention_state = 'RETENTION_DUE'
      ORDER BY retained_until, id
      LIMIT $1`,
    [DUE_ITEM_RETRIEVAL_LIMIT],
  );

  for (const row of due.rows) {
    if (row.retention_hold) {
      result.held += 1;
      try {
        await recordHeldOncePerHold(row);
      } catch {
        result.failures += 1;
      }
      continue;
    }
    try {
      if (await purgeOne(row, storage)) {
        result.purged += 1;
      }
    } catch (error) {
      // Row stays RETENTION_DUE; the next tick retries. Isolated per row.
      result.failures += 1;
      try {
        await recordOperationalEvent({
          clientId: row.client_id,
          eventType: 'EVIDENCE_PURGE_FAILED',
          entityType: 'EVIDENCE_SUBMISSION',
          entityId: row.id,
          actorUserId: null,
          summary: 'Evidence purge failed; will retry',
          metadata: {
            evidenceId: row.id,
            policyId: row.retention_policy_id,
            policyCode: row.retention_policy_code,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      } catch {
        // Nothing further to do — the retry is state-driven, not event-driven.
      }
    }
  }

  return result;
}
