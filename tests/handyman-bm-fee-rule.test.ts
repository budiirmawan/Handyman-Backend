import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { AppError, ERROR_CODES } from '../src/shared/errors';
import {
  HANDYMAN_BM_FEE_RULE_BASES,
  HANDYMAN_BM_FEE_RULE_MODES,
  isHandymanBmFeeRuleBasis,
  isHandymanBmFeeRuleMode,
  prepareHandymanBmFeeRule,
  getHandymanBmFeeRuleForVersion,
  resolveHandymanBmFeeRuleAt,
} from '../src/modules/handyman-bm-fee-rules';
import * as bmFeeBarrel from '../src/modules/handyman-bm-fee-rules';
import {
  prepareHandymanCommercialAgreement,
  activateHandymanCommercialAgreementVersion,
  supersedeHandymanCommercialAgreementVersion,
} from '../src/modules/handyman-commercial-agreements';
import { createAdminUser } from './helpers/access';
import { initHandymanFixtures, realmFixture }
  from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-12 PART 04 — BM fee rules/basis bound to EXACT agreement
 * versions, LABOR_ONLY default/reference vocabulary frozen ONLY
 * (FROZEN governance §7/§10). NO entitlement math, NO
 * ledger/payment/settlement, NO API, NO SaaS reads. Six focused
 * cases.
 */

const TABLE = 'handyman_bm_fee_rule_definitions';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE ${TABLE},
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

function expectErrorCode(err: unknown, code: string): void {
  assert.ok(err instanceof AppError, `expected AppError ${code}`);
  assert.equal(err.code, code);
}

function rejectsCode(code: string) {
  return (err: unknown) => {
    expectErrorCode(err, code);
    return true;
  };
}

async function draftAgreementVersion(clientId: string) {
  return prepareHandymanCommercialAgreement(adminUserId, {
    clientId, idempotencyKey: `p-${randomUUID()}`,
  });
}

function ruleInput(over: Record<string, unknown> = {}) {
  return {
    basis: 'LABOR_ONLY',
    mode: 'DEFAULT',
    idempotencyKey: `k-${randomUUID()}`,
    ...over,
  };
}

