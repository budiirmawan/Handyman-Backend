import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-07C — Form conditions & repeatable groups.
 *
 * Adds conditional rules (`form_conditional_rules`) and repeatable-group
 * support (`form_repeatable_groups`, `form_instance_occurrences`), and
 * extends `form_responses` with an optional `occurrence_id`.
 *
 * FINAL-REVIEW FIX: the original migration ran
 * `DROP INDEX form_responses_unique` against the UNIQUE **constraint**
 * `form_responses_unique` created in 0067 (a constraint-backed index cannot
 * be dropped by name with `DROP INDEX`). This rewrites it as
 * `ALTER TABLE form_responses DROP CONSTRAINT form_responses_unique`, then
 * re-creates the equivalent UNIQUE index over the (now nullable) occurrence.
 */
export const migration0068CreateFormConditionsRepeatables: Migration = {
  id: '0068_create_form_conditions_repeatables',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE form_conditional_rules (
        id UUID PRIMARY KEY,
        version_id UUID NOT NULL
          REFERENCES form_template_versions (id) ON DELETE CASCADE,
        source_field_id UUID NOT NULL
          REFERENCES form_template_version_fields (id),
        target_field_id UUID
          REFERENCES form_template_version_fields (id),
        target_section_id UUID
          REFERENCES form_template_version_sections (id),
        operator TEXT NOT NULL,
        comparison_value JSONB,
        CONSTRAINT form_conditional_target
          CHECK ((target_field_id IS NOT NULL) <> (target_section_id IS NOT NULL)),
        CONSTRAINT form_conditional_operator
          CHECK (operator IN ('EQUALS', 'NOT_EQUALS', 'IS_TRUE', 'IS_FALSE'))
      )
    `);

    await client.query(`
      CREATE TABLE form_repeatable_groups (
        id UUID PRIMARY KEY,
        version_id UUID NOT NULL
          REFERENCES form_template_versions (id) ON DELETE CASCADE,
        version_section_id UUID NOT NULL
          REFERENCES form_template_version_sections (id),
        min_occurrences INTEGER NOT NULL DEFAULT 0,
        max_occurrences INTEGER,
        CONSTRAINT repeatable_min CHECK (min_occurrences >= 0),
        CONSTRAINT repeatable_max
          CHECK (max_occurrences IS NULL OR max_occurrences >= min_occurrences),
        CONSTRAINT repeatable_unique UNIQUE (version_id, version_section_id)
      );
      CREATE TABLE form_instance_occurrences (
        id UUID PRIMARY KEY,
        form_instance_id UUID NOT NULL
          REFERENCES form_instances (id) ON DELETE CASCADE,
        repeatable_group_id UUID NOT NULL
          REFERENCES form_repeatable_groups (id),
        occurrence_index INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT occurrence_index CHECK (occurrence_index >= 0),
        CONSTRAINT occurrence_unique
          UNIQUE (form_instance_id, repeatable_group_id, occurrence_index)
      )
    `);

    await client.query(`
      ALTER TABLE form_responses
        ADD COLUMN occurrence_id UUID
          REFERENCES form_instance_occurrences (id) ON DELETE CASCADE
    `);

    // The 0067 UNIQUE constraint is dropped by name (not via DROP INDEX),
    // then re-created as an index that treats NULL occurrences as a group.
    await client.query(`
      ALTER TABLE form_responses
        DROP CONSTRAINT form_responses_unique
    `);

    await client.query(`
      CREATE UNIQUE INDEX form_responses_unique
        ON form_responses (
          form_instance_id,
          version_field_id,
          COALESCE(occurrence_id, '00000000-0000-0000-0000-000000000000')
        );
      CREATE INDEX occurrences_instance_idx
        ON form_instance_occurrences (form_instance_id, repeatable_group_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // FINAL-REVIEW FIX: fully reverse the `up`. The original down only dropped
    // the three tables, which failed because `form_responses.occurrence_id`
    // still referenced `form_instance_occurrences`. Restore the 0067 UNIQUE
    // constraint and remove the occurrence column before dropping the tables.
    await client.query(`DROP INDEX IF EXISTS form_responses_unique`);
    await client.query(`
      ALTER TABLE form_responses DROP COLUMN occurrence_id
    `);
    await client.query(`
      ALTER TABLE form_responses
        ADD CONSTRAINT form_responses_unique
          UNIQUE (form_instance_id, version_field_id)
    `);
    await client.query(`
      DROP TABLE IF EXISTS form_instance_occurrences;
      DROP TABLE IF EXISTS form_repeatable_groups;
      DROP TABLE IF EXISTS form_conditional_rules
    `);
  },
};
