import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01A — the official Handyman document ISSUER
 * company profile (master data for Quotation / BAST / Invoice / Warranty
 * Certificate / Scope Variation documents).
 *
 * SCOPE DECISION (frozen by the CR): the issuer is the HANDYMAN SERVICE
 * PROVIDER organisation, i.e. the `clients` row that operates Handyman. This
 * is deliberately NOT Client/Building-Management branding and NOT tenant
 * (customer) data: `handyman_document_issuer_profiles` is one profile per
 * provider Client, never per Building and never per tenant company. Existing
 * `branding` (CLIENT|BUILDING login/portal/report cosmetics) is untouched and
 * is never the document authority, and no second logo/branding engine exists.
 *
 * Invariants (DB-enforced):
 *   1. history-preserving version chain: exactly one ACTIVE profile per
 *      provider Client (partial unique index) and one row per
 *      (client, version); a change INSERTS version+1 and retires the previous
 *      row ACTIVE -> SUPERSEDED, so an already-issued document's issuer
 *      identity can always be re-read exactly as it was;
 *   2. immutability: DELETE is always blocked; UPDATE is allowed ONLY for the
 *      lifecycle projection ACTIVE -> SUPERSEDED with every content column
 *      unchanged. Historical issuer identity therefore cannot be rewritten by
 *      any later profile change (no UPDATE-in-place of a superseded row);
 *   3. structural field bounds only (lengths, email shape, phone shape, http(s)
 *      website, managed-reference-shaped logo_reference). No business default is
 *      invented: every optional identity element stays NULL when unknown, and
 *      format acceptance (NPWP/NIB digit grouping, phone plausibility) is the
 *      service's responsibility;
 *   4. the logo is a REFERENCE only: no binary, no upload and no storage key
 *      materialisation belong to this table.
 */
