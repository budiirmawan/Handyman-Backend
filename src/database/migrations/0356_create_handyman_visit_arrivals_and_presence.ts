import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-06 RUN 1 — Handyman visit arrival attempts + crew presence
 * snapshot.
 *
 *   handyman_service_visits (BE-05 occurrence identity, ACTIVE window)
 *     → handyman_visit_arrivals   (append-only verification attempts)
 *       → handyman_visit_presence (crew snapshot taken at the ONE VERIFIED
 *                                  arrival, then governed presence marks)
 *
 * Governance decisions encoded here (CR-HM-BE-06):
 * - ARRIVAL AUTHORITY: arrival is a verified VISIT FACT — not attendance,
 *   not a work-order/vendor-work transition, not a session start. Attempts
 *   are APPEND-ONLY evidence rows: no DELETE authority, no mutable verified
 *   flag anywhere, and the visit row itself gains NO arrival state. At most
 *   one VERIFIED arrival per visit is a partial unique index; FAILED GPS
 *   attempts accumulate as honest history (a later attempt may verify).
 * - SERVER-DECIDED VERIFICATION: raw client GPS (latitude/longitude/
 *   accuracy) is stored as claimed EVIDENCE INPUT only — double precision
 *   so an out-of-range claim is retained exactly as submitted and judged by
 *   the service, never by a column constraint that would erase the claim.
 *   `verification_result` is exclusively the server's decision; the client
 *   never supplies it. `received_at` is server-authoritative; `occurred_at`
 *   is a nullable client-claimed evidence timestamp (offline tolerance).
 * - POLICY PROVENANCE: GPS evaluation records the exact building
 *   configuration row + ACTIVE configuration version it decided with.
 *   Deliberately NO foreign keys on these two provenance columns: the
 *   configuration foundations carry no DELETE authority, and
 *   `configuration_versions.source_configuration_id` is itself an un-FK'd
 *   polymorphic reference (the versioning foundation's own idiom) — the
 *   arrival history must outlive and never constrain configuration
 *   lifecycle operations.
 * - ASSISTED ARRIVAL is a provenance-bearing override, never fake GPS:
 *   method ASSISTED is structurally VERIFIED, carries a mandatory
 *   non-empty reason and the real staff recorder, and stores NO
 *   coordinates, NO accuracy, NO distance and NO policy provenance. A
 *   prior FAILED GPS attempt is never rewritten — history shows both facts.
 * - CREW PRESENCE is visit-scoped and snapshot-bound: rows are created in
 *   the SAME transaction as the first VERIFIED arrival, exclusively from
 *   the ACTIVE crew composition at that moment (one row per visit+binding,
 *   structural UNIQUE). Later crew changes never rewrite the snapshot;
 *   only snapshot members are markable, so arbitrary worker ids cannot be
 *   added. No worker name/contact/profile copy (binding id + role only),
 *   no users.id requirement for helpers (helpers never authenticate), and
 *   no HR attendance row — this is NOT attendance_records semantics.
 *   Presence marks carry recorder attribution, the recording path
 *   (LEAD field action vs STAFF_ASSISTED override — never a silent lead
 *   impersonation) and, for the assisted path, a mandatory reason.
 * - IDEMPOTENCY (the CR-HM-BE-01 convention): client-supplied key +
 *   fingerprint, unique per CLIENT (one client cannot collide with
 *   another's key); replay returns the original attempt, materially
 *   different facts under the same key are a conflict, and a NEW key always
 *   records a NEW attempt (idempotency never suppresses FAILED history).
 * - Arrival verification policy itself lives in the EXISTING building
 *   configuration authority (BE-27B record + BE-27N/O version lifecycle)
 *   under the Handyman-owned key HANDYMAN.ARRIVALVERIFICATION — NO
 *   Handyman configuration table, no magic default radius: absent,
 *   inactive, unactivated or schema-invalid policy is fail-closed
 *   (GPS verification unavailable → FAILED attempt with an owned reason).
 *
 * RBAC permissions: `handyman_work_execution.read`,
 * `handyman_work_execution.manage`, bootstrapped to PLATFORM_ADMIN (the
 * 0353/0354/0355 pattern); HTTP wiring follows in Run 3.
 */
export const migration0356CreateHandymanVisitArrivalsAndPresence: Migration = {
  id: '0356_create_handyman_visit_arrivals_and_presence',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_visit_arrivals (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL,
        handyman_service_visit_id   UUID NOT NULL,
        verification_method         TEXT NOT NULL,
        verification_result         TEXT NOT NULL,
        received_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        occurred_at                 TIMESTAMPTZ,
        latitude                    DOUBLE PRECISION,
        longitude                   DOUBLE PRECISION,
        accuracy_meters             DOUBLE PRECISION,
        distance_meters             DOUBLE PRECISION,
        building_configuration_id   UUID,
        configuration_version_id    UUID,
        assisted_reason             TEXT,
        failure_reason              TEXT,
        recorded_by_user_id         UUID NOT NULL,
        idempotency_key             TEXT NOT NULL,
        idempotency_fingerprint     TEXT NOT NULL,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_visit_arrivals_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT handyman_visit_arrivals_visit_id_fkey
          FOREIGN KEY (handyman_service_visit_id)
          REFERENCES handyman_service_visits (id),
        CONSTRAINT handyman_visit_arrivals_recorded_by_user_id_fkey
          FOREIGN KEY (recorded_by_user_id) REFERENCES users (id),
        CONSTRAINT handyman_visit_arrivals_method_check
          CHECK (verification_method IN ('GPS', 'ASSISTED')),
        CONSTRAINT handyman_visit_arrivals_result_check
          CHECK (verification_result IN ('VERIFIED', 'FAILED')),
        CONSTRAINT handyman_visit_arrivals_failure_reason_check
          CHECK (
            failure_reason IS NULL OR failure_reason IN (
              'INVALID_COORDINATES',
              'INVALID_ACCURACY',
              'ARRIVAL_POLICY_UNAVAILABLE',
              'ARRIVAL_POLICY_INVALID',
              'GPS_NOT_ENABLED',
              'GPS_METHOD_NOT_ALLOWED',
              'DISTANCE_EXCEEDED'
            )
          ),
        -- A FAILED attempt always carries the server-owned reason; a
        -- VERIFIED attempt never does.
        CONSTRAINT handyman_visit_arrivals_failed_reason_required_check
          CHECK (
            (verification_result = 'FAILED' AND failure_reason IS NOT NULL)
            OR (verification_result = 'VERIFIED' AND failure_reason IS NULL)
          ),
        -- GPS claims store the raw evidence exactly as submitted (finite
        -- values); accuracy, when captured, is a positive distance.
        CONSTRAINT handyman_visit_arrivals_accuracy_check
          CHECK (accuracy_meters IS NULL OR accuracy_meters > 0),
        CONSTRAINT handyman_visit_arrivals_distance_check
          CHECK (distance_meters IS NULL OR distance_meters >= 0),
        -- ASSISTED is a provenance-bearing override: always VERIFIED, real
        -- recorder, mandatory non-empty reason, and NEVER fabricated
        -- coordinates/accuracy/distance/policy provenance.
        CONSTRAINT handyman_visit_arrivals_assisted_shape_check
          CHECK (
            verification_method <> 'ASSISTED'
            OR (
              verification_result = 'VERIFIED'
              AND assisted_reason IS NOT NULL AND btrim(assisted_reason) <> ''
              AND latitude IS NULL AND longitude IS NULL
              AND accuracy_meters IS NULL AND distance_meters IS NULL
              AND building_configuration_id IS NULL
              AND configuration_version_id IS NULL
            )
          ),
        -- GPS attempts never carry an assisted reason; a VERIFIED GPS
        -- decision always pins the exact policy provenance it used plus
        -- the finite claimed coordinates and the computed distance.
        CONSTRAINT handyman_visit_arrivals_gps_shape_check
          CHECK (
            verification_method <> 'GPS'
            OR (
              assisted_reason IS NULL
              AND (
                verification_result <> 'VERIFIED'
                OR (
                  latitude IS NOT NULL AND longitude IS NOT NULL
                  AND distance_meters IS NOT NULL
                  AND building_configuration_id IS NOT NULL
                  AND configuration_version_id IS NOT NULL
                )
              )
            )
          ),
        -- Client-scoped idempotency (the CR-HM-BE-01 convention): one
        -- client's key can never collide with another client's key.
        CONSTRAINT handyman_visit_arrivals_client_idempotency_unique
          UNIQUE (client_id, idempotency_key)
      )
    `);
    // At most ONE VERIFIED arrival per visit; FAILED attempts accumulate as
    // append-only history (the partial-unique idiom).
    await client.query(`
      CREATE UNIQUE INDEX handyman_visit_arrivals_one_verified_per_visit
        ON handyman_visit_arrivals (handyman_service_visit_id)
        WHERE verification_result = 'VERIFIED'
    `);
    await client.query(
      `CREATE INDEX handyman_visit_arrivals_visit_idx
         ON handyman_visit_arrivals (handyman_service_visit_id, created_at ASC)`,
    );
    await client.query(
      `CREATE INDEX handyman_visit_arrivals_client_idx
         ON handyman_visit_arrivals (client_id, created_at DESC)`,
    );

    await client.query(`
      CREATE TABLE handyman_visit_presence (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL,
        handyman_service_visit_id   UUID NOT NULL,
        handyman_visit_arrival_id   UUID NOT NULL,
        handyman_job_assignment_id  UUID NOT NULL,
        handyman_work_crew_id       UUID NOT NULL,
        vendor_workforce_binding_id UUID NOT NULL,
        crew_role                   TEXT NOT NULL,
        presence_status             TEXT NOT NULL DEFAULT 'PENDING',
        recorded_via                TEXT,
        recorded_by_user_id         UUID,
        recorded_at                 TIMESTAMPTZ,
        assisted_reason             TEXT,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_visit_presence_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT handyman_visit_presence_visit_id_fkey
          FOREIGN KEY (handyman_service_visit_id)
          REFERENCES handyman_service_visits (id),
        CONSTRAINT handyman_visit_presence_arrival_id_fkey
          FOREIGN KEY (handyman_visit_arrival_id)
          REFERENCES handyman_visit_arrivals (id),
        CONSTRAINT handyman_visit_presence_job_assignment_id_fkey
          FOREIGN KEY (handyman_job_assignment_id)
          REFERENCES handyman_job_assignments (id),
        CONSTRAINT handyman_visit_presence_crew_id_fkey
          FOREIGN KEY (handyman_work_crew_id)
          REFERENCES handyman_work_crews (id),
        CONSTRAINT handyman_visit_presence_binding_id_fkey
          FOREIGN KEY (vendor_workforce_binding_id)
          REFERENCES vendor_workforce_bindings (id),
        CONSTRAINT handyman_visit_presence_recorded_by_user_id_fkey
          FOREIGN KEY (recorded_by_user_id) REFERENCES users (id),
        CONSTRAINT handyman_visit_presence_role_check
          CHECK (crew_role IN ('LEAD_WORKER', 'HELPER')),
        CONSTRAINT handyman_visit_presence_status_check
          CHECK (presence_status IN ('PENDING', 'PRESENT', 'ABSENT')),
        CONSTRAINT handyman_visit_presence_recorded_via_check
          CHECK (recorded_via IS NULL OR recorded_via IN ('LEAD', 'STAFF_ASSISTED')),
        -- Snapshot rows start PENDING with no attribution; a recorded mark
        -- is fully attributed (recorder, time, path) — and the assisted
        -- path always carries its mandatory non-empty reason while the
        -- lead field path never does.
        CONSTRAINT handyman_visit_presence_pending_state_check
          CHECK (
            presence_status <> 'PENDING'
            OR (
              recorded_via IS NULL AND recorded_by_user_id IS NULL
              AND recorded_at IS NULL AND assisted_reason IS NULL
            )
          ),
        CONSTRAINT handyman_visit_presence_recorded_state_check
          CHECK (
            presence_status = 'PENDING'
            OR (
              recorded_via IS NOT NULL AND recorded_by_user_id IS NOT NULL
              AND recorded_at IS NOT NULL
            )
          ),
        CONSTRAINT handyman_visit_presence_assisted_reason_check
          CHECK (
            recorded_via IS DISTINCT FROM 'STAFF_ASSISTED'
            OR (assisted_reason IS NOT NULL AND btrim(assisted_reason) <> '')
          ),
        CONSTRAINT handyman_visit_presence_lead_reason_check
          CHECK (recorded_via IS DISTINCT FROM 'LEAD' OR assisted_reason IS NULL),
        -- One snapshot member per visit + binding: arbitrary worker ids
        -- cannot be added and a member can never be double-seated.
        CONSTRAINT handyman_visit_presence_visit_binding_unique
          UNIQUE (handyman_service_visit_id, vendor_workforce_binding_id)
      )
    `);
    // The snapshot inherits the composition's exactly-one-ACTIVE-lead
    // guarantee (CR-HM-BE-04 partial unique) as a structural backstop, so
    // the Run-2 execution-start presence rule can rely on ONE lead row.
    await client.query(`
      CREATE UNIQUE INDEX handyman_visit_presence_one_lead_per_visit
        ON handyman_visit_presence (handyman_service_visit_id)
        WHERE crew_role = 'LEAD_WORKER'
    `);
    await client.query(
      `CREATE INDEX handyman_visit_presence_visit_idx
         ON handyman_visit_presence (handyman_service_visit_id)`,
    );
    await client.query(
      `CREATE INDEX handyman_visit_presence_client_idx
         ON handyman_visit_presence (client_id, created_at DESC)`,
    );

    // Bootstrap permissions (the 0353/0354/0355 pattern).
    const perms: [string, string][] = [
      ['handyman_work_execution.read', 'Read Handyman Work Execution'],
      ['handyman_work_execution.manage', 'Manage Handyman Work Execution'],
    ];

    for (const [code, name] of perms) {
      await client.query(
        `INSERT INTO permissions (id, code, name, status)
         VALUES ($1, $2, $3, 'ACTIVE')
         ON CONFLICT (code) DO NOTHING`,
        [randomUUID(), code, name],
      );
    }

    const roleResult = await client.query<{ id: string }>(
      `SELECT id FROM roles WHERE code = 'PLATFORM_ADMIN'`,
    );
    const roleId = roleResult.rows[0]?.id;
    if (roleId) {
      for (const [code] of perms) {
        const permResult = await client.query<{ id: string }>(
          `SELECT id FROM permissions WHERE code = $1`,
          [code],
        );
        const permId = permResult.rows[0]?.id;
        if (permId) {
          await client.query(
            `INSERT INTO role_permission_assignments (id, role_id, permission_id, status)
             SELECT $1, $2, $3, 'ACTIVE'
             WHERE NOT EXISTS (
               SELECT 1 FROM role_permission_assignments
               WHERE role_id = $2 AND permission_id = $3 AND status = 'ACTIVE'
             )`,
            [randomUUID(), roleId, permId],
          );
        }
      }
    }
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_visit_presence');
    await client.query('DROP TABLE IF EXISTS handyman_visit_arrivals');
    // Note: permissions and role assignments are preserved on downgrade per
    // Asentra migration convention.
  },
};
