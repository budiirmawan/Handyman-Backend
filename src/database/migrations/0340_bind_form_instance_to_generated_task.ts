import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * MOB-C07 PART 01B — Form Instance → Generated Task binding.
 *
 * Adds the minimal, backend-authoritative persistence relationship so a future
 * mobile-bound Form Instance can be resolved to the exact generated task that
 * created the field work:
 *
 *   form_instances.generated_task_id  →  generated_tasks.id
 *
 * Design notes:
 *  - The column is NULLABLE and defaults to NULL. Unbound generic/admin
 *    instances (and meter-reading / log-sheet bound instances, which keep
 *    their own independent FKs) remain valid with NULL. No backfill is
 *    performed: historical rows have no authoritative generated task and
 *    must stay NULL rather than being guessed.
 *  - Referential integrity only: a non-null value must reference an existing
 *    generated task. The FK deliberately has NO ON DELETE/ON UPDATE clause
 *    (PostgreSQL NO ACTION), matching the platform convention for
 *    operational/master references (migrations 0337 / 0338) — a referenced
 *    task that already owns a Form Instance is not silently deleted or
 *    orphaned.
 *  - A lookup index supports "which task owns this instance" resolution.
 *  - A PARTIAL UNIQUE index on non-null generated_task_id enforces exactly
 *    one task-bound generic Form Instance per generated task. Multiple NULL
 *    (unbound) rows remain legal.
 *
 * This migration is persistence foundation only: it adds no API, DTO,
 * client-supplied generatedTaskId, form_instance.execute permission, or
 * runtime authorization behavior. PART 02 creates the binding server-side
 * from exact task authority.
 */
export const migration0340BindFormInstanceToGeneratedTask: Migration = {
  id: '0340_bind_form_instance_to_generated_task',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE form_instances
        ADD COLUMN generated_task_id UUID,
        ADD CONSTRAINT form_instances_generated_task_id_fkey
          FOREIGN KEY (generated_task_id) REFERENCES generated_tasks (id)
    `);

    await client.query(`
      CREATE INDEX form_instances_generated_task_id_idx
        ON form_instances (generated_task_id)
    `);

    await client.query(`
      CREATE UNIQUE INDEX form_instances_generated_task_unique
        ON form_instances (generated_task_id)
        WHERE generated_task_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS form_instances_generated_task_unique
    `);
    await client.query(`
      DROP INDEX IF EXISTS form_instances_generated_task_id_idx
    `);
    await client.query(`
      ALTER TABLE form_instances
        DROP CONSTRAINT IF EXISTS form_instances_generated_task_id_fkey,
        DROP COLUMN IF EXISTS generated_task_id
    `);
  },
};
