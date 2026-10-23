import type { Migration } from './types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B1 — two append-only ledgers.
 *
 * 1. `workforce_certification_decisions` (PART A — re-verification).
 *
 *    PART 02 kept exactly one decision per certificate: the CURRENT
 *    `verification_status` + `verified_by_user_id` + `verified_at` triple on
 *    `workforce_certifications` (0461). That is enough to answer "may this
 *    certificate satisfy a requirement today", but it silently DELETES the
 *    previous attestation the moment a decision changes — and PART 03B1 makes
 *    that happen routinely (a material metadata edit resets the decision to
 *    `PENDING_VERIFICATION`).
 *
 *    This table keeps every decision as its own immutable row:
 *      - `decision` = the resulting status (`VERIFIED` / `REJECTED` /
 *        `PENDING_VERIFICATION`),
 *      - `previous_*` = the decision it replaced (the audit the single-row model
 *        used to destroy),
 *      - `changed_fields` = the material fields that forced a reset
 *        (`NULL` for an explicit verify/reject decision),
 *      - `decided_by_user_id` = who did it (`NULL` only for the managed
 *        metadata-reset path, where the PATCH actor may be absent on internal
 *        calls),
 *      - `reason` = the free-text note supplied with a verify/reject decision.
 *
 * 2. `handyman_assignment_competency_evaluations` (PART B — decision history).
 *
 *    PART 03A already evaluates every ACTIVE crew member against every ACTIVE
 *    requirement, but only retained the AGGREGATE
 *    (`operational_events.metadata.competency = {requirementCount,
 *    mandatoryRequirementCount}`). That answers "was the gate run" and not
 *    "what exactly was compared, against which evidence".
 *
 *    One row per (assignment action × worker × requirement), written in the
 *    SAME transaction as the assignment itself, so a rolled-back assignment can
 *    never leave a decision behind.
 *
 *    Privacy boundary (deliberate):
 *      - NO certificate number, NO document id, NO `file_reference` (the storage
 *        key), NO document bytes, NO tokens. The snapshot keeps only the opaque
 *        `evidence_certification_id`, the verification status and the expiry
 *        date — enough to explain the verdict, not enough to leak a document.
 *      - Requirement facts are denormalised (type/level/name) because a
 *        requirement can later be edited or deactivated; the decision must stay
 *        explainable against the configuration that actually applied.
 *
 * Both tables reject UPDATE and DELETE (append-only triggers), matching the
 * existing immutable-history convention (`0396`, CR-HM-04).
 */
