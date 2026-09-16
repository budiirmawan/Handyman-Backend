import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-03 RUN 3 — Customer approval authority + secure-link readiness.
 *
 *   SENT quotation (exact sent revision) → PENDING approval
 *     → APPROVED / REJECTED (once-only, guarded, method IN_APP | ASSISTED)
 *     → EXPIRED (withdraw / superseded send — never a decision)
 *
 * Governance decisions encoded here:
 * - An approval belongs to the quotation AND its exact sent revision; the
 *   composite FK into handyman_quotation_revisions (id, quotation_id) makes a
 *   foreign-revision approval structurally impossible, and a partial unique
 *   index enforces at most one PENDING approval per revision.
 * - APPROVED-FOR and RECORDED-BY are preserved SEPARATELY. approved_for_type
 *   (TENANT_COMPANY | TENANT_PIC | CUSTOMER) with an identity snapshot is the
 *   decision party; recorded_by_user_id is the authenticated staff user who
 *   recorded an ASSISTED decision and is NULL for a genuine direct IN_APP
 *   decision by the authorized tenant PIC. Staff never become the customer
 *   merely because they recorded the decision.
 * - SECURE_LINK exists in the method vocabulary ONLY: the decided-state CHECK
 *   admits method IN_APP/ASSISTED exclusively, so a SECURE_LINK decision is
 *   structurally unreachable until a future governed migration deliberately
 *   extends it (public resolve/decide endpoints are an explicit security
 *   follow-up CR, not Run 3).
 * - Secure-link readiness: token_hash is SHA-256 (raw token never stored,
 *   returned once at issuance, no resource identifiers inside), expires_at
 *   required, max_uses fixed at 1, ACTIVE/USED/REVOKED/EXPIRED lifecycle with
 *   state-consistency CHECKs, one ACTIVE link per approval (partial unique),
 *   recipient/contact snapshot on the row (never in operational events).
 * - Additive envelope guard: an APPROVED/REJECTED quotation always retains
 *   its sent binding facts (sent_revision_id + sent_at) as history.
 * - supporting_documents.parent_type is extended for
 *   HANDYMAN_QUOTATION_APPROVAL evidence using the existing document
 *   foundation convention (0315 idiom) — no new document engine, no binary
 *   storage; approval evidence attaches through the existing authority.
 * - No notification, payment, or new customer/tenant engine is created.
 */
