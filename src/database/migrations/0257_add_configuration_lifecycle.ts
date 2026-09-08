import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-27O — controlled lifecycle metadata over BE-27N immutable snapshots.
 * Snapshot/source/version identity stays immutable; only lifecycle_status may
 * transition through the service. Preview and general configuration audit are
 * deliberately absent.
 */
export const migration0257AddConfigurationLifecycle: Migration = {
  id: '0257_add_configuration_lifecycle',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE configuration_versions
        ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'DRAFT',
        ADD CONSTRAINT configuration_versions_lifecycle_status_check CHECK (
          lifecycle_status IN ('DRAFT','VALIDATED','PUBLISHED','ACTIVE','SUPERSEDED')
        )
    `);
    // Preserve pre-BE-27O runtime behavior: the latest existing BE-27N snapshot
    // becomes the baseline ACTIVE version. New captures remain DRAFT.
    await client.query(`
      ALTER TABLE configuration_versions DISABLE TRIGGER configuration_versions_immutable;
      WITH latest AS (
        SELECT DISTINCT ON (source_type,source_configuration_id) id
        FROM configuration_versions
        ORDER BY source_type,source_configuration_id,version_number DESC
      )
      UPDATE configuration_versions cv SET lifecycle_status='ACTIVE'
      FROM latest WHERE latest.id=cv.id;
      ALTER TABLE configuration_versions ENABLE TRIGGER configuration_versions_immutable
    `);
    await client.query(`
      CREATE UNIQUE INDEX configuration_versions_one_active
        ON configuration_versions(source_type,source_configuration_id)
        WHERE lifecycle_status='ACTIVE'
    `);
    await client.query(`
      CREATE TABLE configuration_version_validations (
        id UUID PRIMARY KEY,
        configuration_version_id UUID NOT NULL REFERENCES configuration_versions(id),
        valid BOOLEAN NOT NULL,
        errors JSONB NOT NULL DEFAULT '[]'::jsonb,
        validated_by_user_id UUID NOT NULL REFERENCES users(id),
        validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT configuration_version_validation_errors_check
          CHECK (jsonb_typeof(errors)='array')
      );
      CREATE INDEX configuration_version_validations_version_idx
        ON configuration_version_validations(configuration_version_id,validated_at DESC)
    `);
    await client.query(`
      CREATE TABLE configuration_version_transitions (
        id UUID PRIMARY KEY,
        configuration_version_id UUID NOT NULL REFERENCES configuration_versions(id),
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        transitioned_by_user_id UUID NOT NULL REFERENCES users(id),
        transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT configuration_version_transition_from_check CHECK (
          from_status IN ('DRAFT','VALIDATED','PUBLISHED','ACTIVE','SUPERSEDED')
        ),
        CONSTRAINT configuration_version_transition_to_check CHECK (
          to_status IN ('DRAFT','VALIDATED','PUBLISHED','ACTIVE','SUPERSEDED')
        )
      );
      CREATE INDEX configuration_version_transitions_version_idx
        ON configuration_version_transitions(configuration_version_id,transitioned_at)
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_configuration_version_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP='DELETE' THEN
          RAISE EXCEPTION 'configuration versions are immutable' USING ERRCODE='55000';
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
          OR NEW.source_type IS DISTINCT FROM OLD.source_type
          OR NEW.source_configuration_id IS DISTINCT FROM OLD.source_configuration_id
          OR NEW.client_id IS DISTINCT FROM OLD.client_id
          OR NEW.building_id IS DISTINCT FROM OLD.building_id
          OR NEW.version_number IS DISTINCT FROM OLD.version_number
          OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.previous_version_id IS DISTINCT FROM OLD.previous_version_id
          OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
          OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
          OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
          RAISE EXCEPTION 'configuration version snapshots are immutable' USING ERRCODE='55000';
        END IF;
        IF NEW.lifecycle_status IS DISTINCT FROM OLD.lifecycle_status
          AND NOT (
            (OLD.lifecycle_status='DRAFT' AND NEW.lifecycle_status='VALIDATED')
            OR (OLD.lifecycle_status='VALIDATED' AND NEW.lifecycle_status='PUBLISHED')
            OR (OLD.lifecycle_status='PUBLISHED' AND NEW.lifecycle_status='ACTIVE')
            OR (OLD.lifecycle_status='ACTIVE' AND NEW.lifecycle_status='SUPERSEDED')
          )
        THEN
          RAISE EXCEPTION 'invalid configuration lifecycle transition' USING ERRCODE='55000';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE FUNCTION prevent_configuration_lifecycle_history_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'configuration lifecycle history is immutable' USING ERRCODE='55000';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER configuration_version_validations_immutable
        BEFORE UPDATE OR DELETE ON configuration_version_validations
        FOR EACH ROW EXECUTE FUNCTION prevent_configuration_lifecycle_history_mutation();
      CREATE TRIGGER configuration_version_transitions_immutable
        BEFORE UPDATE OR DELETE ON configuration_version_transitions
        FOR EACH ROW EXECUTE FUNCTION prevent_configuration_lifecycle_history_mutation()
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS configuration_version_transitions');
    await client.query('DROP TABLE IF EXISTS configuration_version_validations');
    await client.query('DROP FUNCTION IF EXISTS prevent_configuration_lifecycle_history_mutation()');
    await client.query('DROP INDEX IF EXISTS configuration_versions_one_active');
    await client.query('ALTER TABLE configuration_versions DROP COLUMN IF EXISTS lifecycle_status');
    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_configuration_version_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'configuration versions are immutable' USING ERRCODE='55000';
      END;
      $$ LANGUAGE plpgsql
    `);
  },
};
