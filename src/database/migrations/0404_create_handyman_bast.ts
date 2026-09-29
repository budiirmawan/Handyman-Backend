import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-11 PART 01 — Handyman BAST aggregate persistence ONLY
 * (`CR-HM-11_START_GOVERNANCE.md` §3–§8). Two tables: document
 * projection + append-only events. ISSUE/VOID/PREPARE event types
 * only. ACCEPT/REJECT status values exist on the CHECK so PART 02
 * can project them later; PART 01 never writes them.
 *
 * ZERO FM bast_documents / work_orders FKs. ZERO signature columns.
 */
export const migration0404CreateHandymanBast: Migration = {
  id: '0404_create_handyman_bast',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_bast_documents (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        status             TEXT NOT NULL DEFAULT 'DRAFT',
        issued_at          TIMESTAMPTZ,
        voided_at          TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_bast_status_check
          CHECK (status IN (
            'DRAFT', 'ISSUED', 'ACCEPTED', 'REJECTED', 'VOID')),
        CONSTRAINT handyman_bast_issued_at_check
          CHECK (issued_at IS NULL OR status <> 'DRAFT'),
        CONSTRAINT handyman_bast_voided_at_check
          CHECK (voided_at IS NULL OR status = 'VOID')
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_bast_one_active_idx
        ON handyman_bast_documents (execution_scope_id)
        WHERE status <> 'VOID'
    `);
    await client.query(`
      CREATE INDEX handyman_bast_scope_idx
        ON handyman_bast_documents (execution_scope_id, created_at)
    `);

    await client.query(`
      CREATE TABLE handyman_bast_events (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        bast_id            UUID NOT NULL
          REFERENCES handyman_bast_documents (id),
        execution_scope_id UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        event_type         TEXT NOT NULL,
        idempotency_key    TEXT NOT NULL,
        actor_user_id      UUID NOT NULL
          REFERENCES users (id),
        occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_bast_events_type_check
          CHECK (event_type IN ('PREPARE', 'ISSUE', 'VOID'))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_bast_events_idem_idx
        ON handyman_bast_events (bast_id, event_type, idempotency_key)
    `);
    await client.query(`
      CREATE INDEX handyman_bast_events_bast_idx
        ON handyman_bast_events (bast_id, occurred_at)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bast_client_consistency()
      RETURNS trigger AS $$
      DECLARE
        scope_client UUID;
      BEGIN
        SELECT client_id INTO scope_client
          FROM handyman_execution_scopes
          WHERE id = NEW.execution_scope_id;
        IF scope_client IS NULL THEN
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM scope_client THEN
          RAISE EXCEPTION
            'Handyman BAST client_id must match the execution scope client.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bast_client_check
        BEFORE INSERT OR UPDATE ON handyman_bast_documents
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bast_client_consistency();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bast_event_consistency()
      RETURNS trigger AS $$
      DECLARE
        parent_client UUID;
        parent_scope  UUID;
      BEGIN
        SELECT client_id, execution_scope_id
          INTO parent_client, parent_scope
          FROM handyman_bast_documents
          WHERE id = NEW.bast_id;
        IF parent_client IS NULL THEN
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM parent_client
           OR NEW.execution_scope_id IS DISTINCT FROM parent_scope THEN
          RAISE EXCEPTION
            'Handyman BAST event must match parent document client and scope.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bast_events_parent_check
        BEFORE INSERT OR UPDATE ON handyman_bast_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bast_event_consistency();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bast_head_identity_guard()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman BAST documents cannot be deleted.';
        END IF;
        IF NEW.client_id IS DISTINCT FROM OLD.client_id
           OR NEW.execution_scope_id IS DISTINCT FROM
                OLD.execution_scope_id THEN
          RAISE EXCEPTION
            'Handyman BAST identity (client/scope) is immutable.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bast_identity_guard
        BEFORE UPDATE OR DELETE ON handyman_bast_documents
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bast_head_identity_guard();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bast_event_no_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman BAST events cannot be updated or deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bast_events_no_write
        BEFORE UPDATE OR DELETE ON handyman_bast_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bast_event_no_write();
    `);
  },
};
