import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-26I — Notification escalation foundation.
 *
 * An escalation is a time-deferred (or immediate) notification trigger that
 * fires when the CURRENT recipient has not resolved a source resource by
 * `escalation_at`. At that time the escalation renders its template and
 * triggers notification delivery to the ESCALATION recipients. It triggers
 * delivery ONLY — the source domain remains authoritative, no workflow/
 * approval engine is created, and no business-resource state is altered.
 *
 *   - `key`                       — stable, unique escalation reference,
 *   - `source_entity_type` / `source_entity_id` — the source/resource,
 *   - `current_recipient_user_id` — the current (pre-escalation) recipient,
 *   - `escalation_rule`           — the BE-26C escalation recipient rule,
 *   - `template_key`              — the BE-26B template rendered at trigger,
 *   - `escalation_at`             — when the escalation becomes due,
 *   - `triggered_at`              — when the escalation actually fired,
 *   - `status`                    — PENDING / TRIGGERED / CANCELLED,
 *   - `reason`                    — escalation reason/notes.
 *
 * No scheduler engine is created: the service exposes `findDueEscalations` /
 * `triggerDueEscalations` seams that an external scheduler/worker (future
 * part) can invoke.
 */
export const migration0244CreateNotificationEscalations: Migration = {
  id: '0244_create_notification_escalations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE notification_escalations (
        id                        UUID PRIMARY KEY,
        key                       TEXT NOT NULL,
        client_id                 UUID NOT NULL REFERENCES clients (id),
        source_entity_type        TEXT NOT NULL,
        source_entity_id          UUID NOT NULL,
        current_recipient_user_id UUID REFERENCES users (id),
        escalation_rule           JSONB NOT NULL DEFAULT '{}'::jsonb,
        template_key              TEXT NOT NULL REFERENCES notification_templates (key),
        escalation_at             TIMESTAMPTZ NOT NULL,
        triggered_at              TIMESTAMPTZ,
        status                    TEXT NOT NULL DEFAULT 'PENDING',
        reason                    TEXT,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT notification_escalations_key_unique UNIQUE (key),
        CONSTRAINT notification_escalations_status_check
          CHECK (status IN ('PENDING', 'TRIGGERED', 'CANCELLED'))
      )
    `);

    await client.query(`
      CREATE INDEX notification_escalations_due_idx
        ON notification_escalations (status, escalation_at);
      CREATE INDEX notification_escalations_client_idx
        ON notification_escalations (client_id, created_at DESC);
      CREATE INDEX notification_escalations_source_idx
        ON notification_escalations (source_entity_type, source_entity_id, status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS notification_escalations');
  },
};
