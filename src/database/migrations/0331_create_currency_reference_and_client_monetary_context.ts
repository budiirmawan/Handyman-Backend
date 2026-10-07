import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** CR-BE-CUR-01 PART 01: global currency reference and Client monetary context only. */
export const migration0331CreateCurrencyReferenceAndClientMonetaryContext: Migration = {
  id: '0331_create_currency_reference_and_client_monetary_context',
  async up(client: PoolClient): Promise<void> {
    await client.query(`CREATE TABLE currencies (
      code VARCHAR(3) PRIMARY KEY, name TEXT NOT NULL, numeric_code VARCHAR(3),
      decimal_precision SMALLINT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT currencies_code_check CHECK (code ~ '^[A-Z]{3}$'),
      CONSTRAINT currencies_numeric_code_check CHECK (numeric_code IS NULL OR numeric_code ~ '^[0-9]{3}$'),
      CONSTRAINT currencies_decimal_precision_check CHECK (decimal_precision BETWEEN 0 AND 6),
      CONSTRAINT currencies_status_check CHECK (status IN ('ACTIVE','INACTIVE'))
    )`);
    await client.query(`CREATE OR REPLACE FUNCTION prevent_currency_code_change() RETURNS trigger AS $$
      BEGIN IF NEW.code <> OLD.code THEN RAISE EXCEPTION 'currency code is immutable'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await client.query(`CREATE TRIGGER currencies_code_immutable BEFORE UPDATE ON currencies FOR EACH ROW EXECUTE FUNCTION prevent_currency_code_change()`);
    await client.query(`INSERT INTO currencies (code,name,numeric_code,decimal_precision) VALUES
      ('IDR','Indonesian Rupiah','360',0),('USD','US Dollar','840',2),('SGD','Singapore Dollar','702',2),
      ('MYR','Malaysian Ringgit','458',2),('AUD','Australian Dollar','036',2),('EUR','Euro','978',2),
      ('GBP','Pound Sterling','826',2),('JPY','Japanese Yen','392',0),('CNY','Yuan Renminbi','156',2)`);
    await client.query(`CREATE TABLE client_monetary_contexts (
      client_id UUID PRIMARY KEY REFERENCES clients(id), base_currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
      default_transaction_currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE client_allowed_transaction_currencies (
      client_id UUID NOT NULL REFERENCES clients(id), currency_code VARCHAR(3) NOT NULL REFERENCES currencies(code),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (client_id,currency_code)
    )`);
    await client.query(`CREATE OR REPLACE FUNCTION validate_client_monetary_context() RETURNS trigger AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM currencies WHERE code=NEW.base_currency_code AND status='ACTIVE')
          OR NOT EXISTS (SELECT 1 FROM currencies WHERE code=NEW.default_transaction_currency_code AND status='ACTIVE') THEN
          RAISE EXCEPTION 'base and default currencies must be active';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM client_allowed_transaction_currencies WHERE client_id=NEW.client_id AND currency_code=NEW.base_currency_code)
          OR NOT EXISTS (SELECT 1 FROM client_allowed_transaction_currencies WHERE client_id=NEW.client_id AND currency_code=NEW.default_transaction_currency_code) THEN
          RAISE EXCEPTION 'base and default currencies must be allowed';
        END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await client.query(`CREATE CONSTRAINT TRIGGER client_monetary_context_valid AFTER INSERT OR UPDATE ON client_monetary_contexts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_client_monetary_context()`);
    await client.query(`CREATE OR REPLACE FUNCTION validate_client_allowed_currency() RETURNS trigger AS $$
      BEGIN IF NOT EXISTS (SELECT 1 FROM currencies WHERE code=NEW.currency_code AND status='ACTIVE') THEN RAISE EXCEPTION 'allowed currency must be active'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await client.query(`CREATE TRIGGER client_allowed_currency_active BEFORE INSERT OR UPDATE ON client_allowed_transaction_currencies FOR EACH ROW EXECUTE FUNCTION validate_client_allowed_currency()`);
    await client.query(`CREATE INDEX client_allowed_transaction_currencies_currency_idx ON client_allowed_transaction_currencies(currency_code)`);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS client_allowed_transaction_currencies'); await client.query('DROP TABLE IF EXISTS client_monetary_contexts');
    await client.query('DROP TRIGGER IF EXISTS currencies_code_immutable ON currencies'); await client.query('DROP FUNCTION IF EXISTS prevent_currency_code_change()');
    await client.query('DROP FUNCTION IF EXISTS validate_client_monetary_context()'); await client.query('DROP FUNCTION IF EXISTS validate_client_allowed_currency()'); await client.query('DROP TABLE IF EXISTS currencies');
  },
};
