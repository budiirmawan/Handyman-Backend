import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-15J — Vendor Work Rework cycles.
 *
 * Lightweight, append-preserving rework cycles for a BE-15B Vendor Work. A
 * rework cycle is always anchored to the BE-07 review (BE-15I verification)
 * that produced REWORK_REQUIRED — never to a duplicated verification record.
 * No separate Vendor rework engine is created here.
 *
 *   Vendor Work → Rework Cycle → Review (REWORK_REQUIRED verification)
 *
 * Lifecycle: REQUESTED → RESUBMITTED. `resubmitted_by_user_id` /
 * `resubmitted_at` are set exactly at resubmission (CHECK-pinned); a
 * RESUBMITTED cycle is immutable, so previous cycles are never overwritten.
 *
 * One rework cycle per review is enforced by UNIQUE(review_id); one current
 * (REQUESTED) cycle per Vendor Work by a partial unique index over
 * vendor_work_id — the same idioms BE-09 uses for Finding rework.
 */
export const migration0164CreateVendorReworkCycles: Migration = {
  id: '0164_create_vendor_rework_cycles',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_rework_cycles (
        id                      UUID PRIMARY KEY,
        vendor_work_id          UUID NOT NULL REFERENCES vendor_works (id),
        review_id               UUID NOT NULL REFERENCES reviews (id),
        requested_by_user_id    UUID NOT NULL REFERENCES users (id),
        reason                  TEXT NOT NULL,
        rework_notes            TEXT,
        resubmitted_by_user_id  UUID REFERENCES users (id),
        requested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resubmitted_at          TIMESTAMPTZ,
        status                  TEXT NOT NULL DEFAULT 'REQUESTED',
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_rework_status
          CHECK (status IN ('REQUESTED', 'RESUBMITTED')),
        CONSTRAINT vendor_rework_resubmission_complete CHECK (
          (status = 'REQUESTED' AND resubmitted_by_user_id IS NULL
            AND resubmitted_at IS NULL)
          OR (status = 'RESUBMITTED' AND resubmitted_by_user_id IS NOT NULL
            AND resubmitted_at IS NOT NULL)
        ),
        CONSTRAINT vendor_rework_review_unique UNIQUE (review_id)
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX vendor_current_rework_unique
        ON vendor_rework_cycles (vendor_work_id) WHERE status = 'REQUESTED';
      CREATE INDEX vendor_rework_work_idx
        ON vendor_rework_cycles (vendor_work_id, requested_at);
      CREATE INDEX vendor_rework_requester_idx
        ON vendor_rework_cycles (requested_by_user_id, requested_at);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_rework_cycles');
  },
};