export const migration0352CreateHandymanQuotationApprovals: Migration = {
  id: '0352_create_handyman_quotation_approvals',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_quotation_approvals (
        id                  UUID PRIMARY KEY,
        quotation_id        UUID NOT NULL,
        quotation_revision_id UUID NOT NULL,
        client_id           UUID NOT NULL REFERENCES clients (id),
        building_id         UUID NOT NULL REFERENCES buildings (id),
        status              TEXT NOT NULL DEFAULT 'PENDING',
        method              TEXT,
        -- APPROVED FOR — the decision party, preserved separately from the
        -- recorder, with an identity snapshot sufficient for audit.
        approved_for_type   TEXT,
        approved_for_tenant_company_id UUID REFERENCES tenant_companies (id),
        approved_for_tenant_pic_id UUID REFERENCES tenant_pics (id),
        approved_for_name   TEXT,
        approved_for_customer_name TEXT,
        approved_for_customer_phone TEXT,
        approved_for_customer_email TEXT,
        decision_notes      TEXT,
        -- RECORDED BY — authenticated staff user for ASSISTED decisions;
        -- NULL when the authorized tenant PIC decided directly (IN_APP).
        recorded_by_user_id UUID REFERENCES users (id),
        decided_at          TIMESTAMPTZ,
        created_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_quotation_approvals_quotation_scope_fk
          FOREIGN KEY (quotation_id, client_id, building_id)
          REFERENCES handyman_quotations (id, client_id, building_id),
        CONSTRAINT handyman_quotation_approvals_revision_scope_fk
          FOREIGN KEY (quotation_revision_id, quotation_id)
          REFERENCES handyman_quotation_revisions (id, quotation_id),
        CONSTRAINT handyman_quotation_approvals_status_check
          CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
        CONSTRAINT handyman_quotation_approvals_method_check
          CHECK (method IS NULL OR method IN ('IN_APP', 'ASSISTED', 'SECURE_LINK')),
        CONSTRAINT handyman_quotation_approvals_approved_for_type_check
          CHECK (approved_for_type IS NULL OR approved_for_type IN (
            'TENANT_COMPANY', 'TENANT_PIC', 'CUSTOMER'
          )),
        CONSTRAINT handyman_quotation_approvals_pending_state_check
          CHECK (
            status <> 'PENDING'
            OR (method IS NULL AND decided_at IS NULL AND approved_for_type IS NULL
              AND recorded_by_user_id IS NULL AND decision_notes IS NULL)
          ),
        -- Decided states admit IN_APP/ASSISTED ONLY: a SECURE_LINK decision
        -- is structurally unreachable in Run 3.
        CONSTRAINT handyman_quotation_approvals_decided_state_check
          CHECK (
            status NOT IN ('APPROVED', 'REJECTED')
            OR (method IN ('IN_APP', 'ASSISTED') AND decided_at IS NOT NULL
              AND approved_for_type IS NOT NULL)
          ),
        CONSTRAINT handyman_quotation_approvals_expired_state_check
          CHECK (
            status <> 'EXPIRED'
            OR (decided_at IS NOT NULL AND method IS NULL
              AND approved_for_type IS NULL AND recorded_by_user_id IS NULL)
          ),
        CONSTRAINT handyman_quotation_approvals_in_app_shape_check
          CHECK (
            method IS DISTINCT FROM 'IN_APP'
            OR (recorded_by_user_id IS NULL AND approved_for_type = 'TENANT_PIC')
          ),
        CONSTRAINT handyman_quotation_approvals_assisted_shape_check
          CHECK (
            method IS DISTINCT FROM 'ASSISTED'
            OR (recorded_by_user_id IS NOT NULL
              AND decision_notes IS NOT NULL
              AND length(btrim(decision_notes)) BETWEEN 1 AND 2000)
          ),
        CONSTRAINT handyman_quotation_approvals_notes_check
          CHECK (decision_notes IS NULL OR length(btrim(decision_notes)) BETWEEN 1 AND 2000),
        CONSTRAINT handyman_quotation_approvals_for_name_check
          CHECK (approved_for_name IS NULL OR length(btrim(approved_for_name)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_quotation_approvals_for_company_shape_check
          CHECK (
            approved_for_type IS DISTINCT FROM 'TENANT_COMPANY'
            OR approved_for_tenant_company_id IS NOT NULL
          ),
        CONSTRAINT handyman_quotation_approvals_for_pic_shape_check
          CHECK (
            approved_for_type IS DISTINCT FROM 'TENANT_PIC'
            OR approved_for_tenant_pic_id IS NOT NULL
          ),
        CONSTRAINT handyman_quotation_approvals_for_customer_shape_check
          CHECK (
            approved_for_type IS DISTINCT FROM 'CUSTOMER'
            OR (approved_for_customer_name IS NOT NULL
              AND length(btrim(approved_for_customer_name)) BETWEEN 1 AND 200)
          ),
        CONSTRAINT handyman_quotation_approvals_customer_name_check
          CHECK (approved_for_customer_name IS NULL
            OR length(btrim(approved_for_customer_name)) BETWEEN 1 AND 200)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_quotation_approvals_one_pending_per_revision
        ON handyman_quotation_approvals (quotation_revision_id)
        WHERE status = 'PENDING'
    `);
    await client.query(`
      CREATE INDEX handyman_quotation_approvals_quotation_idx
        ON handyman_quotation_approvals (quotation_id, status, created_at DESC);
      CREATE INDEX handyman_quotation_approvals_revision_idx
        ON handyman_quotation_approvals (quotation_revision_id)
    `);

    await client.query(`
      CREATE TABLE handyman_quotation_approval_links (
        id                  UUID PRIMARY KEY,
        approval_id         UUID NOT NULL REFERENCES handyman_quotation_approvals (id),
        quotation_id        UUID NOT NULL,
        client_id           UUID NOT NULL REFERENCES clients (id),
        building_id         UUID NOT NULL REFERENCES buildings (id),
        -- SHA-256 hex of the raw token. The raw token is returned once at
        -- issuance and is never stored; it carries no resource identifiers.
        token_hash          CHAR(64) NOT NULL,
        recipient_name      TEXT NOT NULL,
        recipient_phone     TEXT,
        recipient_email     TEXT,
        status              TEXT NOT NULL DEFAULT 'ACTIVE',
        max_uses            INTEGER NOT NULL,
        uses_count          INTEGER NOT NULL DEFAULT 0,
        expires_at          TIMESTAMPTZ NOT NULL,
        issued_by_user_id   UUID NOT NULL REFERENCES users (id),
        issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        used_at             TIMESTAMPTZ,
        revoked_at          TIMESTAMPTZ,
        revoked_by_user_id  UUID REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_quotation_approval_links_quotation_scope_fk
          FOREIGN KEY (quotation_id, client_id, building_id)
          REFERENCES handyman_quotations (id, client_id, building_id),
        CONSTRAINT handyman_quotation_approval_links_token_hash_check
          CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT handyman_quotation_approval_links_token_hash_unique
          UNIQUE (token_hash),
        CONSTRAINT handyman_quotation_approval_links_recipient_name_check
          CHECK (length(btrim(recipient_name)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_quotation_approval_links_status_check
          CHECK (status IN ('ACTIVE', 'USED', 'REVOKED', 'EXPIRED')),
        -- Single-use governance is fixed structurally.
        CONSTRAINT handyman_quotation_approval_links_max_uses_check
          CHECK (max_uses = 1),
        CONSTRAINT handyman_quotation_approval_links_uses_check
          CHECK (uses_count >= 0 AND uses_count <= max_uses),
        CONSTRAINT handyman_quotation_approval_links_active_state_check
          CHECK (
            status <> 'ACTIVE'
            OR (used_at IS NULL AND revoked_at IS NULL AND revoked_by_user_id IS NULL)
          ),
        CONSTRAINT handyman_quotation_approval_links_used_state_check
          CHECK (
            status <> 'USED'
            OR (used_at IS NOT NULL AND uses_count = max_uses)
          ),
        CONSTRAINT handyman_quotation_approval_links_revoked_state_check
          CHECK (
            status <> 'REVOKED'
            OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
              AND uses_count = 0)
          ),
        CONSTRAINT handyman_quotation_approval_links_expired_state_check
          CHECK (
            status <> 'EXPIRED'
            OR (used_at IS NULL AND uses_count = 0)
          )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_quotation_approval_links_one_active_per_approval
        ON handyman_quotation_approval_links (approval_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE INDEX handyman_quotation_approval_links_approval_idx
        ON handyman_quotation_approval_links (approval_id, status);
      CREATE INDEX handyman_quotation_approval_links_quotation_idx
        ON handyman_quotation_approval_links (quotation_id, status)
    `);

    // Additive envelope guard: decided quotations retain sent binding facts.
    await client.query(`
      ALTER TABLE handyman_quotations
        ADD CONSTRAINT handyman_quotations_decided_state_check
        CHECK (
          status NOT IN ('APPROVED', 'REJECTED')
          OR (sent_revision_id IS NOT NULL AND sent_at IS NOT NULL)
        )
    `);

    // Evidence attachment through the EXISTING document foundation (0315
    // convention) — no new document engine, file-reference only.
    await client.query(`
      ALTER TABLE supporting_documents
        DROP CONSTRAINT supporting_documents_parent_check
    `);
    await client.query(`
      ALTER TABLE supporting_documents
        ADD CONSTRAINT supporting_documents_parent_check
          CHECK (parent_type IN (
            'WORK_COMPLETION', 'BAST', 'HANDOVER', 'SIGN_OFF',
            'TENANT_COMPANY', 'VENDOR', 'DOCUMENT', 'RFQ',
            'QUOTATION_REVISION', 'HANDYMAN_QUOTATION_APPROVAL'
          ))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE supporting_documents
        DROP CONSTRAINT IF EXISTS supporting_documents_parent_check
    `);
    await client.query(`
      ALTER TABLE supporting_documents
        ADD CONSTRAINT supporting_documents_parent_check
          CHECK (parent_type IN (
            'WORK_COMPLETION', 'BAST', 'HANDOVER', 'SIGN_OFF',
            'TENANT_COMPANY', 'VENDOR', 'DOCUMENT', 'RFQ',
            'QUOTATION_REVISION'
          ))
    `);
    await client.query(`
      ALTER TABLE handyman_quotations
        DROP CONSTRAINT IF EXISTS handyman_quotations_decided_state_check
    `);
    await client.query('DROP TABLE IF EXISTS handyman_quotation_approval_links');
    await client.query('DROP TABLE IF EXISTS handyman_quotation_approvals');
  },
};
