import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-02 PART 02 — Handyman Common Material Profile foundation.
 *
 * `handyman_common_material_profiles` is the bounded Handyman discovery
 * association (frozen chain): service_catalog master → optional Handyman
 * variant (0376) → common material profile → existing inventory item/SKU
 * master (0166). The inventory item remains the authoritative material
 * master; the price-catalog remains the reference-price authority (nothing
 * is copied here — no price columns exist by design).
 *
 * Frozen metadata only: specification / compatibility, typical quantity,
 * commonality, customer material option. Client scope is NEVER caller-
 * supplied: `client_id` is derived from the parent service entry and proven
 * structurally by the composite scope-FKs against `service_catalog`
 * (id, client_id) and `handyman_service_variants` (id, client_id) (the
 * 0313/0319/0321/0376 precedent). The variant↔service and item↔client
 * relationship checks live in the service layer (a variant may only belong
 * to the selected service; the material must sit in the same Client).
 *
 * Association identity: (service, inventory item) at service level and
 * (variant, inventory item) at variant level — two partial unique indexes
 * (NULL variant ids are never equal in a plain UNIQUE constraint).
 *
 * This association is never an inventory reservation, issue, stock
 * movement, purchase, or any FM workflow behavior.
 */
export const migration0377CreateHandymanCommonMaterialProfiles: Migration = {
  id: '0377_create_handyman_common_material_profiles',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_common_material_profiles (
        id                      UUID PRIMARY KEY,
        client_id               UUID NOT NULL REFERENCES clients (id),
        service_catalog_id      UUID NOT NULL,
        service_variant_id      UUID,
        inventory_item_id       UUID NOT NULL REFERENCES inventory_items (id),
        specification           TEXT,
        compatibility           TEXT,
        typical_quantity        NUMERIC(12,3),
        commonality             TEXT NOT NULL,
        customer_material_option TEXT NOT NULL,
        status                  TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id      UUID NOT NULL REFERENCES users (id),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- Scope-FK precedent: Client scope proven structurally against the
        -- service master and (when present) the Handyman variant.
        CONSTRAINT handyman_common_material_profiles_service_scope_fk
          FOREIGN KEY (service_catalog_id, client_id)
            REFERENCES service_catalog (id, client_id),
        CONSTRAINT handyman_common_material_profiles_variant_scope_fk
          FOREIGN KEY (service_variant_id, client_id)
            REFERENCES handyman_service_variants (id, client_id),
        CONSTRAINT handyman_common_material_profiles_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_common_material_profiles_specification_check
          CHECK (specification IS NULL
            OR length(btrim(specification)) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_common_material_profiles_compatibility_check
          CHECK (compatibility IS NULL
            OR length(btrim(compatibility)) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_common_material_profiles_typical_quantity_check
          CHECK (typical_quantity IS NULL OR typical_quantity > 0),
        CONSTRAINT handyman_common_material_profiles_commonality_check
          CHECK (commonality IN ('COMMON', 'OCCASIONAL', 'RARE')),
        CONSTRAINT handyman_common_material_profiles_customer_option_check
          CHECK (customer_material_option IN (
            'PROVIDER_SUPPLIED', 'CUSTOMER_SUPPLIED', 'CUSTOMER_CHOICE')),
        CONSTRAINT handyman_common_material_profiles_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      -- Association identity: one material per service (service level) and
      -- one material per variant (variant level); NULL variant ids are
      -- never equal in a plain UNIQUE constraint, hence two partial indexes
      -- (common repo idiom for nullable-unique associations).
      CREATE UNIQUE INDEX handyman_common_material_profiles_service_unique
        ON handyman_common_material_profiles
          (service_catalog_id, inventory_item_id)
        WHERE service_variant_id IS NULL;
      CREATE UNIQUE INDEX handyman_common_material_profiles_variant_unique
        ON handyman_common_material_profiles
          (service_variant_id, inventory_item_id)
        WHERE service_variant_id IS NOT NULL;
      CREATE INDEX handyman_common_material_profiles_client_idx
        ON handyman_common_material_profiles (client_id, status);
      CREATE INDEX handyman_common_material_profiles_service_idx
        ON handyman_common_material_profiles (service_catalog_id, status);
      CREATE INDEX handyman_common_material_profiles_variant_idx
        ON handyman_common_material_profiles (service_variant_id);
      CREATE INDEX handyman_common_material_profiles_item_idx
        ON handyman_common_material_profiles (inventory_item_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS handyman_common_material_profiles',
    );
  },
};