export const migration0490CreateHandymanDocumentIssuerProfiles: Migration = {
  id: '0490_create_handyman_document_issuer_profiles',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_document_issuer_profiles (
        id                        UUID PRIMARY KEY,
        client_id                 UUID NOT NULL REFERENCES clients (id),
        legal_name                TEXT NOT NULL,
        display_name              TEXT NOT NULL,
        registered_address        TEXT NOT NULL,
        business_address          TEXT,
        city                      TEXT NOT NULL,
        province                  TEXT NOT NULL,
        postal_code               TEXT NOT NULL,
        email                     TEXT NOT NULL,
        phone                     TEXT NOT NULL,
        whatsapp                  TEXT NOT NULL,
        website                   TEXT,
        tax_id                    TEXT,
        business_registration_id  TEXT,
        logo_reference            TEXT,
        status                    TEXT NOT NULL DEFAULT 'ACTIVE',
        version                   INTEGER NOT NULL,
        effective_from            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by_user_id        UUID NOT NULL REFERENCES users (id),
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        superseded_at             TIMESTAMPTZ,

        CONSTRAINT handyman_doc_issuer_profile_status_check
          CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
        CONSTRAINT handyman_doc_issuer_profile_version_check
          CHECK (version >= 1),
        CONSTRAINT handyman_doc_issuer_profile_legal_name_check
          CHECK (char_length(btrim(legal_name)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_doc_issuer_profile_display_name_check
          CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_doc_issuer_profile_registered_address_check
          CHECK (char_length(btrim(registered_address)) BETWEEN 1 AND 500),
        CONSTRAINT handyman_doc_issuer_profile_business_address_check
          CHECK (
            business_address IS NULL
            OR char_length(btrim(business_address)) BETWEEN 1 AND 500
          ),
        CONSTRAINT handyman_doc_issuer_profile_city_check
          CHECK (char_length(btrim(city)) BETWEEN 1 AND 120),
        CONSTRAINT handyman_doc_issuer_profile_province_check
          CHECK (char_length(btrim(province)) BETWEEN 1 AND 120),
        CONSTRAINT handyman_doc_issuer_profile_postal_code_check
          CHECK (postal_code ~ '^[0-9A-Za-z -]{3,20}$'),
        CONSTRAINT handyman_doc_issuer_profile_email_check
          CHECK (
            char_length(email) BETWEEN 3 AND 254
            AND email LIKE '%_@_%._%'
            AND position(' ' in email) = 0
          ),
        CONSTRAINT handyman_doc_issuer_profile_phone_check
          CHECK (phone ~ '^[0-9+][0-9 ()/ .-]{3,38}$'),
        CONSTRAINT handyman_doc_issuer_profile_whatsapp_check
          CHECK (whatsapp ~ '^[0-9+][0-9 ()/ .-]{3,38}$'),
        CONSTRAINT handyman_doc_issuer_profile_website_check
          CHECK (
            website IS NULL
            OR (
              char_length(website) BETWEEN 8 AND 300
              AND website ~ '^https?://'
              AND website !~ '[[:space:]]'
            )
          ),
        CONSTRAINT handyman_doc_issuer_profile_tax_id_check
          CHECK (
            tax_id IS NULL
            OR tax_id ~ '^[0-9][0-9 ./-]{6,38}$'
          ),
        CONSTRAINT handyman_doc_issuer_profile_nib_check
          CHECK (
            business_registration_id IS NULL
            OR business_registration_id ~ '^[0-9A-Z][0-9A-Z ./-]{4,38}$'
          ),
        CONSTRAINT handyman_doc_issuer_profile_logo_reference_check
          CHECK (
            logo_reference IS NULL
            OR (
              char_length(logo_reference) BETWEEN 1 AND 500
              AND logo_reference ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
              AND logo_reference NOT LIKE '%..%'
            )
          )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_doc_issuer_profile_one_active_idx
        ON handyman_document_issuer_profiles (client_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_doc_issuer_profile_version_idx
        ON handyman_document_issuer_profiles (client_id, version)
    `);
    await client.query(`
      CREATE INDEX handyman_doc_issuer_profile_history_idx
        ON handyman_document_issuer_profiles (client_id, created_at DESC, id)
    `);
    // Invariant 2: the version chain is append-only. Only the lifecycle
    // projection ACTIVE -> SUPERSEDED may write, and never a content column.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_doc_issuer_profile_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman document issuer profiles are history-preserving: rows cannot be deleted.';
        END IF;
        IF OLD.status = 'ACTIVE' AND NEW.status = 'SUPERSEDED'
           AND NEW.id = OLD.id
           AND NEW.client_id = OLD.client_id
           AND NEW.legal_name = OLD.legal_name
           AND NEW.display_name = OLD.display_name
           AND NEW.registered_address = OLD.registered_address
           AND NEW.business_address IS NOT DISTINCT FROM OLD.business_address
           AND NEW.city = OLD.city
           AND NEW.province = OLD.province
           AND NEW.postal_code = OLD.postal_code
           AND NEW.email = OLD.email
           AND NEW.phone = OLD.phone
           AND NEW.whatsapp = OLD.whatsapp
           AND NEW.website IS NOT DISTINCT FROM OLD.website
           AND NEW.tax_id IS NOT DISTINCT FROM OLD.tax_id
           AND NEW.business_registration_id
             IS NOT DISTINCT FROM OLD.business_registration_id
           AND NEW.logo_reference IS NOT DISTINCT FROM OLD.logo_reference
           AND NEW.version = OLD.version
           AND NEW.effective_from = OLD.effective_from
           AND NEW.created_by_user_id = OLD.created_by_user_id
           AND NEW.created_at = OLD.created_at THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION
          'Handyman document issuer profile columns are immutable history: only ACTIVE -> SUPERSEDED is permitted (a change inserts a new version row).';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_doc_issuer_profile_no_write
        BEFORE UPDATE OR DELETE
        ON handyman_document_issuer_profiles
        FOR EACH ROW
        EXECUTE FUNCTION handyman_doc_issuer_profile_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_doc_issuer_profile_no_write
        ON handyman_document_issuer_profiles;
      DROP FUNCTION IF EXISTS
        handyman_doc_issuer_profile_block_mutation;
      DROP TABLE IF EXISTS handyman_document_issuer_profiles;
    `);
  },
};
