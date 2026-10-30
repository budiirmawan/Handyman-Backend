import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01C — the official Handyman document SETTINGS
 * master (wording, numbering prefix and authorized signatory) for the five
 * customer-facing documents, one effective configuration per provider Client per
 * document kind per language.
 *
 * SAME SCOPE as migrations 0490/0491: the provider `clients` row owns this
 * configuration; it is not Building-Management branding and not tenant data.
 *
 * What this table may hold is deliberately narrow, because settings are the
 * VOICE of a document and never its CONTENT:
 *   - `document_prefix` is the only numbering input a Manager may set. Issued
 *     numbers themselves are produced by the owning module, so no column here
 *     can hold a number, a sequence, an amount or a date;
 *   - terms / payment / warranty / footer / contact columns are wording only;
 *   - `signatory_name` / `signatory_title` are identity metadata about who signs
 *     such documents. There is no signature image, no approval flag and no
 *     decision column, because a setting can never approve or accept anything.
 * The prefix namespace is protected: within one provider a prefix belongs to
 * exactly ONE document kind (a constraint trigger), so QUOTATION and INVOICE can
 * never issue numbers from the same namespace - shared across the two languages
 * of one kind, which is what a bilingual provider wants.
 *
 * Invariants (DB-enforced, mirroring the 0490 conventions):
 *   1. append-only version chain per (client, kind, language): exactly one
 *      ACTIVE row (partial unique index) and one row per
 *      (client, kind, language, version); a change INSERTS version+1 and retires
 *      the previous row ACTIVE -> SUPERSEDED, so the wording a document was
 *      issued under stays re-readable forever;
 *   2. immutability: DELETE is always blocked and UPDATE is allowed only for the
 *      lifecycle projection ACTIVE -> SUPERSEDED with every content column
 *      unchanged;
 *   3. text safety: no control characters (the renderer refuses them, so a
 *      stored setting can never make a future document fail to render), bounded
 *      lengths, blank-only text refused, and the kind/language vocabularies are
 *      the renderer's frozen ones - no parallel enumeration is introduced.
 */
