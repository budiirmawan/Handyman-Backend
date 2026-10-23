import type { Migration } from './types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — Competency requirements per JOB TYPE.
 *
 * A "job type" in the Handyman flow is the governed Service Catalog entry
 * (`service_catalog`, 0321) attached to the Service Request (0378) that the
 * Execution Scope (0395) is derived from. Until now the catalog entry carried
 * identity only (code/name/category/status); there was no place to say
 * "this job needs an ADVANCED electrical skill" or "this job needs a valid,
 * verified K3 certificate".
 *
 * `service_catalog_competency_requirements` adds exactly that, and nothing
 * else:
 *
 *   1. OPTIONAL BY CONSTRUCTION. Zero rows means zero requirements, which is
 *      the state of every existing catalog entry after this migration. No
 *      worker is ever required to hold a certificate unless a Client
 *      explicitly configures one (governance constraint of this CR).
 *   2. TWO REQUIREMENT KINDS.
 *        SKILL         — `skill_id` + `minimum_proficiency_level`
 *                        (BASIC < INTERMEDIATE < ADVANCED < EXPERT, the
 *                        BE-03D2 vocabulary in `workforce_skill_assignments`).
 *        CERTIFICATION — `certificate_name` (compared case-insensitively
 *                        against `workforce_certifications.certificate_name`),
 *                        optionally narrowed to one `skill_id`.
 *   3. TWO ENFORCEMENT LEVELS. `MANDATORY` blocks assignment/reassignment;
 *      `RECOMMENDED` is reported as advice only and never blocks. Neither
 *      level changes the assignment workflow itself.
 *   4. CLIENT ISOLATION. The candidate skill must belong to the same Client as
 *      the catalog entry, enforced by trigger (0461 precedent) so no service
 *      or seed can cross Clients.
 *   5. TERMINAL DEACTIVATION. `status` is ACTIVE → INACTIVE; a deactivated
 *      requirement stops applying immediately but is never deleted, so the
 *      assignment audit trail keeps referring to a real row.
 *
 * This migration deliberately does NOT touch `handyman_execution_scope_assignments`
 * (CR-HM-04 frozen table) and does NOT create an alternative assignment path:
 * the requirement is consumed by the existing assignment authority.
 */
export const migration0463ServiceCatalogCompetencyRequirements: Migration = {
  id: '0463_service_catalog_competency_requirements',
  async up(client) {
    await client.query(`
      CREATE TABLE service_catalog_competency_requirements (
        id                         UUID PRIMARY KEY,
        client_id                  UUID NOT NULL REFERENCES clients (id),
        service_catalog_id         UUID NOT NULL,
        requirement_type           TEXT NOT NULL,
        enforcement_level          TEXT NOT NULL DEFAULT 'MANDATORY',
        skill_id                   UUID REFERENCES skills (id),
        minimum_proficiency_level  TEXT,
        certificate_name           TEXT,
        notes                      TEXT,
        status                     TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id         UUID NOT NULL REFERENCES users (id),
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT service_catalog_competency_requirements_client_fk
          FOREIGN KEY (service_catalog_id, client_id)
            REFERENCES service_catalog (id, client_id),
        CONSTRAINT service_catalog_competency_requirements_type_check
          CHECK (requirement_type IN ('SKILL', 'CERTIFICATION')),
        CONSTRAINT service_catalog_competency_requirements_enforcement_check
          CHECK (enforcement_level IN ('MANDATORY', 'RECOMMENDED')),
        CONSTRAINT service_catalog_competency_requirements_proficiency_check
          CHECK (
            minimum_proficiency_level IS NULL
            OR minimum_proficiency_level
               IN ('BASIC', 'INTERMEDIATE', 'ADVANCED', 'EXPERT')
          ),
        CONSTRAINT service_catalog_competency_requirements_shape_check
          CHECK (
            (
              requirement_type = 'SKILL'
              AND skill_id IS NOT NULL
              AND minimum_proficiency_level IS NOT NULL
              AND certificate_name IS NULL
            )
            OR
            (
              requirement_type = 'CERTIFICATION'
              AND certificate_name IS NOT NULL
              AND minimum_proficiency_level IS NULL
            )
          ),
        CONSTRAINT service_catalog_competency_requirements_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT service_catalog_competency_requirements_cert_name_check
          CHECK (
            certificate_name IS NULL
            OR char_length(btrim(certificate_name)) BETWEEN 1 AND 255
          ),
        CONSTRAINT service_catalog_competency_requirements_notes_check
          CHECK (notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 1000)
      )
    `);

    // One ACTIVE SKILL requirement per (job type, skill) — a "minimum level" is
    // a single number, never two conflicting rows.
    await client.query(`
      CREATE UNIQUE INDEX service_catalog_competency_requirements_skill_unique
        ON service_catalog_competency_requirements (service_catalog_id, skill_id)
        WHERE requirement_type = 'SKILL' AND status = 'ACTIVE'
    `);

    // One ACTIVE CERTIFICATION requirement per (job type, certificate name),
    // compared the same way the evaluator compares it.
    await client.query(`
      CREATE UNIQUE INDEX service_catalog_competency_requirements_cert_unique
        ON service_catalog_competency_requirements (
          service_catalog_id,
          lower(btrim(certificate_name))
        )
        WHERE requirement_type = 'CERTIFICATION' AND status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX service_catalog_competency_requirements_catalog_idx
        ON service_catalog_competency_requirements (
          service_catalog_id,
          status,
          enforcement_level
        )
    `);

    await client.query(`
      CREATE INDEX service_catalog_competency_requirements_client_idx
        ON service_catalog_competency_requirements (client_id, status)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION service_catalog_competency_requirements_scope_guard()
      RETURNS TRIGGER AS $$
      DECLARE
        v_catalog_client_id UUID;
        v_skill_client_id UUID;
      BEGIN
        SELECT sc.client_id
          INTO v_catalog_client_id
          FROM service_catalog sc
         WHERE sc.id = NEW.service_catalog_id;

        IF v_catalog_client_id IS NULL THEN
          RAISE EXCEPTION 'service_catalog_id % does not exist',
            NEW.service_catalog_id
            USING ERRCODE = '23503';
        END IF;

        IF v_catalog_client_id <> NEW.client_id THEN
          RAISE EXCEPTION
            'service_catalog_competency_requirements client_id % does not match catalog client %',
            NEW.client_id, v_catalog_client_id
            USING ERRCODE = '23514';
        END IF;

        IF NEW.skill_id IS NOT NULL THEN
          SELECT s.client_id INTO v_skill_client_id FROM skills s
           WHERE s.id = NEW.skill_id;

          IF v_skill_client_id IS NULL OR v_skill_client_id <> NEW.client_id THEN
            RAISE EXCEPTION
              'service_catalog_competency_requirements skill_id % does not belong to client_id %',
              NEW.skill_id, NEW.client_id
              USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      CREATE TRIGGER trg_service_catalog_competency_requirements_scope_guard
        BEFORE INSERT OR UPDATE ON service_catalog_competency_requirements
        FOR EACH ROW
        EXECUTE FUNCTION service_catalog_competency_requirements_scope_guard()
    `);
  },

  async down(client) {
    await client.query(`
      DROP TRIGGER IF EXISTS trg_service_catalog_competency_requirements_scope_guard
        ON service_catalog_competency_requirements
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS service_catalog_competency_requirements_scope_guard()
    `);
    await client.query(`
      DROP TABLE IF EXISTS service_catalog_competency_requirements
    `);
  },
};
