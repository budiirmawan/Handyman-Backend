import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-12J — Visitor / Security Binding.
 *
 * Minimum Security-side binding between a Security operational context
 * (Building × optional Security Post × optional Security Workforce) and
 * a future authoritative Visitor / Visit reference.
 *
 * This PART does NOT create a Visitor Management platform. The
 * repository has no authoritative Visitor / Visit domain today (the
 * `invitations` module is the BE-01 user-invitation flow, unrelated to
 * physical visitors). To keep the Security binding future-proof
 * without inventing a Visitor lifecycle, the binding carries an
 * opaque `external_visit_reference` — a free-form string supplied by
 * the caller that a future Visitor module can later match against its
 * authoritative id. No visitor personal data is copied into the
 * Security binding.
 *
 * Once a future Visitor module exists and is wired in, the binding
 * can carry the authoritative `visitor_id` / `visit_id` through a
 * follow-up migration; the existing `external_visit_reference` rows
 * remain queryable by that value. This PART only creates the
 * Security-side row — the integration plan is the responsibility of
 * a later BE-12 PART (or the Visitor domain itself).
 *
 * `client_id` / `building_id` are denormalized for fast listing, but
 * the service derives them authoritatively from Building → Property →
 * Client (BE-02), so isolation can never drift.
 *
 * Duplicate control: at most one ACTIVE binding per
 * (building_id, external_visit_reference) — INACTIVE rows do not block
 * a re-bind. The index is partial (WHERE status = 'ACTIVE') so the
 * UNIQUE backstop is consistent with the rest of the Security binding
 * suite.
 */
export const migration0130CreateSecurityVisitorBindings: Migration = {
  id: '0130_create_security_visitor_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE security_visitor_bindings (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        building_id                 UUID NOT NULL REFERENCES buildings (id),
        security_post_id            UUID REFERENCES security_posts (id),
        security_workforce_id       UUID REFERENCES workforce_profiles (id),
        external_visit_reference    TEXT NOT NULL,
        security_context            TEXT,
        status                      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id          UUID NOT NULL REFERENCES users (id),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT security_visitor_binding_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX security_visitor_binding_active_building_ref
        ON security_visitor_bindings (building_id, external_visit_reference)
        WHERE status = 'ACTIVE';
      CREATE INDEX security_visitor_binding_building_idx
        ON security_visitor_bindings (building_id, status);
      CREATE INDEX security_visitor_binding_post_idx
        ON security_visitor_bindings (security_post_id);
      CREATE INDEX security_visitor_binding_workforce_idx
        ON security_visitor_bindings (security_workforce_id);
      CREATE INDEX security_visitor_binding_external_ref_idx
        ON security_visitor_bindings (external_visit_reference);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS security_visitor_bindings',
    );
  },
};