export const migration0492CreateHandymanDocumentIssuerSettings: Migration = {
  id: '0492_create_handyman_document_issuer_settings',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_document_issuer_document_settings (
        id                  UUID PRIMARY KEY,
        client_id           UUID NOT NULL REFERENCES clients (id),
        document_kind       TEXT NOT NULL,
        language            TEXT NOT NULL,
        document_prefix     TEXT NOT NULL,
        terms_lines         TEXT[] NOT NULL DEFAULT '{}',
        payment_note        TEXT,
        warranty_note       TEXT,
        footer_note         TEXT,
        contact_note        TEXT,
        signatory_name      TEXT NOT NULL,
        signatory_title     TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'ACTIVE',
        version             INTEGER NOT NULL,
        effective_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        superseded_at       TIMESTAMPTZ,

        CONSTRAINT handyman_doc_settings_kind_check
          CHECK (
            document_kind IN (
              'QUOTATION', 'BAST', 'INVOICE', 'WARRANTY_CERTIFICATE', 'VARIATION_ORDER'
            )
          ),
        CONSTRAINT handyman_doc_settings_language_check
          CHECK (language IN ('id', 'en')),
        CONSTRAINT handyman_doc_settings_status_check
          CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
        CONSTRAINT handyman_doc_settings_version_check
          CHECK (version >= 1),
        CONSTRAINT handyman_doc_settings_prefix_check
          CHECK (document_prefix ~ '^[A-Z][A-Z0-9-]{0,14}[A-Z0-9]$'),
        CONSTRAINT handyman_doc_settings_terms_check
          CHECK (
            cardinality(terms_lines) BETWEEN 0 AND 60
            AND NOT ('' = ANY (terms_lines))
            AND array_position(terms_lines, NULL) IS NULL
            AND NOT (btrim(array_to_string(terms_lines, '|')) = '')
            AND char_length(array_to_string(terms_lines, '|')) <= 36000
            AND array_to_string(terms_lines, '|') !~ '[[:cntrl:]]'
          ),
        CONSTRAINT handyman_doc_settings_payment_note_check
          CHECK (
            payment_note IS NULL
            OR (
              char_length(btrim(payment_note)) BETWEEN 1 AND 600
              AND payment_note !~ '[[:cntrl:]]'
            )
          ),
        CONSTRAINT handyman_doc_settings_warranty_note_check
          CHECK (
            warranty_note IS NULL
            OR (
              char_length(btrim(warranty_note)) BETWEEN 1 AND 600
              AND warranty_note !~ '[[:cntrl:]]'
            )
          ),
        CONSTRAINT handyman_doc_settings_footer_note_check
          CHECK (
            footer_note IS NULL
            OR (
              char_length(btrim(footer_note)) BETWEEN 1 AND 600
              AND footer_note !~ '[[:cntrl:]]'
            )
          ),
        CONSTRAINT handyman_doc_settings_contact_note_check
          CHECK (
            contact_note IS NULL
            OR (
              char_length(btrim(contact_note)) BETWEEN 1 AND 600
              AND contact_note !~ '[[:cntrl:]]'
            )
          ),
        CONSTRAINT handyman_doc_settings_signatory_name_check
          CHECK (
            char_length(btrim(signatory_name)) BETWEEN 2 AND 120
            AND signatory_name !~ '[[:cntrl:]]'
          ),
        CONSTRAINT handyman_doc_settings_signatory_title_check
          CHECK (
            char_length(btrim(signatory_title)) BETWEEN 2 AND 120
            AND signatory_title !~ '[[:cntrl:]]'
          )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_doc_settings_one_active_idx
        ON handyman_document_issuer_document_settings (client_id, document_kind, language)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_doc_settings_version_idx
        ON handyman_document_issuer_document_settings
        (client_id, document_kind, language, version)
    `);
    await client.query(`
      CREATE INDEX handyman_doc_settings_history_idx
        ON handyman_document_issuer_document_settings
        (client_id, document_kind, language, created_at DESC, id)
    `);
    // The prefix namespace rule. Provider writers are already serialized on the
    // `clients` row by the service, so the row lock taken here is enough to make
    // the rule hold for every path that writes the table, SQL included. The
    // 23P01 (exclusion-violation) SQLSTATE is what lets the API answer with the
    // governed 409 prefix conflict instead of a 500, while still refusing the
    // write when it comes from anywhere else.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_doc_settings_reserve_prefix()
      RETURNS trigger AS $$
      DECLARE
        conflicting TEXT;
      BEGIN
        IF NEW.status <> 'ACTIVE' THEN
          RETURN NEW;
        END IF;
        SELECT other.document_kind INTO conflicting
          FROM handyman_document_issuer_document_settings other
         WHERE other.client_id = NEW.client_id
           AND other.document_prefix = NEW.document_prefix
           AND other.document_kind <> NEW.document_kind
           AND other.status = 'ACTIVE'
           AND other.id IS DISTINCT FROM NEW.id
         FOR UPDATE
         LIMIT 1;
        IF conflicting IS NOT NULL THEN
          RAISE EXCEPTION
            'Document prefix % is already the numbering namespace of % for this provider',
            NEW.document_prefix, conflicting
            USING ERRCODE = '23P01';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_doc_settings_prefix_namespace
        BEFORE INSERT OR UPDATE
        ON handyman_document_issuer_document_settings
        FOR EACH ROW
        EXECUTE FUNCTION handyman_doc_settings_reserve_prefix();
    `);
    // Invariants 1 + 2: the version chain is append-only and only the lifecycle
    // projection ACTIVE -> SUPERSEDED may write, never a content column.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_doc_settings_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman document settings are history-preserving: rows cannot be deleted.';
        END IF;
        IF OLD.status = 'ACTIVE' AND NEW.status = 'SUPERSEDED'
           AND NEW.id = OLD.id
           AND NEW.client_id = OLD.client_id
           AND NEW.document_kind = OLD.document_kind
           AND NEW.language = OLD.language
           AND NEW.document_prefix = OLD.document_prefix
           AND NEW.terms_lines = OLD.terms_lines
           AND NEW.payment_note IS NOT DISTINCT FROM OLD.payment_note
           AND NEW.warranty_note IS NOT DISTINCT FROM OLD.warranty_note
           AND NEW.footer_note IS NOT DISTINCT FROM OLD.footer_note
           AND NEW.contact_note IS NOT DISTINCT FROM OLD.contact_note
           AND NEW.signatory_name = OLD.signatory_name
           AND NEW.signatory_title = OLD.signatory_title
           AND NEW.version = OLD.version
           AND NEW.effective_from = OLD.effective_from
           AND NEW.created_by_user_id = OLD.created_by_user_id
           AND NEW.created_at = OLD.created_at THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION
          'Handyman document settings columns are immutable history: only ACTIVE -> SUPERSEDED is permitted (a change inserts a new version row).';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_doc_settings_no_write
        BEFORE UPDATE OR DELETE
        ON handyman_document_issuer_document_settings
        FOR EACH ROW
        EXECUTE FUNCTION handyman_doc_settings_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_doc_settings_no_write
        ON handyman_document_issuer_document_settings;
      DROP TRIGGER IF EXISTS handyman_doc_settings_prefix_namespace
        ON handyman_document_issuer_document_settings;
      DROP FUNCTION IF EXISTS handyman_doc_settings_block_mutation;
      DROP FUNCTION IF EXISTS handyman_doc_settings_reserve_prefix;
      DROP TABLE IF EXISTS handyman_document_issuer_document_settings;
    `);
  },
};
