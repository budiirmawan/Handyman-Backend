import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-12L — Security Lost & Found.
 *
 * Two append-friendly tables:
 *
 *   1. `security_lost_found` — the Lost & Found master record. One
 *      row per (building, item_code); building-scoped because
 *      Lost & Found items are physical building fixtures. The
 *      custody status (`FOUND`, `IN_CUSTODY`, `CLAIMED`,
 *      `RETURNED`, `DISPOSED`, `CLOSED`) is authoritative on this
 *      row and is updated by the service as custody / claim / return
 *      events occur.
 *
 *   2. `security_lost_found_history` — append-oriented history.
 *      One row per custody event (place-in-custody, claim-register,
 *      claim-verify, return, dispose, close). Historical rows are
 *      NEVER overwritten or deleted — the "current state" is the
 *      master row's `custody_status`, and the most recent event row
 *      is the most recent transition.
 *
 * `client_id` / `building_id` are denormalized for fast listing, but
 * the service derives them authoritatively from Building → Property →
 * Client (BE-02) on every write, so isolation can never drift.
 *
 * `security_post_id` (optional) anchors the Lost & Found record to
 * a Security Post (BE-12A) when the item was found at a specific
 * post. `functional_location_id` (optional) anchors the record to
 * an authoritative Building location (BE-04G) when a finer
 * location is meaningful. Both must belong to the same Building.
 *
 * No inventory / warehouse / procurement / costing / supplier /
 * payment logic. No visitor personal data (the claimant's name /
 * contact is intentionally a free-form text field for traceability,
 * never a foreign key to a personal-data store).
 */
export const migration0132CreateSecurityLostAndFound: Migration = {
  id: '0132_create_security_lost_and_found',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE security_lost_found (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        building_id              UUID NOT NULL REFERENCES buildings (id),
        security_post_id         UUID REFERENCES security_posts (id),
        functional_location_id   UUID REFERENCES functional_locations (id),
        item_code                TEXT NOT NULL,
        item_name                TEXT NOT NULL,
        description              TEXT,
        found_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        found_by_user_id         UUID NOT NULL REFERENCES users (id),
        custody_status           TEXT NOT NULL DEFAULT 'FOUND',
        notes                    TEXT,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT security_lost_found_status_check
          CHECK (custody_status IN (
            'FOUND', 'IN_CUSTODY', 'CLAIMED', 'RETURNED',
            'DISPOSED', 'CLOSED'
          )),
        CONSTRAINT security_lost_found_building_code_unique
          UNIQUE (building_id, item_code)
      )
    `);

    await client.query(`
      CREATE INDEX security_lost_found_building_idx
        ON security_lost_found (building_id, custody_status);
      CREATE INDEX security_lost_found_post_idx
        ON security_lost_found (security_post_id);
      CREATE INDEX security_lost_found_functional_location_idx
        ON security_lost_found (functional_location_id);
      CREATE INDEX security_lost_found_found_at_idx
        ON security_lost_found (building_id, found_at DESC);
    `);

    await client.query(`
      CREATE TABLE security_lost_found_history (
        id                          UUID PRIMARY KEY,
        lost_found_id               UUID NOT NULL REFERENCES security_lost_found (id),
        event_type                  TEXT NOT NULL,
        claimant_name               TEXT,
        claimant_reference          TEXT,
        claim_notes                 TEXT,
        verified_by_user_id         UUID REFERENCES users (id),
        returned_by_user_id         UUID REFERENCES users (id),
        returned_at                 TIMESTAMPTZ,
        occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notes                       TEXT,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT security_lost_found_history_event_type_check
          CHECK (event_type IN (
            'CREATE', 'CUSTODY_PLACE', 'CLAIM_REGISTER',
            'CLAIM_VERIFY', 'RETURN', 'DISPOSE', 'CLOSE'
          )),
        CONSTRAINT security_lost_found_history_claim_register_required
          CHECK (
            (event_type = 'CLAIM_REGISTER' AND claimant_name IS NOT NULL)
            OR (event_type <> 'CLAIM_REGISTER')
          ),
        CONSTRAINT security_lost_found_history_return_required
          CHECK (
            (event_type = 'RETURN' AND returned_at IS NOT NULL
              AND returned_by_user_id IS NOT NULL)
            OR (event_type <> 'RETURN')
          ),
        CONSTRAINT security_lost_found_history_verify_required
          CHECK (
            (event_type = 'CLAIM_VERIFY' AND verified_by_user_id IS NOT NULL)
            OR (event_type <> 'CLAIM_VERIFY')
          )
      )
    `);

    await client.query(`
      CREATE INDEX security_lost_found_history_record_idx
        ON security_lost_found_history (lost_found_id, occurred_at ASC);
      CREATE INDEX security_lost_found_history_event_idx
        ON security_lost_found_history (event_type);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS security_lost_found_history');
    await client.query('DROP TABLE IF EXISTS security_lost_found');
  },
};
