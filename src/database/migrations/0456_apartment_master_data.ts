import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-MASTER-IND-01 — Indonesian apartment master data closure.
 *
 * BOUNDED, ADDITIVE ONLY. Three real gaps are closed against the EXISTING
 * master data; no duplicate master table is introduced:
 *
 *  1. `tenant_companies.party_kind` (migration 0144) — the Tenant master can
 *     now represent an INDIVIDUAL customer directly. Before this migration
 *     every Tenant was company-shaped (`tenant_name` + optional
 *     `legal_name`), so an individual Owner/Tenant/Occupant could only be
 *     recorded by inventing a fictitious company. Physical customers
 *     (individuals and legal entities) stay ONE governed party master; the
 *     discriminator is a column, not a second table. Identity documents use
 *     the Indonesian vocabulary: KTP / PASSPORT / KITAS for individuals,
 *     NPWP / NIB for legal entities.
 *
 *  2. `unit_party_roles` — effective-dated, historical OWNER / OCCUPANT / PIC
 *     relationships between an existing party (tenant_companies) and an
 *     existing Unit. A Unit is the EXISTING `spaces` row (the repository's
 *     authoritative physical Unit master; the Customer Care gateway already
 *     exposes spaces as Units) — no `units` table is invented. TENANCY is
 *     deliberately NOT duplicated here: `tenant_space_relationships` (0146)
 *     remains the single authoritative occupancy authority (it already
 *     carries effective_from/effective_until and an ACTIVE-uniqueness wall
 *     per Unit). This table therefore covers only the roles the existing
 *     master does NOT carry: Owner, Occupant and Unit PIC.
 *
 *  3. `handyman_request_parties` — explicit APPROVAL and COST_RESPONSIBILITY
 *     designations for a canonical Handyman request, structurally independent
 *     from the request creator (a Backend user) and from the represented
 *     Tenant persisted on the immutable channel attribution. Append-only:
 *     a designation is a fact, never edited in place.
 *
 * Client/Building isolation is structural, not conventional:
 *   - `UNIQUE (id, client_id)` on `tenant_companies` (additive) lets every
 *     child prove its Client scope with a composite scope-FK, the
 *     0313/0319/0321/0376/0377 precedent;
 *   - `unit_party_roles` scope-FKs to `tenant_companies (id, client_id)` and
 *     a context trigger proves Unit → Floor → Building → Property → Client
 *     consistency, so a cross-Building or cross-Client row cannot exist even
 *     if every service-layer check were bypassed;
 *   - `handyman_request_parties` scope-FKs to the canonical request and the
 *     party master, plus a trigger that only accepts a party that is either
 *     the represented Tenant or currently holds a Unit role on the request's
 *     Unit.
 *
 * No lifecycle state is invented: roles are ACTIVE/INACTIVE with an explicit
 * effective window (the 0146/0147 idiom), and the request party vocabulary is
 * exactly APPROVAL / COST_RESPONSIBILITY.
 *
 * Two reference-master capabilities are registered (read/manage) for Unit
 * party data. They are inserted here so existing installations gain them
 * without a reseed, and are granted to PLATFORM_ADMIN by the foundation seed
 * (the `service_catalog.*` reference-master precedent). Unit reads/writes
 * themselves deliberately REUSE the existing `space.read` / `space.manage`
 * capabilities — a Unit is a Space, and a second permission would only
 * fragment an authority that already exists.
 */
