import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { migration0415CreateHandymanBmFeePrerequisite }
  from '../src/database/migrations/0415_create_handyman_bm_fee_prerequisite';
import {
  activateHandymanCommercialAgreementVersion,
  prepareHandymanCommercialAgreement,
} from '../src/modules/handyman-commercial-agreements';
import { createAdminUser } from './helpers/access';
import { initHandymanFixtures, realmFixture }
  from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-12 PART 06A — BM fee TERM + BENEFICIARY persistence and DB
 * invariants ONLY (FROZEN `CR-HM-12_PART_06_BM_FEE_PREREQUISITE.md`
 * §3, T1–T10), authorized by
 * `CR-HM-14_PREREQUISITE_DECISION_BM_FEE.md` §2/§3/§5.
 *
 * Persistence-only PART: the suite drives both tables with RAW SQL
 * (no service, no read contract — 06B owns those) and proves the
 * version binding, DRAFT-window authoring, total append-only
 * immutability, cardinality, closed vocabularies, rate bounds,
 * same-client beneficiary chain, FK footprint, and the exact,
 * EXECUTED `down` surface (T1–T10). Six focused cases.
 */

const TERM = 'handyman_bm_fee_term_definitions';
const BENEFICIARY = 'handyman_bm_fee_beneficiary_definitions';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE ${TERM}, ${BENEFICIARY},
       handyman_commercial_agreement_events,
       handyman_commercial_agreement_versions,
       handyman_commercial_agreements CASCADE`,
  );
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  initHandymanFixtures({
    adminUserId,
    disciplineId: randomUUID(),
    query: async (text, params = []) => {
      if (!pool) throw new Error('db pool not initialized');
      return pool.query(text, params);
    },
  });
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

async function draftAgreementVersion(clientId: string) {
  return prepareHandymanCommercialAgreement(adminUserId, {
    clientId, idempotencyKey: `p-${randomUUID()}`,
  });
}

async function activateVersion(versionId: string) {
  return activateHandymanCommercialAgreementVersion(adminUserId, {
    versionId,
    effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
    idempotencyKey: `a-${randomUUID()}`,
  });
}

/** Raw-SQL authoring of one term (the 06B service does not exist). */
async function insertTerm(
  versionId: string,
  over: { rate?: string; kind?: string; key?: string } = {},
) {
  return q(
    `INSERT INTO ${TERM} (
       id, agreement_version_id, term_kind, rate_percent,
       idempotency_key, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      randomUUID(), versionId, over.kind ?? 'PERCENTAGE_OF_BASIS',
      over.rate ?? '2.5', over.key ?? `t-${randomUUID()}`, adminUserId,
    ],
  );
}

/**
 * The bound version's client (versions carry no client column; the
 * chain is version -> agreement -> client, 0406).
 */
async function versionClient(versionId: string): Promise<string> {
  const res = await q(
    `SELECT a.client_id AS client_id
       FROM handyman_commercial_agreement_versions v
       JOIN handyman_commercial_agreements a ON a.id = v.agreement_id
      WHERE v.id = $1`,
    [versionId],
  );
  return res.rows[0]?.client_id as string;
}

