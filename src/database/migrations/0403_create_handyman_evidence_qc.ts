import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-10 Evidence, QC & Rectification PART 02 — persistence
 * foundation ONLY (FROZEN governance `CR-HM-10_START_GOVERNANCE.md`
 * D1–D8). ONE migration, EIGHT tables in THREE aggregate families
 * with append-only event siblings:
 *
 *   handyman_evidence_records (+ _files, + _record_events)
 *   handyman_qc_runs          (+ _run_items, + _run_events)
 *   handyman_defect_records   (+ _defect_events)
 *
 * NO lifecycle evaluator/commands, NO HTTP/OpenAPI, NO pricing/
 * currency/charge/billing/payment columns, NO FM checklist/finding
 * coupling anywhere (firewall D8: the evidence-reuse modules stay
 * infrastructure; semantics live ONLY here).
 *
 * Invariants (DB-enforced):
 *   1. scope/provenance FK discipline: heads FK
 *      handyman_execution_scopes ONLY (client-consistency carries
 *      clients); session_id FKs handyman_work_sessions NULLABLE
 *      (provenance, never a gate); defect run/item FKs qc_runs /
 *      qc_run_items NULLABLE. ZERO FM/HRM table references.
 *   2. client_id structurally consistent with the execution scope on
 *      every head; event rows share the PARENT head's client (same
 *      consistency-trigger pattern as 0396–0402).
 *   3. evidence stage is exactly BEFORE/DURING/AFTER/QC/DEFECT/
 *      RECTIFICATION/MATERIAL (FROZEN SEVEN — BAST/WARRANTY
 *      vocabulary is reserved, NOT admitted); media kind exactly
 *      PHOTO/DOCUMENT/VIDEO; sha256_digest and positive byte_size
 *      non-empty; capture_time may never sit in the future.
 *   4. QC run status exactly OPEN/PASSED/FAILED; item outcome
 *      exactly PASS/DEFECT/NA/NOT_CHECKED; item_key unique per run;
 *      at most ONE OPEN run per execution scope (partial unique).
 *   5. Defect status exactly OPENED/RECTIFYING/RECTIFIED/VERIFIED.
 *   6. Identity bindings are written once and NEVER rewritten
 *      (client/scope/session/stage-stage/provenance); head DELETE
 *      is blocked — history lives in events. Bulletin-style content
 *      columns (description/status/outcome/note/checklist_identity)
 *      stay mutable ONLY inside their legal ladder (parts 03–05 own
 *      the semantics; persistence only blocks the IDENTITIES).
 *   7. Events and evidence files are append-only and immutable:
 *      ALL UPDATE/DELETE rejected; UNIQUE (parent, event_type,
 *      idempotency_key) idempotency boundary (governance D7).
 */
