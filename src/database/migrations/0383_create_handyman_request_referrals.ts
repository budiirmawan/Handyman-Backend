import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-03 PART 04 — Handyman specialist / out-of-scope referral record
 * (FROZEN F4/F5/F6/F7/F9).
 *
 * Additive minimum (one new bounded table; reverting `down`; zero changes
 * to existing tables — no request state transition exists in PART 04:
 * SPECIALIST_REQUIRED requests remain READY_FOR_NEXT_STEP and
 * OUT_OF_HANDYMAN_SCOPE requests remain REFERRED).
 *
 *   handyman_request_referrals   FROZEN F2 referral record (immutable,
 *   append-oriented): request ref + diagnosis ref + referral_type +
 *   target discipline (id + verbatim code snapshot derived from the
 *   authoritative PART 03 diagnosis — never from free-text
 *   service_catalog.category) + concise note + actor + server timestamp.
 *   UNIQUE(handyman_request_id) and UNIQUE(handyman_diagnosis_id) pin the
 *   one-referral-per-request/diagnosis contract for CR-HM-03.
 *
 *   DB protection: BEFORE UPDATE / DELETE trigger (same family as
 *   0380/0381/0382 Handyman guards). INSERT is the only write ever allowed.
 */
export const migration0383CreateHandymanRequestReferrals: Migration = {
  id: '0383_create_handyman_request_referrals',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_request_referrals (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        handyman_request_id      UUID NOT NULL,
        channel_attribution_id   UUID NOT NULL REFERENCES handyman_channel_attributions (id),
        building_id              UUID NOT NULL REFERENCES buildings (id),
        handyman_diagnosis_id    UUID NOT NULL REFERENCES handyman_request_diagnoses (id),
        referral_type            TEXT NOT NULL,
        handyman_discipline_id   UUID NOT NULL REFERENCES handyman_disciplines (id),
        discipline_code          TEXT NOT NULL,
        referral_note            TEXT NOT NULL,
        referred_by_user_id      UUID NOT NULL REFERENCES users (id),
        referred_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_request_referrals_type_check
          CHECK (referral_type IN ('SPECIALIST', 'OUT_OF_SCOPE')),
        CONSTRAINT handyman_request_referrals_note_length_check
          CHECK (char_length(referral_note) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_request_referrals_request_unique
          UNIQUE (handyman_request_id),
        CONSTRAINT handyman_request_referrals_diagnosis_unique
          UNIQUE (handyman_diagnosis_id),
        CONSTRAINT handyman_request_referrals_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_request_referrals_scope_idx
        ON handyman_request_referrals (client_id, referred_at)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_request_referrals_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman referral records are append-only.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_request_referrals_no_update
        BEFORE UPDATE ON handyman_request_referrals
        FOR EACH ROW EXECUTE FUNCTION handyman_request_referrals_block_mutation()
    `);
    await client.query(`
      CREATE TRIGGER handyman_request_referrals_no_delete
        BEFORE DELETE ON handyman_request_referrals
        FOR EACH ROW EXECUTE FUNCTION handyman_request_referrals_block_mutation()
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_request_referrals CASCADE');
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_request_referrals_block_mutation() CASCADE',
    );
  },
};
