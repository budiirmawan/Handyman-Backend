import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-12K — Security Key Control.
 *
 * Two append-friendly tables:
 *
 *   1. `security_keys` — the controlled key master record. One row
 *      per (building, code); building-scoped because keys are physical
 *      building fixtures. The operational status (`AVAILABLE`,
 *      `ISSUED`, `OVERDUE`, `LOST`, `INACTIVE`) is authoritative on
 *      this row and is updated by the service as custody transactions
 *      occur.
 *
 *   2. `security_key_custody` — append-oriented history. One row per
 *      custody event (issue / return / mark-lost / mark-inactive).
 *      Historical rows are NEVER overwritten or deleted — the
 *      "current custody" is the most recent open row for a key
 *      (i.e. the row with the latest `issued_at` that has no
 *      `returned_at`).
 *
 * `client_id` / `building_id` are denormalized for fast listing, but
 * the service derives them authoritatively from Building → Property →
 * Client (BE-02) on every write, so isolation can never drift.
 *
 * `security_post_id` (optional) anchors the key to a Security Post
 * (BE-12A) when the key is station-specific. `functional_location_id`
 * (optional) anchors the key to an authoritative Building location
 * (BE-04G) when a finer location is meaningful. Both must belong to
 * the same Building.
 *
 * No inventory / warehouse / procurement / costing / supplier logic.
 * No electronic access-control or smart-lock integration. No
 * Lost & Found logic.
 */
export const migration0131CreateSecurityKeysAndCustody: Migration = {
  id: '0131_create_security_keys_and_custody',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE security_keys (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        building_id              UUID NOT NULL REFERENCES buildings (id),
        code                     TEXT NOT NULL,
        name                     TEXT NOT NULL,
        description              TEXT,
        security_post_id         UUID REFERENCES security_posts (id),
        functional_location_id  UUID REFERENCES functional_locations (id),
        status                   TEXT NOT NULL DEFAULT 'AVAILABLE',
        created_by_user_id       UUID NOT NULL REFERENCES users (id),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT security_keys_status_check
          CHECK (status IN (
            'AVAILABLE', 'ISSUED', 'OVERDUE', 'LOST', 'INACTIVE'
          )),
        CONSTRAINT security_keys_building_code_unique
          UNIQUE (building_id, code)
      )
    `);

    await client.query(`
      CREATE INDEX security_keys_building_idx
        ON security_keys (building_id, status);
      CREATE INDEX security_keys_post_idx
        ON security_keys (security_post_id);
      CREATE INDEX security_keys_functional_location_idx
        ON security_keys (functional_location_id);
    `);

    await client.query(`
      CREATE TABLE security_key_custody (
        id                          UUID PRIMARY KEY,
        key_id                      UUID NOT NULL REFERENCES security_keys (id),
        transaction_type            TEXT NOT NULL,
        issued_to_workforce_id      UUID REFERENCES workforce_profiles (id),
        issued_by_user_id           UUID REFERENCES users (id),
        issued_at                   TIMESTAMPTZ,
        expected_return_at          TIMESTAMPTZ,
        returned_at                 TIMESTAMPTZ,
        returned_to_user_id         UUID REFERENCES users (id),
        notes                       TEXT,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT security_key_custody_transaction_type_check
          CHECK (transaction_type IN (
            'ISSUE', 'RETURN', 'MARK_LOST', 'MARK_INACTIVE'
          )),
        CONSTRAINT security_key_custody_return_issued_pair
          CHECK (
            (transaction_type = 'ISSUE' AND issued_at IS NOT NULL)
            OR (transaction_type <> 'ISSUE')
          ),
        CONSTRAINT security_key_custody_returned_pair
          CHECK (
            (transaction_type = 'RETURN' AND returned_at IS NOT NULL)
            OR (transaction_type <> 'RETURN')
          )
      )
    `);

    await client.query(`
      CREATE INDEX security_key_custody_key_idx
        ON security_key_custody (key_id, created_at DESC);
      CREATE INDEX security_key_custody_workforce_idx
        ON security_key_custody (issued_to_workforce_id);
      CREATE INDEX security_key_custody_open_idx
        ON security_key_custody (key_id, issued_at DESC)
        WHERE returned_at IS NULL;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS security_key_custody');
    await client.query('DROP TABLE IF EXISTS security_keys');
  },
};