describe('CR-HM-12 PART 04 BM fee rules', () => {
  it('t1 freezes vocabularies and publishes zero derivation surface', () => {
    assert.deepEqual([...HANDYMAN_BM_FEE_RULE_BASES], ['LABOR_ONLY']);
    assert.deepEqual([...HANDYMAN_BM_FEE_RULE_MODES], [
      'DEFAULT', 'REFERENCE',
    ]);
    assert.equal(isHandymanBmFeeRuleBasis('LABOR_ONLY'), true);
    assert.equal(isHandymanBmFeeRuleBasis('LABOR_PLUS_MATERIAL'), false);
    assert.equal(isHandymanBmFeeRuleMode('REFERENCE'), true);
    assert.equal(isHandymanBmFeeRuleMode('AUTO'), false);

    // The barrel exports NO evaluation/derivation/amount surface —
    // fee VALUE computation is CR-HM-14's entitlement domain (§7).
    const FORBIDDEN_EXPORT = /evaluate|derive|compute|calculate|percent|amount|value|rate|collect|invoice|ledger|settle|reconcil|subscription|billing/i;
    for (const name of Object.keys(bmFeeBarrel)) {
      assert.doesNotMatch(name, FORBIDDEN_EXPORT,
        `forbidden exported surface: ${name}`);
    }
  });

  it('t2 authors one rule per version, only while DRAFT', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P04-t2');
    const prepared = await draftAgreementVersion(realm.client.id);

    const first = await prepareHandymanBmFeeRule(adminUserId, {
      agreementVersionId: prepared.version.id, ...ruleInput(),
    });
    assert.equal(first.rule.basis, 'LABOR_ONLY');
    assert.equal(first.rule.mode, 'DEFAULT');
    assert.equal(first.replayed, false);

    // Exactly ONE BM fee rule per agreement version.
    await assert.rejects(
      prepareHandymanBmFeeRule(adminUserId, {
        agreementVersionId: prepared.version.id,
        ...ruleInput({ mode: 'REFERENCE' }),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_RULE_ALREADY_DEFINED),
    );

    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: `a-${randomUUID()}`,
    });

    // Frozen once effective; revision = new DRAFT version.
    await assert.rejects(
      prepareHandymanBmFeeRule(adminUserId, {
        agreementVersionId: prepared.version.id,
        ...ruleInput({ mode: 'REFERENCE' }),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_RULE_VERSION_NOT_DRAFT),
    );
    const v2 = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p2-${randomUUID()}`,
    });
    const onDraft = await prepareHandymanBmFeeRule(adminUserId, {
      agreementVersionId: v2.version.id, ...ruleInput(),
    });
    assert.equal(onDraft.rule.agreementVersionId, v2.version.id);

    // Unknown version: 404; non-frozen vocabularies: 400. An
    // un-governed basis (e.g. a SaaS-shaped 'SUBSCRIPTION_SHARE')
    // is impossible by vocabulary, not by convention.
    await assert.rejects(
      prepareHandymanBmFeeRule(adminUserId, {
        agreementVersionId: randomUUID(), ...ruleInput(),
      }),
      rejectsCode(
        ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VERSION_NOT_FOUND,
      ),
    );
    await assert.rejects(
      prepareHandymanBmFeeRule(adminUserId, {
        agreementVersionId: prepared.version.id,
        ...ruleInput({ basis: 'GROSS_ALL' }),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_RULE_VALIDATION),
    );
    await assert.rejects(
      prepareHandymanBmFeeRule(adminUserId, {
        agreementVersionId: prepared.version.id,
        ...ruleInput({ basis: 'SUBSCRIPTION_SHARE' }),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_RULE_VALIDATION),
    );
    await assert.rejects(
      prepareHandymanBmFeeRule(adminUserId, {
        agreementVersionId: prepared.version.id,
        ...ruleInput({ mode: 'PERCENT' }),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_RULE_VALIDATION),
    );
  });

  it('t3 freezes the schema surface and blocks every DB bypass', async (t) => {
    if (!requireDatabase(t)) return;
    if (!pool) return;

    // Exact persisted columns — a bound choice-of-rule fact ONLY.
    const cols = await q(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = $1`,
      [TABLE],
    );
    assert.deepEqual(
      cols.rows.map((r: { column_name: string }) =>
        r.column_name).sort(),
      [
        'agreement_version_id', 'basis', 'created_at',
        'created_by_user_id', 'id', 'idempotency_key', 'mode',
      ],
    );
    // Zero numeric columns: no percentage/rate/amount fact can even
    // be represented in this CR (§7: fee VALUE is CR-HM-14's).
    for (const row of cols.rows) {
      assert.ok(
        ['text', 'uuid', 'timestamp with time zone'].includes(
          row.data_type,
        ),
        `numeric column forbidden here: ${row.column_name} `
        + `(${row.data_type})`,
      );
    }
    for (const row of cols.rows) {
      assert.doesNotMatch(
        row.column_name,
        /amount|qty|quantity|price|rate|percent|basis_point|value|charge|pay|invoice|ledger|subscription|billing/i,
      );
    }

    // FK graph: PART 01 version table + users ONLY.
    const fks = await q(
      `SELECT frel.relname AS to_table
         FROM pg_constraint tc
         JOIN pg_class crel ON crel.oid = tc.conrelid
         JOIN pg_class frel ON frel.oid = tc.confrelid
        WHERE tc.contype = 'f'
          AND tc.connamespace = 'public'::regnamespace
          AND crel.relname = $1`,
      [TABLE],
    );
    const ALLOWED = new Set([
      'handyman_commercial_agreement_versions', 'users',
    ]);
    assert.ok(fks.rows.length > 0);
    for (const row of fks.rows) {
      assert.ok(ALLOWED.has(row.to_table),
        `forbidden FK -> ${row.to_table}`);
    }

    const realm = await realmFixture('CR-HM-12-P04-t3');
    const prepared = await draftAgreementVersion(realm.client.id);
    const first = await prepareHandymanBmFeeRule(adminUserId, {
      agreementVersionId: prepared.version.id, ...ruleInput(),
    });

    await assert.rejects(
      q(`UPDATE ${TABLE} SET mode = 'REFERENCE' WHERE id = $1`,
        [first.rule.id]),
      /append-only/,
    );
    await assert.rejects(
      q(`DELETE FROM ${TABLE} WHERE id = $1`, [first.rule.id]),
      /append-only/,
    );
    await assert.rejects(
      q(
        `INSERT INTO ${TABLE} (
           id, agreement_version_id, basis, mode, idempotency_key,
           created_by_user_id
         ) VALUES ($1, $2, 'LABOR_ONLY', 'REFERENCE', $3, $4)`,
        [randomUUID(), prepared.version.id, `dup-${randomUUID()}`,
          adminUserId],
      ),
      (err: { code?: string }) => err.code === '23505',
    );
    // Bad basis refuses via CHECK on a FRESH DRAFT version (no
    // UNIQUE race possible there).
    const t3b = await realmFixture('CR-HM-12-P04-t3b');
    const t3bVersion = await draftAgreementVersion(t3b.client.id);
    await assert.rejects(
      q(
        `INSERT INTO ${TABLE} (
           id, agreement_version_id, basis, mode, idempotency_key,
           created_by_user_id
         ) VALUES ($1, $2, 'PLATFORM_PACKAGE', 'DEFAULT', $3, $4)`,
        [randomUUID(), t3bVersion.version.id, `bad-${randomUUID()}`,
          adminUserId],
      ),
      (err: { code?: string }) => err.code === '23514',
    );

    // Draft-window law survives service bypass; sibling DRAFT is
    // still lawful.
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: `a-${randomUUID()}`,
    });
    await assert.rejects(
      q(
        `INSERT INTO ${TABLE} (
           id, agreement_version_id, basis, mode, idempotency_key,
           created_by_user_id
         ) VALUES ($1, $2, 'LABOR_ONLY', 'DEFAULT', $3, $4)`,
        [randomUUID(), prepared.version.id, `bypass-${randomUUID()}`,
          adminUserId],
      ),
      /only be authored on a DRAFT/,
    );
  });

  it('t4 resolves fail-closed on the exact version across supersession', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P04-t4');
    const prepared = await draftAgreementVersion(realm.client.id);
    const f1 = Date.now() - 120_000;

    // Nothing effective yet: PART 01 anchor fails closed first.
    await assert.rejects(
      resolveHandymanBmFeeRuleAt(
        realm.client.id, new Date(f1).toISOString(),
      ),
      rejectsCode(
        ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_EFFECTIVE_AT_AS_OF,
      ),
    );

    await prepareHandymanBmFeeRule(adminUserId, {
      agreementVersionId: prepared.version.id, ...ruleInput(),
    });
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      effectiveFrom: new Date(f1).toISOString(),
      idempotencyKey: `a1-${randomUUID()}`,
    });

    const hit = await resolveHandymanBmFeeRuleAt(
      realm.client.id, new Date(f1 + 1000).toISOString(),
    );
    assert.equal(hit.agreementVersionId, prepared.version.id);
    assert.equal(hit.basis, 'LABOR_ONLY');
    assert.equal(hit.mode, 'DEFAULT');

    // Version WITHOUT a rule: bounded NOT_EFFECTIVE — never a
    // silent default and never another version's rule.
    const vNoRule = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p2-${randomUUID()}`,
    });
    const f2 = Date.now() - 60_000;
    await supersedeHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      replacementVersionId: vNoRule.version.id,
      effectiveFrom: new Date(f2).toISOString(),
      idempotencyKey: `s1-${randomUUID()}`,
    });
    await assert.rejects(
      resolveHandymanBmFeeRuleAt(realm.client.id, new Date(f2).toISOString()),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_RULE_NOT_EFFECTIVE),
    );
    // And authoring it now is refused too (ACTIVE — §5): revision
    // must land a NEW version.
    await assert.rejects(
      prepareHandymanBmFeeRule(adminUserId, {
        agreementVersionId: vNoRule.version.id, ...ruleInput(),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_RULE_VERSION_NOT_DRAFT),
    );
    // Historical as-of still resolves the FROZEN v1 rule (version-
    // exact binding, not "latest").
    const historical = await resolveHandymanBmFeeRuleAt(
      realm.client.id, new Date(f2 - 1).toISOString(),
    );
    assert.equal(historical.agreementVersionId, prepared.version.id);

    // v3: authored as REFERENCE while DRAFT, then activated.
    const v3 = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p3-${randomUUID()}`,
    });
    await prepareHandymanBmFeeRule(adminUserId, {
      agreementVersionId: v3.version.id, ...ruleInput({ mode: 'REFERENCE' }),
    });
    const f3 = Date.now() + 5 * 60_000;
    await supersedeHandymanCommercialAgreementVersion(adminUserId, {
      versionId: vNoRule.version.id,
      replacementVersionId: v3.version.id,
      effectiveFrom: new Date(f3).toISOString(),
      idempotencyKey: `s2-${randomUUID()}`,
    });
    const refEra = await resolveHandymanBmFeeRuleAt(
      realm.client.id, new Date(f3).toISOString(),
    );
    assert.equal(refEra.mode, 'REFERENCE');
    // An as-of inside v2's rule-less window stays NOT_EFFECTIVE.
    await assert.rejects(
      resolveHandymanBmFeeRuleAt(
        realm.client.id, new Date(f3 - 1).toISOString(),
      ),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_RULE_NOT_EFFECTIVE),
    );

    // v4: DEFAULT rule; new effective instant resolves the NEW rule.
    const v4 = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p4-${randomUUID()}`,
    });
    await prepareHandymanBmFeeRule(adminUserId, {
      agreementVersionId: v4.version.id,
      idempotencyKey: `r4-${randomUUID()}`,
      basis: 'LABOR_ONLY', mode: 'DEFAULT',
    });
    const f4 = Date.now() + 10 * 60_000;
    await supersedeHandymanCommercialAgreementVersion(adminUserId, {
      versionId: v3.version.id,
      replacementVersionId: v4.version.id,
      effectiveFrom: new Date(f4).toISOString(),
      idempotencyKey: `s3-${randomUUID()}`,
    });
    const next = await resolveHandymanBmFeeRuleAt(
      realm.client.id, new Date(f4).toISOString(),
    );
    assert.equal(next.agreementVersionId, v4.version.id);
    assert.equal(next.mode, 'DEFAULT');

    // get-for-version reads are exact too (never "current").
    const exact = await getHandymanBmFeeRuleForVersion(
      v3.version.id,
    );
    assert.ok(exact);
    assert.equal(exact.mode, 'REFERENCE');
    const t4c = await realmFixture('CR-HM-12-P04-t4c');
    const empty = await draftAgreementVersion(t4c.client.id);
    assert.equal(
      await getHandymanBmFeeRuleForVersion(empty.version.id),
      null,
    );
  });

  it('t5 replays idempotently and refuses mismatched payloads', async (t) => {
    if (!requireDatabase(t)) return;
    if (!pool) return;
    const realm = await realmFixture('CR-HM-12-P04-t5');
    const prepared = await draftAgreementVersion(realm.client.id);
    const key = `k-${randomUUID()}`;
    const first = await prepareHandymanBmFeeRule(adminUserId, {
      agreementVersionId: prepared.version.id,
      idempotencyKey: key, ...ruleInput({ idempotencyKey: key }),
    });
    const replay = await prepareHandymanBmFeeRule(adminUserId, {
      agreementVersionId: prepared.version.id,
      idempotencyKey: key, ...ruleInput({
        mode: 'REFERENCE', idempotencyKey: key,
      }),
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.rule.id, first.rule.id);
    assert.equal(replay.rule.mode, 'DEFAULT');

    // Same key, different version: payload mismatch conflict — and
    // still exactly one rule row for that other version (zero).
    const otherRealm = await realmFixture('CR-HM-12-P04-t5b');
    const other = await draftAgreementVersion(otherRealm.client.id);
    await assert.rejects(
      prepareHandymanBmFeeRule(adminUserId, {
        agreementVersionId: other.version.id,
        idempotencyKey: key, ...ruleInput({ idempotencyKey: key }),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_RULE_KEY_CONFLICT),
    );
    const rows = await q(
      `SELECT count(*)::int AS n FROM ${TABLE}
        WHERE agreement_version_id = $1`,
      [other.version.id],
    );
    assert.equal(rows.rows[0].n, 0);

    // Bad actor / bad key: bounded, zero writes.
    await assert.rejects(
      prepareHandymanBmFeeRule('nope', {
        agreementVersionId: other.version.id, ...ruleInput(),
      }),
    );
    await assert.rejects(
      prepareHandymanBmFeeRule(adminUserId, {
        agreementVersionId: other.version.id,
        ...ruleInput({ idempotencyKey: ' '.repeat(201) }),
      }),
    );
    const afterRows = await q(
      `SELECT count(*)::int AS n FROM ${TABLE}
        WHERE agreement_version_id = $1`,
      [other.version.id],
    );
    assert.equal(afterRows.rows[0].n, 0);
  });

  it('t6 keeps the module a pure bound-rule surface: no HTTP, no reads, no SaaS', async (t) => {
    if (!requireDatabase(t)) return;

    // File surface: domain-only.
    const dir = new URL('../src/modules/handyman-bm-fee-rules/',
      import.meta.url);
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile()).map((e) => e.name);
    for (const file of files) {
      assert.doesNotMatch(file, /controller|routes|api|openapi|swagger/);
    }
    assert.equal(
      readdirSync(new URL('../src/modules', import.meta.url),
        { withFileTypes: true })
        .filter((e) => e.isDirectory()
          && e.name === 'handyman-bm-fee-rules-api')
        .length,
      0,
    );

    // Import allowlist — STRICTER than PARTs 02/03: the fee module
    // consumes ONLY the agreement anchor + generic realm. No
    // quotation, no material-execution, no session, no SaaS
    // platform module is even importable from here (§7 table).
    const ALLOWED_IMPORTS = /^(node:.+|pg|\.\.\/\.\.\/database$|\.\.\/\.\.\/shared\/errors$|\.\.\/clients$|\.\.\/handyman-commercial-agreements$|\.\/handyman-bm-fee-rule\.\w+$)/;
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(new URL(`./${file}`, dir), 'utf8');
      for (const m of source.matchAll(/from\s+'([^']+)'/g)) {
        assert.ok(ALLOWED_IMPORTS.test(m[1]),
          `${file}: forbidden import ${m[1]}`);
      }
    }

    // No SQL in this module may touch SaaS/FM/financial tables —
    // scan module sources for forbidden table names.
    const FORBIDDEN_TABLES = /platform_\w+|subscriptions|tenant_invoices|tenant_charges|vendor_invoices|utility_tariffs|payment_receipts|invoice_payment_status|work_contracts|handyman_quotation|handyman_material_execution|handyman_work_sessions|handyman_bast/i;
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(new URL(`./${file}`, dir), 'utf8');
      assert.doesNotMatch(source, FORBIDDEN_TABLES,
        `${file}: forbidden table reference`);
    }

    // The persisted universe is exactly one table, zero rows
    // written by resolution reads (re-run of t4-style resolve on a
    // rule-less fresh client must not create anything).
    const t6Realm = await realmFixture('CR-HM-12-P04-t6');
    await assert.rejects(
      resolveHandymanBmFeeRuleAt(
        t6Realm.client.id, new Date().toISOString(),
      ),
    );
    const count = await q(
      `SELECT count(*)::int AS n FROM ${TABLE}
        WHERE agreement_version_id IN (
          SELECT id FROM handyman_commercial_agreement_versions
           WHERE agreement_id IN (
             SELECT id FROM handyman_commercial_agreements
              WHERE client_id = $1))`,
      [t6Realm.client.id],
    );
    assert.equal(count.rows[0].n, 0);
  });
});