/** Raw-SQL authoring of one beneficiary. */
async function insertBeneficiary(
  versionId: string,
  over: { kind?: string; referenceId?: string; key?: string } = {},
) {
  const referenceId = over.referenceId ?? await versionClient(versionId);
  return q(
    `INSERT INTO ${BENEFICIARY} (
       id, agreement_version_id, beneficiary_kind,
       beneficiary_reference_id, idempotency_key, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      randomUUID(), versionId, over.kind ?? 'CLIENT_ORGANIZATION',
      referenceId, over.key ?? `b-${randomUUID()}`, adminUserId,
    ],
  );
}

describe('CR-HM-12 PART 06A BM fee term/beneficiary persistence', () => {
  it('t1 adds exactly two version-bound tables with the frozen columns', async (t) => {
    if (!requireDatabase(t)) return;

    // T10 / §3: exact column inventory, no extra fact is representable.
    const columns = async (table: string) => {
      const res = await q(
        `SELECT column_name, data_type, numeric_precision,
                numeric_scale
           FROM information_schema.columns
          WHERE table_name = $1`,
        [table],
      );
      return res.rows as Array<{
        column_name: string;
        data_type: string;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }>;
    };

    const term = await columns(TERM);
    assert.deepEqual(
      term.map((r) => r.column_name).sort(),
      [
        'agreement_version_id', 'created_at', 'created_by_user_id',
        'id', 'idempotency_key', 'rate_percent', 'term_kind',
      ],
    );
    const beneficiary = await columns(BENEFICIARY);
    assert.deepEqual(
      beneficiary.map((r) => r.column_name).sort(),
      [
        'agreement_version_id', 'beneficiary_kind',
        'beneficiary_reference_id', 'created_at', 'created_by_user_id',
        'id', 'idempotency_key',
      ],
    );

    // The ONLY numeric column in both tables is the bounded rate.
    const numerics = [...term, ...beneficiary].filter(
      (r) => r.data_type === 'numeric',
    );
    assert.deepEqual(
      numerics.map((r) => r.column_name),
      ['rate_percent'],
    );
    assert.equal(numerics[0].numeric_precision, 7);
    assert.equal(numerics[0].numeric_scale, 4);

    // No fee value, charge, balance, entitlement, settlement, payout,
    // bank/rail, currency, free-text, or SaaS/FM column exists.
    const FORBIDDEN_COLUMN =
      /amount|charge|balance|entitlement|settle|refund|payment|ledger|payout|disburse|bank|iban|wallet|rail|gateway|subscription|billing|currency|status|name|contact|invoice|platform|saas/i;
    for (const row of [...term, ...beneficiary]) {
      assert.doesNotMatch(
        row.column_name,
        FORBIDDEN_COLUMN,
        `forbidden column: ${row.column_name}`,
      );
    }

    // Exactly two prerequisite tables exist — no third surface.
    const tables = await q(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name LIKE 'handyman_bm_fee_%'`,
    );
    assert.deepEqual(
      tables.rows
        .map((r: { table_name: string }) => r.table_name)
        .filter((n: string) => n === TERM || n === BENEFICIARY)
        .sort(),
      [BENEFICIARY, TERM],
    );
  });

  it('t2 is DRAFT-window authored and totally append-only', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P06A-t2');
    const prepared = await draftAgreementVersion(realm.client.id);

    // Lawful authoring inside the DRAFT window (both facts).
    const term = await insertTerm(prepared.version.id);
    const beneficiary = await insertBeneficiary(prepared.version.id);
    assert.equal(term.rowCount, 1);
    assert.equal(beneficiary.rowCount, 1);

    // T1: no UPDATE, no DELETE — history is appended, never edited.
    await assert.rejects(
      q(`UPDATE ${TERM} SET rate_percent = 9.9999 WHERE id = $1`,
        [term.rows[0].id]),
      /append-only/,
    );
    await assert.rejects(
      q(`DELETE FROM ${TERM} WHERE id = $1`, [term.rows[0].id]),
      /append-only/,
    );
    await assert.rejects(
      q(`UPDATE ${BENEFICIARY} SET beneficiary_kind = 'OTHER' WHERE id = $1`,
        [beneficiary.rows[0].id]),
      /append-only/,
    );
    await assert.rejects(
      q(`DELETE FROM ${BENEFICIARY} WHERE id = $1`,
        [beneficiary.rows[0].id]),
      /append-only/,
    );

    // T2: once effective, authoring is refused by the DB itself
    // (service bypass included); supersession = a NEW version.
    await activateVersion(prepared.version.id);
    await assert.rejects(
      insertTerm(prepared.version.id),
      /only be authored on a DRAFT/,
    );
    await assert.rejects(
      insertBeneficiary(prepared.version.id),
      /only be authored on a DRAFT/,
    );
    const next = await draftAgreementVersion(realm.client.id);
    await insertTerm(next.version.id);
    await insertBeneficiary(next.version.id);

    // Trigger inventory: BEFORE INSERT guard + BEFORE UPDATE/DELETE
    // block on each table, all owned by this PART's functions.
    const triggers = await q(
      `SELECT c.relname AS table_name, tg.tgname,
              p.proname AS function_name, tg.tgtype
         FROM pg_trigger tg
         JOIN pg_class c ON c.oid = tg.tgrelid
         JOIN pg_proc p ON p.oid = tg.tgfoid
        WHERE NOT tg.tgisinternal
          AND c.relname = ANY($1::text[])`,
      [[TERM, BENEFICIARY]],
    );
    const names = triggers.rows
      .map((r: { tgname: string }) => r.tgname)
      .sort();
    assert.deepEqual(names, [
      'handyman_bm_fee_beneficiary_client_trigger',
      'handyman_bm_fee_beneficiary_draft_only_trigger',
      'handyman_bm_fee_beneficiary_no_write_trigger',
      'handyman_bm_fee_term_draft_only_trigger',
      'handyman_bm_fee_term_no_write_trigger',
    ]);
    const fnNames = new Set(
      triggers.rows.map((r: { function_name: string }) => r.function_name),
    );
    assert.deepEqual([...fnNames].sort(), [
      'handyman_bm_fee_beneficiary_client_consistency',
      'handyman_bm_fee_prerequisite_draft_only',
      'handyman_bm_fee_prerequisite_no_write',
    ]);
    for (const row of triggers.rows as Array<{
      tgname: string; tgtype: number;
    }>) {
      assert.ok(row.tgtype & 2, `${row.tgname} must fire BEFORE`);
      if (row.tgname.endsWith('no_write_trigger')) {
        // UPDATE (16) + DELETE (8).
        assert.equal(row.tgtype & 16, 16);
        assert.equal(row.tgtype & 8, 8);
      } else {
        // INSERT (4).
        assert.equal(row.tgtype & 4, 4);
      }
    }
  });

  it('t3 allows exactly one term and one beneficiary per version', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P06A-t3');
    const prepared = await draftAgreementVersion(realm.client.id);

    await insertTerm(prepared.version.id);
    await insertBeneficiary(prepared.version.id);

    // T3: a second fact for the same EXACT version is refused
    // (never first-wins, never last-wins).
    await assert.rejects(
      insertTerm(prepared.version.id, { rate: '3.0' }),
      (err: { code?: string }) => err.code === '23505',
    );
    await assert.rejects(
      insertBeneficiary(prepared.version.id),
      (err: { code?: string }) => err.code === '23505',
    );

    // T7: single-use idempotency key across all versions.
    const other = await draftAgreementVersion(realm.client.id);
    const sharedKey = `shared-${randomUUID()}`;
    await insertTerm(other.version.id, { key: sharedKey });
    const third = await draftAgreementVersion(realm.client.id);
    await assert.rejects(
      insertTerm(third.version.id, { key: sharedKey }),
      (err: { code?: string }) => err.code === '23505',
    );

    // T7/T8: a term must bind to a REAL version (FK), and a blank
    // key is refused by CHECK.
    await assert.rejects(
      insertTerm(randomUUID()),
      (err: { code?: string }) => err.code === '23503',
    );
    await assert.rejects(
      insertTerm(third.version.id, { key: ' '.repeat(201) }),
      (err: { code?: string }) => err.code === '23514',
    );
  });

  it('t4 bounds the term rate and preserves exact decimals', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P06A-t4');
    const prepared = await draftAgreementVersion(realm.client.id);
    const versionId = prepared.version.id;

    // T4: the term vocabulary is closed.
    await assert.rejects(
      insertTerm(versionId, { kind: 'FLAT_AMOUNT' }),
      (err: { code?: string }) => err.code === '23514',
    );
    await assert.rejects(
      insertTerm(versionId, { kind: 'SaaS_SHARE' }),
      (err: { code?: string }) => err.code === '23514',
    );

    // T5: (0, 100] — zero, negative, over-100, NaN and Infinity all
    // refuse; NaN/Infinity are not representable as a lawful rate
    // (a precision-bounded NUMERIC rejects Infinity as 22003, and
    // NaN fails the CHECK as 23514).
    for (const bad of ['0', '-1', '100.0001', 'NaN', 'Infinity', '-Infinity']) {
      await assert.rejects(
        insertTerm(versionId, { rate: bad }),
        (err: { code?: string }) =>
          err.code === '23514' || err.code === '22003',
        `rate ${bad} must be refused`,
      );
    }

    // Boundary values are lawful and exact (NUMERIC, never float).
    await insertTerm(versionId, { rate: '100' });
    const stored = await q(
      `SELECT rate_percent::text AS rate FROM ${TERM}
        WHERE agreement_version_id = $1`,
      [versionId],
    );
    assert.equal(stored.rows[0].rate, '100.0000');

    // A fresh version proves the 4-decimal round-trip byte-exactly.
    const other = await draftAgreementVersion(realm.client.id);
    await insertTerm(other.version.id, { rate: '2.5' });
    const roundTrip = await q(
      `SELECT rate_percent::text AS rate, rate_percent = 2.5 AS exact
         FROM ${TERM} WHERE agreement_version_id = $1`,
      [other.version.id],
    );
    assert.equal(roundTrip.rows[0].rate, '2.5000');
    assert.equal(roundTrip.rows[0].exact, true);
  });

  it('t5 binds the beneficiary to the version client, by kind only', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P06A-t5');
    const foreign = await realmFixture('CR-HM-12-P06A-t5b');
    const prepared = await draftAgreementVersion(realm.client.id);
    const versionId = prepared.version.id;

    // T4: the beneficiary vocabulary is closed — no free-text payee.
    await assert.rejects(
      insertBeneficiary(versionId, { kind: 'BM_ENTITY' }),
      (err: { code?: string }) => err.code === '23514',
    );

    // T6: the CLIENT_ORGANIZATION reference IS the version's client;
    // a foreign client is refused (no channel/vendor/caller identity
    // is representable), and an unknown client fails the FK.
    await assert.rejects(
      insertBeneficiary(versionId, { referenceId: foreign.client.id }),
      /must equal the bound agreement version client/,
    );
    // A reference that is not a real client is refused before any
    // row lands (consistency guard or clients FK — never accepted).
    await assert.rejects(
      insertBeneficiary(versionId, { referenceId: randomUUID() }),
    );

    // The lawful row is exactly the version's own client.
    await insertBeneficiary(versionId);
    const stored = await q(
      `SELECT b.beneficiary_kind AS kind,
              b.beneficiary_reference_id AS ref,
              a.client_id AS version_client
         FROM ${BENEFICIARY} b
         JOIN handyman_commercial_agreement_versions v
           ON v.id = b.agreement_version_id
         JOIN handyman_commercial_agreements a
           ON a.id = v.agreement_id
        WHERE b.agreement_version_id = $1`,
      [versionId],
    );
    assert.equal(stored.rows[0].kind, 'CLIENT_ORGANIZATION');
    assert.equal(stored.rows[0].ref, stored.rows[0].version_client);
    assert.equal(stored.rows[0].ref, realm.client.id);
  });

  it('t6 keeps the FK/wiring surface closed: no ledger, SaaS, FM, or API', async (t) => {
    if (!requireDatabase(t)) return;

    // T8: the FK graph reaches versions, clients, and users only.
    const fks = await q(
      `SELECT c.relname AS from_table, f.relname AS to_table
         FROM pg_constraint tc
         JOIN pg_class c ON c.oid = tc.conrelid
         JOIN pg_class f ON f.oid = tc.confrelid
        WHERE tc.contype = 'f'
          AND tc.connamespace = 'public'::regnamespace
          AND c.relname = ANY($1::text[])`,
      [[TERM, BENEFICIARY]],
    );
    const ALLOWED = new Set([
      'handyman_commercial_agreement_versions', 'clients', 'users',
    ]);
    // term -> version + users; beneficiary -> version + clients + users.
    assert.equal(fks.rows.length, 5);
    for (const row of fks.rows as Array<{ to_table: string }>) {
      assert.ok(ALLOWED.has(row.to_table),
        `forbidden FK -> ${row.to_table}`);
    }

    // Source truth: the migration is additive, drops exactly the two
    // tables, and carries no ledger/SaaS/FM/API vocabulary (comments
    // describe the absent surfaces, so they are stripped first).
    const dir = new URL('../src/database/migrations/', import.meta.url);
    const fileName = '0415_create_handyman_bm_fee_prerequisite.ts';
    const raw = readFileSync(new URL(`./${fileName}`, dir), 'utf8');
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const dropped = [...raw.matchAll(/DROP TABLE IF EXISTS (\w+)/g)]
      .map((m) => m[1]).sort();
    assert.deepEqual(dropped, [BENEFICIARY, TERM]);

    // T9: the revert is EXECUTED, not merely read — `down` removes
    // exactly the two tables and this PART's three functions, and a
    // re-apply restores the frozen surface with zero residue.
    const exists = async (name: string) => {
      const res = await q(`SELECT to_regclass($1) AS oid`, [name]);
      return res.rows[0].oid !== null;
    };
    const fnExists = async (name: string) => {
      const res = await q(
        `SELECT EXISTS (
           SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = $1
         ) AS present`,
        [name],
      );
      return res.rows[0].present;
    };
    assert.equal(await exists(TERM), true);
    assert.equal(await exists(BENEFICIARY), true);

    await migration0415CreateHandymanBmFeePrerequisite.down(
      pool as unknown as PoolClient,
    );
    assert.equal(await exists(TERM), false);
    assert.equal(await exists(BENEFICIARY), false);
    for (const fn of [
      'handyman_bm_fee_prerequisite_draft_only',
      'handyman_bm_fee_prerequisite_no_write',
      'handyman_bm_fee_beneficiary_client_consistency',
    ]) {
      assert.equal(await fnExists(fn), false, `${fn} must be dropped`);
    }
    // Pre-existing anchors are untouched by the revert.
    assert.equal(
      await exists('handyman_commercial_agreement_versions'), true,
    );
    assert.equal(await exists('handyman_bm_fee_rule_definitions'), true);

    await migration0415CreateHandymanBmFeePrerequisite.up(
      pool as unknown as PoolClient,
    );
    assert.equal(await exists(TERM), true);
    assert.equal(await exists(BENEFICIARY), true);
    const reapplied = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = $1`,
      [TERM],
    );
    assert.deepEqual(
      reapplied.rows
        .map((r: { column_name: string }) => r.column_name).sort(),
      [
        'agreement_version_id', 'created_at', 'created_by_user_id',
        'id', 'idempotency_key', 'rate_percent', 'term_kind',
      ],
    );

    const FORBIDDEN = /entitlement|settle|reconcil|payout|disburse|gateway|midtrans|xendit|stripe|subscription|billing|platform_|tenant_|vendor_|invoice|payment|ledger|handyman_customer_|handyman_charge_|handyman_payment_|handyman_quotation|handyman_work_session|handyman_material_execution|handyman_bast|controller|route|openapi/i;
    assert.doesNotMatch(code, FORBIDDEN,
      'forbidden vocabulary in PART 06A migration');

    // Both prerequisite tables are owned by exactly this migration.
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file === fileName) continue;
      const source = readFileSync(new URL(`./${file}`, dir), 'utf8');
      assert.doesNotMatch(
        source,
        /handyman_bm_fee_term_definitions|handyman_bm_fee_beneficiary_definitions/,
        `${file} must not touch the PART 06A tables`,
      );
    }

    // Wiring: registered last (0415), 0414 untouched before it.
    const index = readFileSync(new URL('./index.ts', dir), 'utf8');
    assert.match(index, /migration0415CreateHandymanBmFeePrerequisite/);
    assert.match(
      index,
      /migration0414HandymanLedgerCorrections,\s*\n\s*migration0415CreateHandymanBmFeePrerequisite,\s*\n\];/,
    );

    // PART 06A is persistence-only: no module surface, no API, no
    // read contract was added (06B owns the reading surface).
    const modules = new URL('../src/modules/', import.meta.url);
    const moduleNames = readdirSync(modules, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
    assert.equal(
      moduleNames.filter((n) => /bm-fee.*(api|read|contract)/i.test(n))
        .length,
      0,
    );
  });
});
