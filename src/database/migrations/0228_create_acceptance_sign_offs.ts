import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-22E — Acceptance / Sign-Off.
 *
 * Sign-Off belongs to valid BAST / Handover context, supports INTERNAL / TENANT / VENDOR,
 * records authorized signer, decision and timestamp, preserves history.
 * Reuses BAST/Handover masters — no separate approval engine.
 */
export const migration0228CreateAcceptanceSignOffs: Migration = {
  id: '0228_create_acceptance_sign_offs',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE acceptance_sign_offs (
        id                  UUID PRIMARY KEY,
        bast_document_id    UUID REFERENCES bast_documents (id) ON DELETE CASCADE,
        handover_document_id UUID REFERENCES handover_documents (id) ON DELETE CASCADE,
        client_id           UUID NOT NULL REFERENCES clients (id),
        building_id         UUID NOT NULL REFERENCES buildings (id),
        context_type        TEXT NOT NULL,
        decision            TEXT NOT NULL,
        signer_user_id      UUID NOT NULL REFERENCES users (id),
        notes               TEXT,
        signed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT acceptance_sign_offs_context_check
          CHECK (context_type IN ('INTERNAL', 'TENANT', 'VENDOR')),
        CONSTRAINT acceptance_sign_offs_decision_check
          CHECK (decision IN ('ACCEPTED', 'REJECTED')),
        CONSTRAINT acceptance_sign_offs_target_check
          CHECK (
            (bast_document_id IS NOT NULL AND handover_document_id IS NULL)
            OR
            (bast_document_id IS NULL AND handover_document_id IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE INDEX acceptance_sign_offs_bast_idx
        ON acceptance_sign_offs (bast_document_id, signed_at DESC);
      CREATE INDEX acceptance_sign_offs_handover_idx
        ON acceptance_sign_offs (handover_document_id, signed_at DESC);
      CREATE INDEX acceptance_sign_offs_building_idx
        ON acceptance_sign_offs (building_id, decision);
      CREATE INDEX acceptance_sign_offs_client_idx
        ON acceptance_sign_offs (client_id, signed_at DESC);
      CREATE INDEX acceptance_sign_offs_context_idx
        ON acceptance_sign_offs (context_type, decision);
      CREATE INDEX acceptance_sign_offs_signer_idx
        ON acceptance_sign_offs (signer_user_id, signed_at DESC);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS acceptance_sign_offs');
  },
};