export const migration0456ApartmentMasterData: Migration = {
  id: '0456_apartment_master_data',

  async up(client: PoolClient): Promise<void> {
    // ---- 1. Tenant master: individual vs legal entity ------------------
    await client.query(`
      ALTER TABLE tenant_companies
        ADD COLUMN party_kind TEXT NOT NULL DEFAULT 'LEGAL_ENTITY',
        ADD COLUMN identity_document_type TEXT,
        ADD COLUMN identity_document_number TEXT,
        ADD CONSTRAINT tenant_companies_party_kind_check
          CHECK (party_kind IN ('INDIVIDUAL', 'LEGAL_ENTITY')),
        ADD CONSTRAINT tenant_companies_identity_document_pair_check
          CHECK (
            (identity_document_type IS NULL
             AND identity_document_number IS NULL)
            OR (identity_document_type IS NOT NULL
                AND identity_document_number IS NOT NULL
                AND length(btrim(identity_document_number)) BETWEEN 4 AND 64)
          ),
        ADD CONSTRAINT tenant_companies_identity_document_kind_check
          CHECK (
            identity_document_type IS NULL
            OR (party_kind = 'INDIVIDUAL'
                AND identity_document_type IN ('KTP', 'PASSPORT', 'KITAS'))
            OR (party_kind = 'LEGAL_ENTITY'
                AND identity_document_type IN ('NPWP', 'NIB'))
          ),
        -- An individual is one physical person: a separate legal name would
        -- be a second, contradictory identity.
        ADD CONSTRAINT tenant_companies_individual_legal_name_check
          CHECK (party_kind <> 'INDIVIDUAL' OR legal_name IS NULL),
        -- Scope-FK anchor for child rows (0313/0319/0321/0376/0377 idiom).
        ADD CONSTRAINT tenant_companies_id_client_unique UNIQUE (id, client_id)
    `);

    await client.query(`
      -- One identity document can identify exactly one party per Client.
      CREATE UNIQUE INDEX tenant_companies_identity_document_unique
        ON tenant_companies
          (client_id, identity_document_type, identity_document_number)
        WHERE identity_document_number IS NOT NULL;
      CREATE INDEX tenant_companies_client_party_kind_idx
        ON tenant_companies (client_id, party_kind, status)
    `);

    // ---- 2. Effective-dated Unit party roles (OWNER/OCCUPANT/PIC) ------
    await client.query(`
      CREATE TABLE unit_party_roles (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        building_id        UUID NOT NULL REFERENCES buildings (id),
        -- The Unit IS the existing Space master (no duplicate units table).
        space_id           UUID NOT NULL REFERENCES spaces (id),
        tenant_company_id  UUID NOT NULL,
        party_role         TEXT NOT NULL,
        effective_from     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        effective_until    TIMESTAMPTZ,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT unit_party_roles_party_scope_fk
          FOREIGN KEY (tenant_company_id, client_id)
            REFERENCES tenant_companies (id, client_id),
        CONSTRAINT unit_party_roles_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT unit_party_roles_role_check
          CHECK (party_role IN ('OWNER', 'OCCUPANT', 'PIC')),
        CONSTRAINT unit_party_roles_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT unit_party_roles_window_check
          CHECK (effective_until IS NULL OR effective_until > effective_from),
        -- A closed role must carry its effective end; history is never a
        -- status flag without a timestamp.
        CONSTRAINT unit_party_roles_closed_window_check
          CHECK (status = 'ACTIVE' OR effective_until IS NOT NULL)
      )
    `);

    await client.query(`
      -- One currently-effective assignment of the same party in the same role
      -- on the same Unit. Different parties (co-owners, several occupants) and
      -- HISTORIC rows are all allowed: history is the point.
      CREATE UNIQUE INDEX unit_party_roles_active_party_unique
        ON unit_party_roles (space_id, party_role, tenant_company_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX unit_party_roles_unit_idx
        ON unit_party_roles (space_id, status, party_role);
      CREATE INDEX unit_party_roles_party_idx
        ON unit_party_roles (tenant_company_id, status);
      CREATE INDEX unit_party_roles_building_idx
        ON unit_party_roles (building_id, status);
    `);

    await client.query(`
      CREATE FUNCTION unit_party_roles_context_guard()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $unit_party_roles_context_guard$
      DECLARE
        unit_building UUID;
        unit_client UUID;
        unit_status TEXT;
        party_client UUID;
        party_status TEXT;
      BEGIN
        IF TG_OP = 'UPDATE' AND (
          NEW.client_id IS DISTINCT FROM OLD.client_id
          OR NEW.building_id IS DISTINCT FROM OLD.building_id
          OR NEW.space_id IS DISTINCT FROM OLD.space_id
          OR NEW.tenant_company_id IS DISTINCT FROM OLD.tenant_company_id
          OR NEW.party_role IS DISTINCT FROM OLD.party_role
        ) THEN
          RAISE EXCEPTION 'Unit party role identity is immutable.'
            USING ERRCODE = '23514';
        END IF;

        SELECT b.id, p.client_id, s.status
          INTO unit_building, unit_client, unit_status
          FROM spaces s
          JOIN rooms r ON r.id = s.room_id
          JOIN areas a ON a.id = r.area_id
          JOIN floors f ON f.id = a.floor_id
          JOIN buildings b ON b.id = f.building_id
          JOIN properties p ON p.id = b.property_id
         WHERE s.id = NEW.space_id;

        IF unit_building IS NULL
           OR unit_building IS DISTINCT FROM NEW.building_id
           OR unit_client IS DISTINCT FROM NEW.client_id THEN
          RAISE EXCEPTION
            'Unit party role must resolve to its own Building and Client.'
            USING ERRCODE = '23514';
        END IF;

        SELECT tc.client_id, tc.status
          INTO party_client, party_status
          FROM tenant_companies tc
         WHERE tc.id = NEW.tenant_company_id;

        IF party_client IS NULL
           OR party_client IS DISTINCT FROM NEW.client_id THEN
          RAISE EXCEPTION
            'Unit party role party must belong to the same Client.'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.status = 'ACTIVE'
           AND (unit_status <> 'ACTIVE' OR party_status <> 'ACTIVE') THEN
          RAISE EXCEPTION
            'An active Unit party role requires an ACTIVE Unit and ACTIVE party.'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $unit_party_roles_context_guard$;

      CREATE TRIGGER unit_party_roles_context_guard
        BEFORE INSERT OR UPDATE ON unit_party_roles
        FOR EACH ROW
        EXECUTE FUNCTION unit_party_roles_context_guard();
    `);

    // ---- 3. Request-level approval / cost responsibility parties -------
    await client.query(`
      CREATE TABLE handyman_request_parties (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        request_id         UUID NOT NULL,
        party_role         TEXT NOT NULL,
        tenant_company_id  UUID NOT NULL,
        tenant_pic_id      UUID REFERENCES tenant_pics (id),
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_request_parties_request_scope_fk
          FOREIGN KEY (request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id),
        CONSTRAINT handyman_request_parties_party_scope_fk
          FOREIGN KEY (tenant_company_id, client_id)
            REFERENCES tenant_companies (id, client_id),
        CONSTRAINT handyman_request_parties_role_check
          CHECK (party_role IN ('APPROVAL', 'COST_RESPONSIBILITY')),
        -- Exactly one designation per role per request.
        CONSTRAINT handyman_request_parties_request_role_unique
          UNIQUE (request_id, party_role)
      )
    `);

    await client.query(`
      CREATE INDEX handyman_request_parties_client_idx
        ON handyman_request_parties (client_id, created_at);
      CREATE INDEX handyman_request_parties_party_idx
        ON handyman_request_parties (tenant_company_id, party_role);
    `);

    await client.query(`
      CREATE FUNCTION handyman_request_parties_guard()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $handyman_request_parties_guard$
      DECLARE
        request_tenant UUID;
        request_space UUID;
        request_building UUID;
        pic_tenant UUID;
        pic_status TEXT;
        party_has_unit_role BOOLEAN;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          RAISE EXCEPTION
            'handyman_request_parties is append-only; % is not permitted.',
            TG_OP
            USING ERRCODE = '23514';
        END IF;

        SELECT r.tenant_company_id, r.space_id, r.building_id
          INTO request_tenant, request_space, request_building
          FROM handyman_service_requests r
         WHERE r.id = NEW.request_id AND r.client_id = NEW.client_id;

        IF request_tenant IS NULL THEN
          RAISE EXCEPTION
            'Request party must reference a request in the same Client.'
            USING ERRCODE = '23514';
        END IF;

        -- The designated party must be one of the parties that actually
        -- belongs to this request's Unit: the represented Tenant itself, or
        -- a party holding a currently-effective Unit role (OWNER/OCCUPANT/
        -- PIC) on that exact Unit.
        SELECT EXISTS (
          SELECT 1
            FROM unit_party_roles upr
           WHERE upr.space_id = request_space
             AND upr.building_id = request_building
             AND upr.client_id = NEW.client_id
             AND upr.tenant_company_id = NEW.tenant_company_id
             AND upr.status = 'ACTIVE'
             AND upr.effective_from <= statement_timestamp()
             AND (upr.effective_until IS NULL
                  OR upr.effective_until >= statement_timestamp())
        ) INTO party_has_unit_role;

        IF NEW.tenant_company_id <> request_tenant AND NOT party_has_unit_role THEN
          RAISE EXCEPTION
            'Request party must be the represented Tenant or hold a current Unit role.'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.tenant_pic_id IS NOT NULL THEN
          SELECT tp.tenant_company_id, tp.status
            INTO pic_tenant, pic_status
            FROM tenant_pics tp
           WHERE tp.id = NEW.tenant_pic_id;

          IF pic_tenant IS NULL
             OR pic_tenant <> NEW.tenant_company_id
             OR pic_status <> 'ACTIVE' THEN
            RAISE EXCEPTION
              'Request party PIC must be an ACTIVE PIC of the designated party.'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $handyman_request_parties_guard$;

      CREATE TRIGGER handyman_request_parties_guard
        BEFORE INSERT OR UPDATE OR DELETE ON handyman_request_parties
        FOR EACH ROW
        EXECUTE FUNCTION handyman_request_parties_guard();
    `);

    // ---- 4. Reference-master capabilities ------------------------------
    const permissions: readonly (readonly [string, string])[] = [
      ['unit_party.read', 'Read Unit Owner/Occupant/PIC Assignments'],
      ['unit_party.manage', 'Manage Unit Owner/Occupant/PIC Assignments'],
    ];
    for (const [code, name] of permissions) {
      await client.query(
        `INSERT INTO permissions (id, code, name, status)
         VALUES ($1, $2, $3, 'ACTIVE') ON CONFLICT (code) DO NOTHING`,
        [randomUUID(), code, name],
      );
    }
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS handyman_request_parties',
    );
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_request_parties_guard()',
    );
    await client.query('DROP TABLE IF EXISTS unit_party_roles');
    await client.query(
      'DROP FUNCTION IF EXISTS unit_party_roles_context_guard()',
    );
    // Capability catalogue entries remain (0442/0446/0448/0450 precedent):
    // deleting permissions on rollback could invalidate grants.
    await client.query(`
      DROP INDEX IF EXISTS tenant_companies_identity_document_unique;
      DROP INDEX IF EXISTS tenant_companies_client_party_kind_idx;
      ALTER TABLE tenant_companies
        DROP CONSTRAINT IF EXISTS tenant_companies_id_client_unique,
        DROP CONSTRAINT IF EXISTS tenant_companies_individual_legal_name_check,
        DROP CONSTRAINT IF EXISTS tenant_companies_identity_document_kind_check,
        DROP CONSTRAINT IF EXISTS tenant_companies_identity_document_pair_check,
        DROP CONSTRAINT IF EXISTS tenant_companies_party_kind_check,
        DROP COLUMN IF EXISTS identity_document_number,
        DROP COLUMN IF EXISTS identity_document_type,
        DROP COLUMN IF EXISTS party_kind
    `);
  },
};