export const migration0464WorkforceCompetencyDecisionHistory: Migration = {
  id: '0464_workforce_competency_decision_history',
  async up(client) {
    // ------------------------------------------------------------------ PART A
    await client.query(`
      CREATE TABLE workforce_certification_decisions (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        certification_id            UUID NOT NULL
          REFERENCES workforce_certifications (id),
        workforce_profile_id        UUID NOT NULL
          REFERENCES workforce_profiles (id),
        decision                    TEXT NOT NULL,
        previous_verification_status TEXT,
        previous_verified_by_user_id UUID REFERENCES users (id),
        previous_verified_at        TIMESTAMPTZ,
        changed_fields              TEXT[],
        reason                      TEXT,
        decided_by_user_id          UUID REFERENCES users (id),
        decided_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT workforce_certification_decisions_decision_check
          CHECK (decision IN ('VERIFIED', 'REJECTED', 'PENDING_VERIFICATION')),
        CONSTRAINT workforce_certification_decisions_previous_check
          CHECK (
            previous_verification_status IS NULL
            OR previous_verification_status
               IN ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED')
          ),
        -- A verifier/rejecter must be named: an attestation without an author
        -- is not an attestation.
        CONSTRAINT workforce_certification_decisions_actor_check
          CHECK (
            decision = 'PENDING_VERIFICATION'
            OR decided_by_user_id IS NOT NULL
          ),
        -- changed_fields only ever describes a reset.
        CONSTRAINT workforce_certification_decisions_changed_fields_check
          CHECK (
            changed_fields IS NULL
            OR (
              decision = 'PENDING_VERIFICATION'
              AND array_length(changed_fields, 1) >= 1
            )
          ),
        CONSTRAINT workforce_certification_decisions_reason_check
          CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 1000)
      )
    `);

    await client.query(`
      CREATE INDEX workforce_certification_decisions_cert_idx
        ON workforce_certification_decisions (certification_id, decided_at DESC)
    `);

    await client.query(`
      CREATE INDEX workforce_certification_decisions_client_idx
        ON workforce_certification_decisions (client_id, decided_at DESC)
    `);

    // ------------------------------------------------------------------ PART B
    await client.query(`
      CREATE TABLE handyman_assignment_competency_evaluations (
        id                         UUID PRIMARY KEY,
        decision_group_id          UUID NOT NULL,
        client_id                  UUID NOT NULL REFERENCES clients (id),
        execution_scope_id         UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        assignment_id              UUID NOT NULL
          REFERENCES handyman_execution_scope_assignments (id),
        handyman_crew_id           UUID NOT NULL,
        action                     TEXT NOT NULL,
        service_catalog_id         UUID NOT NULL,
        worker_context_id          UUID NOT NULL,
        workforce_profile_id       UUID NOT NULL,
        requirement_id             UUID NOT NULL,
        requirement_type           TEXT NOT NULL,
        enforcement_level          TEXT NOT NULL,
        skill_id                   UUID,
        skill_code                 TEXT,
        minimum_proficiency_level  TEXT,
        certificate_name           TEXT,
        satisfied                  BOOLEAN NOT NULL,
        reason                     TEXT,
        evidence_proficiency_level TEXT,
        evidence_certification_id  UUID,
        evidence_verification_status TEXT,
        evidence_expiry_date       TIMESTAMPTZ,
        evaluated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_assignment_competency_evaluations_action_check
          CHECK (action IN ('ASSIGNED', 'REASSIGNED')),
        CONSTRAINT handyman_assignment_competency_evaluations_type_check
          CHECK (requirement_type IN ('SKILL', 'CERTIFICATION')),
        CONSTRAINT handyman_assignment_competency_evaluations_enforcement_check
          CHECK (enforcement_level IN ('MANDATORY', 'RECOMMENDED')),
        CONSTRAINT handyman_assignment_competency_evaluations_proficiency_check
          CHECK (
            minimum_proficiency_level IS NULL
            OR minimum_proficiency_level
               IN ('BASIC', 'INTERMEDIATE', 'ADVANCED', 'EXPERT')
          ),
        CONSTRAINT handyman_assignment_competency_evaluations_reason_check
          CHECK (
            reason IS NULL
            OR reason IN (
              'SKILL_MISSING',
              'PROFICIENCY_INSUFFICIENT',
              'CERTIFICATION_MISSING',
              'CERTIFICATION_UNVERIFIED',
              'CERTIFICATION_EXPIRED',
              'CERTIFICATION_INACTIVE'
            )
          ),
        -- A satisfied row has no reason; an unsatisfied row must name one.
        CONSTRAINT handyman_assignment_competency_evaluations_outcome_check
          CHECK (
            (satisfied AND reason IS NULL)
            OR (NOT satisfied AND reason IS NOT NULL)
          ),
        CONSTRAINT handyman_assignment_competency_evaluations_evidence_check
          CHECK (
            evidence_proficiency_level IS NULL
            OR evidence_proficiency_level
               IN ('BASIC', 'INTERMEDIATE', 'ADVANCED', 'EXPERT')
          )
      )
    `);

    await client.query(`
      CREATE INDEX handyman_assignment_competency_evaluations_scope_idx
        ON handyman_assignment_competency_evaluations (
          client_id,
          execution_scope_id,
          evaluated_at DESC,
          id DESC
        )
    `);

    await client.query(`
      CREATE INDEX handyman_assignment_competency_evaluations_assignment_idx
        ON handyman_assignment_competency_evaluations (assignment_id)
    `);

    await client.query(`
      CREATE INDEX handyman_assignment_competency_evaluations_group_idx
        ON handyman_assignment_competency_evaluations (decision_group_id)
    `);

    // ------------------------------------------------------- append-only guard
    await client.query(`
      CREATE OR REPLACE FUNCTION workforce_competency_history_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          '% is an append-only decision ledger: % is forbidden.',
          TG_TABLE_NAME, TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      CREATE TRIGGER workforce_certification_decisions_no_write
        BEFORE UPDATE OR DELETE ON workforce_certification_decisions
        FOR EACH ROW
        EXECUTE FUNCTION workforce_competency_history_block_mutation()
    `);

    await client.query(`
      CREATE TRIGGER handyman_assignment_competency_evaluations_no_write
        BEFORE UPDATE OR DELETE ON handyman_assignment_competency_evaluations
        FOR EACH ROW
        EXECUTE FUNCTION workforce_competency_history_block_mutation()
    `);
  },

  async down(client) {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_assignment_competency_evaluations_no_write
        ON handyman_assignment_competency_evaluations
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS workforce_certification_decisions_no_write
        ON workforce_certification_decisions
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS workforce_competency_history_block_mutation()
    `);
    await client.query(`
      DROP TABLE IF EXISTS handyman_assignment_competency_evaluations
    `);
    await client.query(`
      DROP TABLE IF EXISTS workforce_certification_decisions
    `);
  },
};
