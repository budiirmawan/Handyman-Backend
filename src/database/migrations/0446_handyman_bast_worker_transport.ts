import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BAST-HTTP-01 — Authorized Worker BAST Transport foundation.
 *
 * Additive only. Two changes:
 *
 * 1. Registers the dedicated `handyman.bast.manage` capability that gates
 *    the worker BAST command transport (PREPARE / ISSUE / VOID). Mirrors the
 *    `handyman.qc.manage` precedent (migration 0442): the code is registered
 *    in the catalogue but granted to NO role by migration or foundation seed
 *    (see UNASSIGNED_BY_DEFAULT_PERMISSION_CODES). Enabling the worker lane
 *    is a deliberate administrative grant; the runtime additionally requires
 *    the CURRENT authoritative Crew Lead binding and exact BE-02G Building
 *    access, so the permission alone authorizes nothing.
 *
 * 2. Adds an append-only audit `metadata` column to `handyman_bast_events`
 *    (same hardening pattern as migration 0442 applied to
 *    `handyman_qc_run_events` / `handyman_defect_events`). It carries the
 *    worker VOID reason (`{"voidReason": ...}`) so a voided BAST keeps its
 *    justification inside the immutable event chain. Existing rows keep the
 *    `{}` default; no history is rewritten and no status/lifecycle rule,
 *    trigger or gate is changed.
 */
export const migration0446HandymanBastWorkerTransport: Migration = {
  id: '0446_handyman_bast_worker_transport',
  async up(tx: PoolClient): Promise<void> {
    // No role receives this capability by migration or foundation seed.
    await tx.query(
      `INSERT INTO permissions (id, code, name, status)
       VALUES ($1, $2, $3, 'ACTIVE') ON CONFLICT (code) DO NOTHING`,
      [
        randomUUID(),
        'handyman.bast.manage',
        'Prepare, issue and void Handyman BAST documents',
      ],
    );

    await tx.query(`
      ALTER TABLE handyman_bast_events
        ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      ALTER TABLE handyman_bast_events DROP COLUMN IF EXISTS metadata;
    `);
    // Capability catalogue entry remains: deleting permissions on rollback
    // could invalidate grants. Rollback never grants or revokes actor rights.
  },
};