export const migration0403CreateHandymanEvidenceQc: Migration = {
  id: '0403_create_handyman_evidence_qc',
  async up(client: PoolClient): Promise<void> {
    // ---- Aggregate A: evidence records --------------------------
    await client.query(`
      CREATE TABLE handyman_evidence_records (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        session_id         UUID
          REFERENCES handyman_work_sessions (id),
        stage              TEXT NOT NULL,
        description        TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_evidence_stage_check
          CHECK (stage IN (
            'BEFORE', 'DURING', 'AFTER', 'QC', 'DEFECT',
            'RECTIFICATION', 'MATERIAL'))
      )
    `);
    await client.query(`
      CREATE INDEX handyman_evidence_records_scope_idx
        ON handyman_evidence_records
        (execution_scope_id, stage, created_at, id)
    `);

    await client.query(`
      CREATE TABLE handyman_evidence_record_files (
        id            UUID PRIMARY KEY,
        record_id     UUID NOT NULL
          REFERENCES handyman_evidence_records (id),
        media_kind    TEXT NOT NULL,
        storage_key   TEXT NOT NULL UNIQUE,
        content_type  TEXT NOT NULL,
        byte_size     BIGINT NOT NULL,
        sha256_digest TEXT NOT NULL,
        capture_time  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_evidence_media_kind_check
          CHECK (media_kind IN ('PHOTO', 'DOCUMENT', 'VIDEO')),
        CONSTRAINT handyman_evidence_byte_size_check
          CHECK (byte_size > 0),
        CONSTRAINT handyman_evidence_sha256_check
          CHECK (length(sha256_digest) > 0),
        CONSTRAINT handyman_evidence_content_type_check
          CHECK (length(content_type) > 0),
        CONSTRAINT handyman_evidence_capture_time_check
          CHECK (capture_time IS NULL
            OR capture_time <= NOW() + INTERVAL '5 minutes')
      )
    `);
    await client.query(`
      CREATE INDEX handyman_evidence_files_record_idx
        ON handyman_evidence_record_files (record_id, created_at, id)
    `);

    await client.query(`
      CREATE TABLE handyman_evidence_record_events (
        id              UUID PRIMARY KEY,
        record_id       UUID NOT NULL
          REFERENCES handyman_evidence_records (id),
        client_id       UUID NOT NULL
          REFERENCES clients (id),
        event_type      TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        actor_user_id   UUID NOT NULL
          REFERENCES users (id),
        occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_evidence_event_type_check
          CHECK (event_type IN ('CREATE', 'FILE_ADD', 'FINALIZE'))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_evidence_events_idem_idx
        ON handyman_evidence_record_events
        (record_id, event_type, idempotency_key)
    `);
    await client.query(`
      CREATE INDEX handyman_evidence_events_record_idx
        ON handyman_evidence_record_events
        (record_id, occurred_at, id)
    `);

    // ---- Aggregate B: QC runs + items ---------------------------
    await client.query(`
      CREATE TABLE handyman_qc_runs (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        session_id         UUID
          REFERENCES handyman_work_sessions (id),
        checklist_identity TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'OPEN',
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_qc_run_status_check
          CHECK (status IN ('OPEN', 'PASSED', 'FAILED')),
        CONSTRAINT handyman_qc_run_checklist_check
          CHECK (length(checklist_identity) > 0)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_qc_runs_one_open_per_scope_idx
        ON handyman_qc_runs (execution_scope_id) WHERE status = 'OPEN'
    `);
    await client.query(`
      CREATE INDEX handyman_qc_runs_scope_idx
        ON handyman_qc_runs (execution_scope_id, created_at, id)
    `);

    await client.query(`
      CREATE TABLE handyman_qc_run_items (
        id         UUID PRIMARY KEY,
        run_id     UUID NOT NULL
          REFERENCES handyman_qc_runs (id),
        item_key   TEXT NOT NULL,
        outcome    TEXT NOT NULL DEFAULT 'NOT_CHECKED',
        note       TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_qc_item_outcome_check
          CHECK (outcome IN ('PASS', 'DEFECT', 'NA', 'NOT_CHECKED')),
        CONSTRAINT handyman_qc_item_key_check
          CHECK (length(item_key) > 0),
        CONSTRAINT handyman_qc_run_items_run_key_uq
          UNIQUE (run_id, item_key)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_qc_run_items_run_idx
        ON handyman_qc_run_items (run_id, created_at, id)
    `);

    await client.query(`
      CREATE TABLE handyman_qc_run_events (
        id              UUID PRIMARY KEY,
        run_id          UUID NOT NULL
          REFERENCES handyman_qc_runs (id),
        client_id       UUID NOT NULL
          REFERENCES clients (id),
        event_type      TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        actor_user_id   UUID NOT NULL
          REFERENCES users (id),
        occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_qc_event_type_check
          CHECK (event_type IN ('OPEN', 'ITEM_SET', 'FINISH'))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_qc_run_events_idem_idx
        ON handyman_qc_run_events
        (run_id, event_type, idempotency_key)
    `);
    await client.query(`
      CREATE INDEX handyman_qc_run_events_run_idx
        ON handyman_qc_run_events (run_id, occurred_at, id)
    `);

    // ---- Aggregate C: defect records ----------------------------
    await client.query(`
      CREATE TABLE handyman_defect_records (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        run_id             UUID
          REFERENCES handyman_qc_runs (id),
        item_id            UUID
          REFERENCES handyman_qc_run_items (id),
        description        TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'OPENED',
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_defect_status_check
          CHECK (status IN (
            'OPENED', 'RECTIFYING', 'RECTIFIED', 'VERIFIED')),
        CONSTRAINT handyman_defect_description_check
          CHECK (length(description) > 0)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_defect_records_scope_idx
        ON handyman_defect_records
        (execution_scope_id, created_at, id)
    `);

    await client.query(`
      CREATE TABLE handyman_defect_events (
        id              UUID PRIMARY KEY,
        defect_id       UUID NOT NULL
          REFERENCES handyman_defect_records (id),
        client_id       UUID NOT NULL
          REFERENCES clients (id),
        event_type      TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        actor_user_id   UUID NOT NULL
          REFERENCES users (id),
        occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_defect_event_type_check
          CHECK (event_type IN (
            'OPEN_DEFECT', 'START_RECTIFICATION',
            'RECORD_RECTIFICATION', 'REQUEST_REINSPECTION',
            'PASS_REINSPECTION'))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_defect_events_idem_idx
        ON handyman_defect_events
        (defect_id, event_type, idempotency_key)
    `);
    await client.query(`
      CREATE INDEX handyman_defect_events_defect_idx
        ON handyman_defect_events (defect_id, occurred_at, id)
    `);

    // ---- Trigger: head client = scope client (three heads) ------
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_eqc_scope_client_consistency()
      RETURNS trigger AS $$
      DECLARE
        scope_client UUID;
      BEGIN
        SELECT client_id INTO scope_client
          FROM handyman_execution_scopes
          WHERE id = NEW.execution_scope_id;
        IF scope_client IS NULL THEN
          -- Absent referent falls through to the FK constraint.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM scope_client THEN
          RAISE EXCEPTION
            'Handyman evidence/QC scope binding: client_id must match the execution scope client (cross-client binding is forbidden).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const table of [
      'handyman_evidence_records',
      'handyman_qc_runs',
      'handyman_defect_records',
    ]) {
      await client.query(`
        CREATE TRIGGER ${table.replace(/^handyman_/, 'handyman_')}_client_check
          BEFORE INSERT OR UPDATE ON ${table}
          FOR EACH ROW
          EXECUTE FUNCTION handyman_eqc_scope_client_consistency();
      `);
    }

    // Defect run/provenance consistency: a run-bound defect shares
    // the scope of its run; an item-bound defect pairs an item from
    // the SAME run (zero silent cross-run/cross-scope laundering).
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_eqc_defect_provenance_consistency()
      RETURNS trigger AS $$
      DECLARE
        run_scope UUID;
        item_run  UUID;
      BEGIN
        IF NEW.run_id IS NOT NULL THEN
          SELECT execution_scope_id INTO run_scope
            FROM handyman_qc_runs WHERE id = NEW.run_id;
          IF run_scope IS NOT NULL
             AND NEW.execution_scope_id IS DISTINCT FROM run_scope THEN
            RAISE EXCEPTION
              'Handyman defect run provenance mismatch: defect and QC run must belong to the SAME execution scope.';
          END IF;
        END IF;
        IF NEW.item_id IS NOT NULL THEN
          SELECT run_id INTO item_run
            FROM handyman_qc_run_items WHERE id = NEW.item_id;
          IF item_run IS NOT NULL AND NEW.run_id IS NOT NULL
             AND item_run IS DISTINCT FROM NEW.run_id THEN
            RAISE EXCEPTION
              'Handyman defect item provenance mismatch: the QC item must belong to the SAME run the defect references.';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_defect_records_provenance_check
        BEFORE INSERT OR UPDATE ON handyman_defect_records
        FOR EACH ROW
        EXECUTE FUNCTION handyman_eqc_defect_provenance_consistency();
    `);

    // ---- Trigger: event client = parent head client -------------
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_eqc_event_client_consistency()
      RETURNS trigger AS $$
      DECLARE
        parent_client UUID;
      BEGIN
        IF TG_TABLE_NAME = 'handyman_evidence_record_events' THEN
          SELECT client_id INTO parent_client
            FROM handyman_evidence_records
            WHERE id = NEW.record_id;
        ELSIF TG_TABLE_NAME = 'handyman_qc_run_events' THEN
          SELECT client_id INTO parent_client
            FROM handyman_qc_runs
            WHERE id = NEW.run_id;
        ELSE
          SELECT client_id INTO parent_client
            FROM handyman_defect_records
            WHERE id = NEW.defect_id;
        END IF;
        IF parent_client IS NULL THEN
          -- Absent parent falls through to the FK constraint.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM parent_client THEN
          RAISE EXCEPTION
            'Handyman evidence/QC event must share the parent record client (cross-record binding is forbidden).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_evidence_record_events_client_check
        BEFORE INSERT OR UPDATE ON handyman_evidence_record_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_eqc_event_client_consistency();
    `);
    await client.query(`
      CREATE TRIGGER handyman_qc_run_events_client_check
        BEFORE INSERT OR UPDATE ON handyman_qc_run_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_eqc_event_client_consistency();
    `);
    await client.query(`
      CREATE TRIGGER handyman_defect_events_client_check
        BEFORE INSERT OR UPDATE ON handyman_defect_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_eqc_event_client_consistency();
    `);

    // ---- Trigger: identity immutability + head-no-delete --------
    // Client/scope/session/-stage/run/item provenance and evidence
    // stage are written at creation and NEVER rewritten (governance
    // D6: evidence chain stay anchored to capture identity). DELETE
    // of any head is blocked: history lives in events.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_eqc_head_block_identity_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman evidence/QC records cannot be deleted: evidence and quality history is immutable.';
        END IF;
        -- Per-table branches are selected strictly on
        -- TG_TABLE_NAME so each table's fields are touched only by
        -- its own branch (record records carry table-local fields
        -- only; a shared AND-chain would dereference wrong-table
        -- fields for other tables' rows).
        IF TG_TABLE_NAME = 'handyman_evidence_records' THEN
          IF NEW.client_id IS DISTINCT FROM OLD.client_id
             OR NEW.execution_scope_id IS DISTINCT FROM
                  OLD.execution_scope_id
             OR NEW.session_id IS DISTINCT FROM OLD.session_id
             OR NEW.stage IS DISTINCT FROM OLD.stage THEN
            RAISE EXCEPTION
              'Handyman evidence record identity (client/scope/session/stage) is immutable once written.';
          END IF;
        ELSIF TG_TABLE_NAME = 'handyman_qc_runs' THEN
          IF NEW.client_id IS DISTINCT FROM OLD.client_id
             OR NEW.execution_scope_id IS DISTINCT FROM
                  OLD.execution_scope_id
             OR NEW.session_id IS DISTINCT FROM OLD.session_id
             OR NEW.checklist_identity IS DISTINCT FROM
                  OLD.checklist_identity THEN
            RAISE EXCEPTION
              'Handyman QC run identity (client/scope/session/checklist identity) is immutable once written.';
          END IF;
        ELSIF TG_TABLE_NAME = 'handyman_defect_records' THEN
          IF NEW.client_id IS DISTINCT FROM OLD.client_id
             OR NEW.execution_scope_id IS DISTINCT FROM
                  OLD.execution_scope_id
             OR NEW.run_id IS DISTINCT FROM OLD.run_id
             OR NEW.item_id IS DISTINCT FROM OLD.item_id THEN
            RAISE EXCEPTION
              'Handyman defect provenance (client/scope/run/item) is immutable once written.';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_evidence_records_identity_guard
        BEFORE UPDATE OR DELETE ON handyman_evidence_records
        FOR EACH ROW
        EXECUTE FUNCTION handyman_eqc_head_block_identity_mutation();
    `);
    await client.query(`
      CREATE TRIGGER handyman_qc_runs_identity_guard
        BEFORE UPDATE OR DELETE ON handyman_qc_runs
        FOR EACH ROW
        EXECUTE FUNCTION handyman_eqc_head_block_identity_mutation();
    `);
    await client.query(`
      CREATE TRIGGER handyman_defect_records_identity_guard
        BEFORE UPDATE OR DELETE ON handyman_defect_records
        FOR EACH ROW
        EXECUTE FUNCTION handyman_eqc_head_block_identity_mutation();
    `);

    // ---- Trigger: append-only events + files --------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_eqc_row_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman evidence/QC append-only rows (events and evidence files) cannot be updated or deleted: history is immutable.';
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const table of [
      'handyman_evidence_record_files',
      'handyman_evidence_record_events',
      'handyman_qc_run_events',
      'handyman_defect_events',
    ]) {
      await client.query(`
        CREATE TRIGGER %(table)s_no_write
          BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW
          EXECUTE FUNCTION handyman_eqc_row_block_mutation();
      `.replace('%(table)s', table));
    }
  },
};
