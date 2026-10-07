import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-NOTIFY-PROV-01 PART 06 — authoritative User WhatsApp contact + consent.
 *
 * The PART 06 gate decision placed the WhatsApp number and explicit consent
 * on the `users` identity master itself (BE-01A) — the same authority
 * notifications are addressed to and the precedent `users.email` sets. The
 * change is strictly additive: three nullable columns, one CHECK, one partial
 * unique index. Every existing user row stays valid with NULLs (= no
 * WhatsApp contact, no consent → never messaged).
 *
 *   - `whatsapp_phone`        — authoritative E.164 WhatsApp number (strict:
 *                               leading '+', 7–15 digits, no leading zero),
 *   - `whatsapp_opted_in_at`  — instant of the LAST explicit opt-in,
 *   - `whatsapp_opted_out_at` — instant of the LAST explicit opt-out.
 *
 * Consent-active rule (the ONLY condition under which outbound WhatsApp
 * intent resolution returns an address): user ACTIVE, phone present, opted
 * in, and the last opt-in is newer than any opt-out. Numbers are never
 * inferred from tenant/vendor PIC contact data.
 *
 * The partial unique index allows one account per WhatsApp number while
 * leaving consent-less users unconstrained.
 */
export const migration0301AddUserWhatsappContactConsent: Migration = {
  id: '0301_add_user_whatsapp_contact_consent',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE users
        ADD COLUMN whatsapp_phone TEXT,
        ADD COLUMN whatsapp_opted_in_at TIMESTAMPTZ,
        ADD COLUMN whatsapp_opted_out_at TIMESTAMPTZ
    `);

    await client.query(`
      ALTER TABLE users
        ADD CONSTRAINT users_whatsapp_phone_e164_check
          CHECK (whatsapp_phone IS NULL OR whatsapp_phone ~ '^\\+[1-9][0-9]{6,14}$')
    `);

    await client.query(`
      CREATE UNIQUE INDEX users_whatsapp_phone_unique
        ON users (whatsapp_phone)
        WHERE whatsapp_phone IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP INDEX IF EXISTS users_whatsapp_phone_unique');
    await client.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS whatsapp_opted_out_at,
        DROP COLUMN IF EXISTS whatsapp_opted_in_at,
        DROP COLUMN IF EXISTS whatsapp_phone
    `);
  },
};
