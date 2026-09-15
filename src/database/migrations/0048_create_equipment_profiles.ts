import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-05D — Equipment Profile foundation.
 *
 * An Equipment Profile is the TECHNICAL detail sheet attached to exactly one
 * existing Asset (Asset → Equipment Profile). It extends the Asset registry
 * with equipment-specific engineering data — specification, capacity + unit
 * of measure, installation / commissioning dates — and the nameplate
 * identity (`manufacturer`, `model`, `serial_number`) AS RECORDED ON THE
 * EQUIPMENT, which may legitimately differ from the Asset's administrative
 * master values.
 *
 * Client / Building ownership is NOT duplicated here: it is derived
 * authoritatively through Equipment Profile → Asset → Building → Property →
 * Client, exactly as BE-05C derives location. The Profile carries no
 * `client_id`, no `building_id`, and no location columns.
 *
 * `UNIQUE (asset_id)` is the hard rule: an Asset has at most ONE Equipment
 * Profile, so a second create is a conflict rather than a silent second
 * technical sheet. Deactivating a Profile (status INACTIVE) does not free the
 * slot — the record is retained for history and reactivated instead.
 *
 * `equipment_code` uniqueness is Client-scoped, which cannot be expressed as
 * a composite index here without denormalizing `client_id` onto the Profile
 * (duplicating Asset master identity). It is therefore enforced in the
 * service layer through an `assets`-joined lookup, and indexed below to keep
 * that lookup cheap.
 *
 * This migration creates NO lifecycle workflow, warranty, certification,
 * QR / identifier, history, PM, breakdown, work order, or checklist
 * structures — each belongs to a later PART or Wave.
 */
export const migration0048CreateEquipmentProfiles: Migration = {
  id: '0048_create_equipment_profiles',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE equipment_profiles (
        id                 UUID PRIMARY KEY,
        asset_id           UUID NOT NULL,
        equipment_code     TEXT NOT NULL,
        equipment_name     TEXT NOT NULL,
        manufacturer       TEXT,
        model              TEXT,
        serial_number      TEXT,
        specification      TEXT,
        capacity           NUMERIC(18, 4),
        unit_of_measure    TEXT,
        installation_date  DATE,
        commissioning_date DATE,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT equipment_profiles_asset_id_fkey
          FOREIGN KEY (asset_id) REFERENCES assets (id),
        CONSTRAINT equipment_profiles_asset_id_unique UNIQUE (asset_id),
        CONSTRAINT equipment_profiles_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        -- A capacity is a physical magnitude: never negative, and it is
        -- meaningless without the unit it is expressed in.
        CONSTRAINT equipment_profiles_capacity_check
          CHECK (capacity IS NULL OR capacity >= 0),
        CONSTRAINT equipment_profiles_capacity_uom_check
          CHECK (capacity IS NULL OR unit_of_measure IS NOT NULL),
        -- Equipment cannot be commissioned before it is installed.
        CONSTRAINT equipment_profiles_commissioning_after_installation_check
          CHECK (
            installation_date IS NULL
            OR commissioning_date IS NULL
            OR commissioning_date >= installation_date
          )
      )
    `);

    await client.query(
      `CREATE INDEX equipment_profiles_equipment_code_idx
         ON equipment_profiles (equipment_code)`,
    );
    await client.query(
      `CREATE INDEX equipment_profiles_status_idx
         ON equipment_profiles (status)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS equipment_profiles');
  },
};
