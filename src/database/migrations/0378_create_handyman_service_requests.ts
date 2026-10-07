import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-02 PART 03 — Handyman request intake foundation (frozen D3).
 *
 * `handyman_service_requests` is the SIBLING Handyman-owned request
 * entity/lifecycle — it is deliberately NOT the tenant-service-request
 * entity and shares none of its OPEN/CANCELLED/CONVERTED FM lifecycle
 * semantics as business authority (existing FM request rows and their
 * conversion workflows are never touched).
 *
 * Every request is created from an EXISTING immutable CR-HM-01 channel
 * attribution: the attribution is the only authoritative provenance handle.
 * The context columns below are an immutable snapshot COPIED from the
 * attribution at creation (the attribution row itself is never mutated):
 * `client_id`, `tenant_company_id`, `tenant_pic_id`, `building_id`,
 * `space_id`, plus `origin_channel`/`origin_reference` — sufficient to
 * retain request → attribution → original BM handoff provenance.
 *
 * Lifecycle is a distinct minimal Handyman intake vocabulary. PART 03 fixes
 * exactly one state — INTAKE (created). No triage/diagnosis/escalation/
 * quotation/FM conversion transitions exist or are invented here.
 *
 * Scope-FK precedent (0313/0319/0321/0376/0377): Client scope is proven
 * structurally against the service master and (when present) the Handyman
 * variant.
 */
export const migration0378CreateHandymanServiceRequests: Migration = {
  id: '0378_create_handyman_service_requests',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_service_requests (
        id                      UUID PRIMARY KEY,
        client_id               UUID NOT NULL REFERENCES clients (id),
        channel_attribution_id  UUID NOT NULL
          UNIQUE REFERENCES handyman_channel_attributions (id),
        tenant_company_id       UUID NOT NULL REFERENCES tenant_companies (id),
        tenant_pic_id           UUID REFERENCES tenant_pics (id),
        building_id             UUID NOT NULL REFERENCES buildings (id),
        space_id                UUID REFERENCES spaces (id),
        service_catalog_id      UUID NOT NULL,
        service_variant_id      UUID,
        origin_channel          TEXT NOT NULL,
        origin_reference        TEXT,
        description             TEXT,
        status                  TEXT NOT NULL DEFAULT 'INTAKE',
        created_by_user_id      UUID REFERENCES users (id),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_service_requests_service_scope_fk
          FOREIGN KEY (service_catalog_id, client_id)
            REFERENCES service_catalog (id, client_id),
        CONSTRAINT handyman_service_requests_variant_scope_fk
          FOREIGN KEY (service_variant_id, client_id)
            REFERENCES handyman_service_variants (id, client_id),
        CONSTRAINT handyman_service_requests_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_service_requests_origin_channel_check
          CHECK (origin_channel IN ('BM_SUPER_APP')),
        CONSTRAINT handyman_service_requests_description_check
          CHECK (description IS NULL
            OR length(btrim(description)) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_service_requests_status_check
          -- Minimal Handyman intake lifecycle (frozen D3): exactly the
          -- creation state; triage/diagnosis transitions are CR-HM-03 scope.
          CHECK (status IN ('INTAKE'))
      )
    `);

    await client.query(`
      CREATE INDEX handyman_service_requests_client_idx
        ON handyman_service_requests (client_id, status);
      CREATE INDEX handyman_service_requests_building_idx
        ON handyman_service_requests (building_id, status);
      CREATE INDEX handyman_service_requests_service_idx
        ON handyman_service_requests (service_catalog_id, status);
      CREATE INDEX handyman_service_requests_attribution_idx
        ON handyman_service_requests (channel_attribution_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_service_requests');
  },
};
