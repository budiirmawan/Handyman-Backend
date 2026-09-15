import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * MOB-C03 PART 02 — Workforce Shift Assignment → Security Post binding.
 *
 * Adds the minimal, backend-authoritative persistence relationship between an
 * operational roster row (`workforce_shift_assignments`, BE-03E) and the
 * independent Security Post master (`security_posts`, BE-12A):
 *
 *   workforce_shift_assignments.security_post_id  →  security_posts.id
 *
 * Design notes:
 *  - The column is NULLABLE and defaults to NULL. Not every workforce role
 *    works a fixed post (engineering/housekeeping shifts have none), and every
 *    existing assignment must remain valid without a post. No backfill, no
 *    synthetic post, no row rewrite.
 *  - Referential integrity only: a non-null value must reference an existing
 *    Security Post. The FK deliberately has NO ON DELETE/ON UPDATE clause
 *    (NO ACTION), matching the platform convention for operational/master
 *    references — deleting a Security Post that is still referenced is
 *    rejected rather than cascading into roster rows.
 *  - A lookup index supports the reverse "who is rostered to this post" read.
 *
 * Same-Building integrity (the post must belong to the same Building as the
 * Shift the roster row targets) CANNOT be expressed at this layer without
 * broadening the schema: `workforce_shift_assignments` carries
 * `workforce_profile_id` + `shift_id` but no `building_id`, and there is no
 * `UNIQUE(id, building_id)` on `security_posts` to anchor a composite FK. It is
 * therefore enforced by the service/domain layer on write (the same policy
 * 0036 documents for Building → Campus), where it can yield the proper
 * governed error. That validation is delivered with the read/DTO surface in
 * MOB-C03 PART 03; this migration is the persistence foundation only and adds
 * no API, DTO or runtime read behavior.
 */
export const migration0337AddSecurityPostToWorkforceShiftAssignments: Migration = {
  id: '0337_add_security_post_to_workforce_shift_assignments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE workforce_shift_assignments
        ADD COLUMN security_post_id UUID,
        ADD CONSTRAINT workforce_shift_assignments_security_post_id_fkey
          FOREIGN KEY (security_post_id) REFERENCES security_posts (id)
    `);

    await client.query(
      `CREATE INDEX workforce_shift_assignments_security_post_id_idx
         ON workforce_shift_assignments (security_post_id)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE workforce_shift_assignments
        DROP CONSTRAINT IF EXISTS workforce_shift_assignments_security_post_id_fkey,
        DROP COLUMN IF EXISTS security_post_id
    `);
  },
};
