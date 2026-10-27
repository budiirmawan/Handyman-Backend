import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Commercial disclosure is separate from Finance tax classification. No
 * existing offer or customer decision is updated or assigned a price basis. */
export const migration0519HandymanQuotationPriceBasis: Migration = {
  id: '0519_handyman_quotation_price_basis',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_quotation_line_price_bases (
        quotation_line_id UUID PRIMARY KEY REFERENCES handyman_quotation_lines(id),
        quotation_version_id UUID NOT NULL REFERENCES handyman_quotation_versions(id),
        tax_price_basis TEXT NOT NULL CHECK (tax_price_basis IN ('GROSS_INCLUSIVE','TAX_EXCLUSIVE')),
        authored_by_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX hm_quote_price_basis_version_idx ON handyman_quotation_line_price_bases(quotation_version_id);
      CREATE FUNCTION hm_quote_price_basis_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE line_id UUID; version_id UUID; state TEXT;
      BEGIN
        line_id := CASE WHEN TG_OP='DELETE' THEN OLD.quotation_line_id ELSE NEW.quotation_line_id END;
        version_id := CASE WHEN TG_OP='DELETE' THEN OLD.quotation_version_id ELSE NEW.quotation_version_id END;
        IF TG_OP='UPDATE' AND (NEW.quotation_line_id IS DISTINCT FROM OLD.quotation_line_id OR
          NEW.quotation_version_id IS DISTINCT FROM OLD.quotation_version_id OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
          RAISE EXCEPTION 'Quotation line price-basis identity cannot change.' USING ERRCODE='23514';
        END IF;
        SELECT v.status INTO state FROM handyman_quotation_versions v
          JOIN handyman_quotation_lines l ON l.quotation_version_id=v.id
          WHERE v.id=version_id AND l.id=line_id FOR UPDATE OF v;
        IF state IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION 'Price basis may only be authored for an exact DRAFT quotation line.' USING ERRCODE='23514';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_quote_price_basis_draft_only BEFORE INSERT OR UPDATE OR DELETE
        ON handyman_quotation_line_price_bases FOR EACH ROW EXECUTE FUNCTION hm_quote_price_basis_draft_only();
      CREATE FUNCTION hm_quote_price_basis_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_quotation_line_price_bases) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Quotation line price bases cannot be truncated.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_quote_price_basis_no_truncate BEFORE TRUNCATE ON handyman_quotation_line_price_bases
        FOR EACH STATEMENT EXECUTE FUNCTION hm_quote_price_basis_no_truncate();

      CREATE FUNCTION hm_quote_issue_price_basis_required() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status='DRAFT' AND NEW.status='ISSUED' AND EXISTS (
          SELECT 1 FROM handyman_quotation_lines l LEFT JOIN handyman_quotation_line_price_bases b
            ON b.quotation_line_id=l.id AND b.quotation_version_id=l.quotation_version_id
          WHERE l.quotation_version_id=NEW.id AND b.quotation_line_id IS NULL
        ) THEN RAISE EXCEPTION 'Every issued quotation line requires an explicit commercial tax price basis.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_quote_issue_price_basis_required BEFORE UPDATE ON handyman_quotation_versions
        FOR EACH ROW EXECUTE FUNCTION hm_quote_issue_price_basis_required();

      -- Only new documents are subject to this rule. All line amounts and the
      -- separately authored basis must be present in the frozen issued source.
      CREATE FUNCTION hm_quote_document_price_basis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source_snapshot->>'priceBasisProtocol' IS DISTINCT FROM 'HANDYMAN_QUOTATION_LINE_PRICE_BASIS_V1' OR
          jsonb_typeof(NEW.source_snapshot->'lines') IS DISTINCT FROM 'array' OR
          (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(NEW.source_snapshot->'lines') x)
            <> jsonb_array_length(NEW.source_snapshot->'lines') OR EXISTS (
          SELECT 1 FROM handyman_quotation_lines l
          LEFT JOIN handyman_quotation_line_price_bases b ON b.quotation_line_id=l.id AND b.quotation_version_id=l.quotation_version_id
          LEFT JOIN units_of_measure u ON u.id=l.uom_id AND u.client_id=NEW.client_id
          WHERE l.quotation_version_id=NEW.quotation_version_id AND (b.quotation_line_id IS NULL OR u.id IS NULL OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot->'lines') x
            WHERE x->>'id'=l.id::text AND x->>'lineType'=l.line_type AND x->>'description'=l.description
              AND (x->>'quantity')::numeric=l.quantity AND x->>'uomId'=l.uom_id::text AND x->>'unit'=u.symbol
              AND (x->>'unitAmount')::numeric=l.final_quoted_unit_amount AND (x->>'total')::numeric=l.line_total
              AND x->>'currency'=l.currency AND x->>'taxPriceBasis'=b.tax_price_basis
          ))
        ) THEN RAISE EXCEPTION 'Issued quotation source must freeze each exact line and its authored price basis.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_quote_document_price_basis_guard BEFORE INSERT ON handyman_quotation_documents
        FOR EACH ROW EXECUTE FUNCTION hm_quote_document_price_basis_guard();

      ALTER TABLE handyman_quotation_decisions
        ADD COLUMN offer_document_id UUID REFERENCES handyman_quotation_documents(id),
        ADD COLUMN offer_source_sha256 TEXT,
        ADD COLUMN offer_pdf_sha256 TEXT,
        ADD CONSTRAINT hm_quote_decision_offer_all_or_none CHECK (
          (offer_document_id IS NULL AND offer_source_sha256 IS NULL AND offer_pdf_sha256 IS NULL) OR
          (offer_document_id IS NOT NULL AND offer_source_sha256 IS NOT NULL AND offer_pdf_sha256 IS NOT NULL AND
           offer_source_sha256 ~ '^[0-9a-f]{64}$' AND offer_pdf_sha256 ~ '^[0-9a-f]{64}$'));
      CREATE FUNCTION hm_quote_decision_price_basis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE doc RECORD;
      BEGIN
        SELECT * INTO doc FROM handyman_quotation_documents WHERE quotation_version_id=NEW.quotation_version_id;
        IF doc.source_snapshot->>'priceBasisProtocol'='HANDYMAN_QUOTATION_LINE_PRICE_BASIS_V1' THEN
          IF NEW.offer_document_id IS DISTINCT FROM doc.id OR NEW.offer_source_sha256 IS DISTINCT FROM doc.source_sha256 OR
             NEW.offer_pdf_sha256 IS DISTINCT FROM doc.pdf_sha256 OR NEW.client_id IS DISTINCT FROM doc.client_id OR
             NEW.quotation_id IS DISTINCT FROM doc.quotation_id THEN
            RAISE EXCEPTION 'Customer decision must pin the exact issued quotation document and hashes.' USING ERRCODE='23514';
          END IF;
        ELSIF NEW.offer_document_id IS NOT NULL OR NEW.offer_source_sha256 IS NOT NULL OR NEW.offer_pdf_sha256 IS NOT NULL THEN
          RAISE EXCEPTION 'A historical quotation cannot be retroactively represented as a basis-disclosing offer.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_quote_decision_price_basis_guard BEFORE INSERT ON handyman_quotation_decisions
        FOR EACH ROW EXECUTE FUNCTION hm_quote_decision_price_basis_guard();

      -- A newly offered change must disclose its own exact line basis. A legacy
      -- original can be shown as undisclosed, never retrospectively upgraded.
      CREATE FUNCTION hm_variation_offer_price_basis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE basis TEXT; line_id TEXT; quote JSONB;
      BEGIN
        IF NEW.source_snapshot->>'priceBasisProtocol' IS DISTINCT FROM 'HANDYMAN_VARIATION_LINE_PRICE_BASIS_V1' OR
           NEW.source_snapshot#>>'{revised,priceBasisProtocol}' IS DISTINCT FROM 'HANDYMAN_QUOTATION_LINE_PRICE_BASIS_V1' THEN
          RAISE EXCEPTION 'New variation offers require an explicit revised line price basis.' USING ERRCODE='23514';
        END IF;
        IF NEW.source_snapshot#>>'{variation,variationType}'='REDUCE' THEN
          quote := NEW.source_snapshot->'original'; line_id := NEW.source_snapshot#>>'{variation,targetQuotationLineId}';
          IF quote->>'priceBasisProtocol' IS DISTINCT FROM 'HANDYMAN_QUOTATION_LINE_PRICE_BASIS_V1' OR
             NEW.source_snapshot#>>'{variation,priceBasisLineId}' IS DISTINCT FROM line_id THEN
            RAISE EXCEPTION 'REDUCE price basis must refer to its exact original line.' USING ERRCODE='23514';
          END IF;
        ELSE
          quote := NEW.source_snapshot->'revised'; line_id := NEW.source_snapshot#>>'{variation,priceBasisLineId}';
          IF (NEW.source_snapshot#>>'{variation,revisedQuotationLineId}' IS NOT NULL AND
              NEW.source_snapshot#>>'{variation,revisedQuotationLineId}' IS DISTINCT FROM line_id) OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(quote->'lines') x WHERE x->>'id'=line_id
              AND x->>'lineType'=NEW.source_snapshot#>>'{variation,lineType}'
              AND x->>'uomId'=NEW.source_snapshot#>>'{variation,uomId}'
              AND (x->>'quantity')::numeric=(NEW.source_snapshot#>>'{variation,quantity}')::numeric
              AND (x->>'unitAmount')::numeric=(NEW.source_snapshot#>>'{variation,quotedUnitAmount}')::numeric
              AND (x->>'total')::numeric=(NEW.source_snapshot#>>'{variation,quotedTotalDelta}')::numeric
              AND x->>'currency'=NEW.source_snapshot#>>'{variation,currency}'
          ) THEN RAISE EXCEPTION 'ADD price basis must refer to its exact quoted line.' USING ERRCODE='23514'; END IF;
        END IF;
        SELECT x->>'taxPriceBasis' INTO basis FROM jsonb_array_elements(quote->'lines') x WHERE x->>'id'=line_id;
        IF basis NOT IN ('GROSS_INCLUSIVE','TAX_EXCLUSIVE') OR basis IS NULL OR
           NEW.source_snapshot#>>'{variation,taxPriceBasis}' IS DISTINCT FROM basis THEN
          RAISE EXCEPTION 'Variation change must disclose the exact affected line price basis.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_variation_offer_price_basis_guard BEFORE INSERT ON handyman_variation_offer_documents
        FOR EACH ROW EXECUTE FUNCTION hm_variation_offer_price_basis_guard();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      LOCK TABLE handyman_quotation_line_price_bases IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_quotation_line_price_bases) OR
           EXISTS (SELECT 1 FROM handyman_quotation_decisions WHERE offer_document_id IS NOT NULL) THEN
          RAISE EXCEPTION 'Cannot remove authored price bases or customer offer bindings.';
        END IF;
      END $$;
      DROP TRIGGER hm_variation_offer_price_basis_guard ON handyman_variation_offer_documents;
      DROP FUNCTION hm_variation_offer_price_basis_guard();
      DROP TRIGGER hm_quote_decision_price_basis_guard ON handyman_quotation_decisions;
      DROP FUNCTION hm_quote_decision_price_basis_guard();
      ALTER TABLE handyman_quotation_decisions DROP CONSTRAINT hm_quote_decision_offer_all_or_none,
        DROP COLUMN offer_document_id, DROP COLUMN offer_source_sha256, DROP COLUMN offer_pdf_sha256;
      DROP TRIGGER hm_quote_document_price_basis_guard ON handyman_quotation_documents;
      DROP FUNCTION hm_quote_document_price_basis_guard();
      DROP TRIGGER hm_quote_issue_price_basis_required ON handyman_quotation_versions;
      DROP FUNCTION hm_quote_issue_price_basis_required();
      DROP TABLE handyman_quotation_line_price_bases;
      DROP FUNCTION hm_quote_price_basis_no_truncate();
      DROP FUNCTION hm_quote_price_basis_draft_only();
    `);
  },
};
