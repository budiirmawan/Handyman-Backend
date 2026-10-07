import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-EXP-01 PART 01 — durable export request/archive foundation.
 *
 * This table is the request/execution authority only. PART 01 does not render
 * or download files; artifact columns remain empty until a later renderer and
 * storage adapter are deliberately introduced. File bytes never enter
 * PostgreSQL. Retention snapshot columns remain nullable until the existing
 * retention authority safely supports report artifacts; no destructive cleanup
 * is introduced here.
 *
 * `0329` is intentionally not repaired here. This migration starts the EXP
 * sequence at 0330 as required by the governance decision.
 */
export const migration0330CreateReportArchives: Migration = {
  id: '0330_create_report_archives',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE report_archives (
        id                         UUID PRIMARY KEY,
        client_id                  UUID NOT NULL REFERENCES clients (id),
        building_id               UUID REFERENCES buildings (id),
        building_ids              UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
        dataset                   TEXT NOT NULL,
        format                    TEXT NOT NULL,
        status                    TEXT NOT NULL DEFAULT 'REQUESTED',
        filter_snapshot           JSONB NOT NULL,
        source_provenance         JSONB NOT NULL,
        as_of                     TIMESTAMPTZ,
        requested_by_user_id      UUID NOT NULL REFERENCES users (id),
        requested_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        generated_at              TIMESTAMPTZ,
        storage_reference         TEXT,
        filename                  TEXT,
        content_type              TEXT,
        file_size                 BIGINT,
        checksum                  TEXT,
        checksum_algorithm        TEXT,
        failure_code              TEXT,
        failure_message           TEXT,
        failed_at                 TIMESTAMPTZ,
        attempt_count             INTEGER NOT NULL DEFAULT 0,
        max_attempts              INTEGER NOT NULL DEFAULT 3,
        next_attempt_at           TIMESTAMPTZ,
        idempotency_key_hash      TEXT,
        request_fingerprint       TEXT NOT NULL,
        supersedes_archive_id     UUID REFERENCES report_archives (id),
        retention_policy_id       UUID REFERENCES evidence_retention_policies (id),
        retention_policy_code     TEXT,
        retention_days_snapshot   INTEGER,
        retention_applied_at      TIMESTAMPTZ,
        retained_until            TIMESTAMPTZ,
        retention_state            TEXT NOT NULL DEFAULT 'ACTIVE',
        retention_hold             BOOLEAN NOT NULL DEFAULT FALSE,
        retention_hold_reason     TEXT,
        retention_hold_set_at     TIMESTAMPTZ,
        purged_at                 TIMESTAMPTZ,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT report_archives_dataset_check CHECK (
          dataset IN (
            'SECURITY_PATROL',
            'SECURITY_FINDING_INCIDENT',
            'WORKFORCE',
            'VENDOR_TENANT',
            'UTILITY',
            'MANAGEMENT_OPERATIONS_COMMAND_CENTER'
          )
        ),
        CONSTRAINT report_archives_format_check CHECK (
          format IN ('JSON', 'CSV', 'XLSX', 'PDF')
        ),
        CONSTRAINT report_archives_status_check CHECK (
          status IN ('REQUESTED', 'GENERATING', 'COMPLETED', 'FAILED')
        ),
        CONSTRAINT report_archives_filter_snapshot_object_check CHECK (
          jsonb_typeof(filter_snapshot) = 'object'
        ),
        CONSTRAINT report_archives_source_provenance_object_check CHECK (
          jsonb_typeof(source_provenance) = 'object'
        ),
        CONSTRAINT report_archives_building_ids_no_null_check CHECK (
          array_position(building_ids, NULL) IS NULL
        ),
        CONSTRAINT report_archives_single_building_shape_check CHECK (
          building_id IS NULL
          OR (cardinality(building_ids) = 1 AND building_ids[1] = building_id)
        ),
        CONSTRAINT report_archives_generated_shape_check CHECK (
          (status = 'COMPLETED' AND generated_at IS NOT NULL)
          OR (status <> 'COMPLETED' AND generated_at IS NULL)
        ),
        CONSTRAINT report_archives_artifact_metadata_check CHECK (
          (
            storage_reference IS NULL
            AND filename IS NULL
            AND content_type IS NULL
            AND file_size IS NULL
            AND checksum IS NULL
            AND checksum_algorithm IS NULL
          )
          OR (
            storage_reference IS NOT NULL
            AND filename IS NOT NULL
            AND content_type IS NOT NULL
            AND file_size IS NOT NULL
            AND checksum IS NOT NULL
            AND checksum_algorithm IS NOT NULL
          )
        ),
        CONSTRAINT report_archives_file_size_check CHECK (
          file_size IS NULL OR file_size >= 0
        ),
        CONSTRAINT report_archives_filename_check CHECK (
          filename IS NULL OR filename ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$'
        ),
        CONSTRAINT report_archives_content_type_check CHECK (
          content_type IS NULL
          OR (length(content_type) BETWEEN 1 AND 255 AND content_type !~ '[\\r\\n]')
        ),
        CONSTRAINT report_archives_storage_reference_check CHECK (
          storage_reference IS NULL
          OR (length(storage_reference) BETWEEN 1 AND 512 AND storage_reference !~ '[\\r\\n]')
        ),
        CONSTRAINT report_archives_checksum_check CHECK (
          checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT report_archives_checksum_algorithm_check CHECK (
          checksum_algorithm IS NULL OR checksum_algorithm = 'SHA-256'
        ),
        CONSTRAINT report_archives_failure_metadata_check CHECK (
          (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_.-]{1,128}$')
          AND (failure_message IS NULL OR (length(failure_message) BETWEEN 1 AND 1000 AND failure_message !~ '[\\r\\n]'))
        ),
        CONSTRAINT report_archives_failure_shape_check CHECK (
          (
            failure_code IS NULL
            AND failure_message IS NULL
            AND failed_at IS NULL
          )
          OR (
            failure_code IS NOT NULL
            AND failure_message IS NOT NULL
            AND failed_at IS NOT NULL
          )
        ),
        CONSTRAINT report_archives_failed_metadata_check CHECK (
          status <> 'FAILED'
          OR (failure_code IS NOT NULL AND failure_message IS NOT NULL AND failed_at IS NOT NULL)
        ),
        CONSTRAINT report_archives_attempts_check CHECK (
          attempt_count >= 0 AND max_attempts > 0 AND attempt_count <= max_attempts
        ),
        CONSTRAINT report_archives_idempotency_hash_check CHECK (
          idempotency_key_hash IS NULL OR idempotency_key_hash ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT report_archives_fingerprint_check CHECK (
          request_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT report_archives_retention_snapshot_check CHECK (
          (
            retention_policy_id IS NULL
            AND retention_policy_code IS NULL
            AND retention_days_snapshot IS NULL
            AND retention_applied_at IS NULL
            AND retained_until IS NULL
          )
          OR (
            retention_policy_id IS NOT NULL
            AND retention_policy_code IS NOT NULL
            AND retention_days_snapshot IS NOT NULL
            AND retention_applied_at IS NOT NULL
            AND retained_until IS NOT NULL
          )
        ),
        CONSTRAINT report_archives_retention_days_check CHECK (
          retention_days_snapshot IS NULL OR retention_days_snapshot > 0
        ),
        CONSTRAINT report_archives_retention_state_check CHECK (
          retention_state IN ('ACTIVE', 'RETENTION_DUE', 'PURGED')
        ),
        CONSTRAINT report_archives_retention_governance_check CHECK (
          retention_state = 'ACTIVE' OR retained_until IS NOT NULL
        ),
        CONSTRAINT report_archives_hold_shape_check CHECK (
          (
            retention_hold = FALSE
            AND retention_hold_reason IS NULL
            AND retention_hold_set_at IS NULL
          )
          OR (
            retention_hold = TRUE
            AND retention_hold_reason IS NOT NULL
            AND retention_hold_set_at IS NOT NULL
          )
        ),
        CONSTRAINT report_archives_purged_shape_check CHECK (
          (retention_state = 'PURGED' AND purged_at IS NOT NULL)
          OR (retention_state <> 'PURGED' AND purged_at IS NULL)
        ),
        CONSTRAINT report_archives_completed_requirements_check CHECK (
          status <> 'COMPLETED'
          OR (
            as_of IS NOT NULL
            AND storage_reference IS NOT NULL
            AND filename IS NOT NULL
            AND content_type IS NOT NULL
            AND file_size IS NOT NULL
            AND checksum IS NOT NULL
            AND checksum_algorithm IS NOT NULL
          )
        )
      );

      CREATE UNIQUE INDEX report_archives_idempotency_unique
        ON report_archives (requested_by_user_id, client_id, idempotency_key_hash)
        WHERE idempotency_key_hash IS NOT NULL;
      CREATE INDEX report_archives_client_created_idx
        ON report_archives (client_id, created_at DESC, id DESC);
      CREATE INDEX report_archives_building_created_idx
        ON report_archives (building_id, created_at DESC, id DESC)
        WHERE building_id IS NOT NULL;
      CREATE INDEX report_archives_scope_building_ids_idx
        ON report_archives USING GIN (building_ids);
      CREATE INDEX report_archives_status_attempt_idx
        ON report_archives (status, next_attempt_at, requested_at);
      CREATE INDEX report_archives_dataset_format_idx
        ON report_archives (dataset, format, created_at DESC);

      CREATE OR REPLACE FUNCTION report_archives_enforce_lifecycle()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $report_archives_lifecycle$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id
          OR NEW.client_id IS DISTINCT FROM OLD.client_id
          OR NEW.building_id IS DISTINCT FROM OLD.building_id
          OR NEW.building_ids IS DISTINCT FROM OLD.building_ids
          OR NEW.dataset IS DISTINCT FROM OLD.dataset
          OR NEW.format IS DISTINCT FROM OLD.format
          OR NEW.filter_snapshot IS DISTINCT FROM OLD.filter_snapshot
          OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
          OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
          OR NEW.idempotency_key_hash IS DISTINCT FROM OLD.idempotency_key_hash
          OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
          OR NEW.supersedes_archive_id IS DISTINCT FROM OLD.supersedes_archive_id
        THEN
          RAISE EXCEPTION 'Report archive request identity is immutable.'
            USING ERRCODE = '23514';
        END IF;

        IF OLD.status = 'REQUESTED'
          AND NEW.status NOT IN ('REQUESTED', 'GENERATING', 'COMPLETED', 'FAILED')
        THEN
          RAISE EXCEPTION 'Invalid report archive lifecycle transition.'
            USING ERRCODE = '23514';
        ELSIF OLD.status = 'GENERATING'
          AND NEW.status NOT IN ('GENERATING', 'REQUESTED', 'COMPLETED', 'FAILED')
        THEN
          RAISE EXCEPTION 'Invalid report archive lifecycle transition.'
            USING ERRCODE = '23514';
        ELSIF OLD.status = 'COMPLETED' AND NEW.status <> 'COMPLETED' THEN
          RAISE EXCEPTION 'Completed report archive is immutable.'
            USING ERRCODE = '23514';
        ELSIF OLD.status = 'FAILED' AND NEW.status <> 'FAILED' THEN
          RAISE EXCEPTION 'Failed report archive is terminal.'
            USING ERRCODE = '23514';
        END IF;

        IF OLD.retention_policy_id IS NOT NULL
          AND (
            NEW.retention_policy_id IS DISTINCT FROM OLD.retention_policy_id
            OR NEW.retention_policy_code IS DISTINCT FROM OLD.retention_policy_code
            OR NEW.retention_days_snapshot IS DISTINCT FROM OLD.retention_days_snapshot
            OR NEW.retention_applied_at IS DISTINCT FROM OLD.retention_applied_at
            OR NEW.retained_until IS DISTINCT FROM OLD.retained_until
          )
        THEN
          RAISE EXCEPTION 'Report archive retention snapshot is immutable.'
            USING ERRCODE = '23514';
        END IF;

        IF OLD.status = 'COMPLETED'
          AND (
            NEW.source_provenance IS DISTINCT FROM OLD.source_provenance
            OR NEW.as_of IS DISTINCT FROM OLD.as_of
            OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
            OR NEW.storage_reference IS DISTINCT FROM OLD.storage_reference
            OR NEW.filename IS DISTINCT FROM OLD.filename
            OR NEW.content_type IS DISTINCT FROM OLD.content_type
            OR NEW.file_size IS DISTINCT FROM OLD.file_size
            OR NEW.checksum IS DISTINCT FROM OLD.checksum
            OR NEW.checksum_algorithm IS DISTINCT FROM OLD.checksum_algorithm
            OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
            OR NEW.failure_message IS DISTINCT FROM OLD.failure_message
            OR NEW.failed_at IS DISTINCT FROM OLD.failed_at
            OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
            OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
            OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
          )
        THEN
          RAISE EXCEPTION 'Completed report archive artifact is immutable.'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $report_archives_lifecycle$;

      CREATE TRIGGER report_archives_lifecycle_trigger
        BEFORE UPDATE ON report_archives
        FOR EACH ROW
        EXECUTE FUNCTION report_archives_enforce_lifecycle();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS report_archives_lifecycle_trigger ON report_archives;
      DROP FUNCTION IF EXISTS report_archives_enforce_lifecycle();
      DROP TABLE IF EXISTS report_archives;
    `);
  },
};
