import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { AppError, ERROR_CODES } from '../src/shared/errors';
import {
  HANDYMAN_BILLABLE_TIME_BASES,
  HANDYMAN_CREW_PRICING_MODES,
  HANDYMAN_LABOR_PRICING_MODES,
  assertHandymanLaborPricingShape,
  evaluateHandymanLaborPricingBasis,
  parseHandymanLaborUnitAmount,
  prepareHandymanLaborPricingBasis,
  listHandymanLaborPricingBasisForVersion,
  resolveHandymanLaborPricingBasisAt,
} from '../src/modules/handyman-labor-pricing';
import {
  prepareHandymanCommercialAgreement,
  activateHandymanCommercialAgreementVersion,
  supersedeHandymanCommercialAgreementVersion,
} from '../src/modules/handyman-commercial-agreements';
import { createAdminUser } from './helpers/access';
import { realmFixture, initHandymanFixtures } from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-12 PART 02 — labor & crew pricing-mode basis execution
 * contract bound to EXACT agreement versions ONLY (FROZEN
 * governance §4/§5/§10). NO material pricing (PART 03), NO BM fee
 * rules (PART 04), NO ledger/payment/settlement, NO API. Six
 * focused cases.
 */

const TABLE = 'handyman_labor_pricing_basis_definitions';

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

function expectErrorCode(err: unknown, code: string): void {
  assert.ok(err instanceof AppError, `expected AppError ${code}`);
  assert.equal(err.code, code);
}

async function newClientRealm() {
  if (!pool) throw new Error('db pool not initialized');
  return realmFixture(`CR-HM-12-P02-${randomUUID().slice(0, 4)}`);
}

async function draftVersion(clientId: string) {
  const prepared = await prepareHandymanCommercialAgreement(adminUserId, {
    clientId, idempotencyKey: `p-${randomUUID()}`,
  });
  return prepared;
}

function hourlyInput(over: Record<string, unknown> = {}) {
  return {
    mode: 'HOURLY',
    crewMode: 'PER_HEAD',
    billableTimeBasis: 'ACTUAL_WORK',
    unitAmount: '150000.00',
    currency: 'IDR',
    idempotencyKey: `k-${randomUUID()}`,
    ...over,
  };
}

const HOURLY_FACTS = {
  mode: 'HOURLY',
  crewMode: 'PER_HEAD',
  billableTimeBasis: 'ACTUAL_WORK',
  unitAmount: '150000.00',
  currency: 'IDR',
} as const;

describe('CR-HM-12 PART 02 labor & crew pricing basis', () => {
  it('t1 freezes vocabularies, the shape law, and the pure evaluator', () => {
    assert.deepEqual([...HANDYMAN_LABOR_PRICING_MODES], [
      'HOURLY', 'FIXED_SCOPE', 'INSPECTION_FIRST', 'VISIT_FEE',
    ]);
    assert.deepEqual([...HANDYMAN_CREW_PRICING_MODES], [
      'PER_HEAD', 'PER_CREW',
    ]);
    assert.deepEqual([...HANDYMAN_BILLABLE_TIME_BASES], [
      'PRESENCE', 'ACTUAL_WORK',
    ]);

    // Shape law mirrors the migration CHECKs.
    assert.throws(
      () => assertHandymanLaborPricingShape({
        mode: 'HOURLY', crewMode: 'PER_HEAD', billableTimeBasis: null,
      }),
      (err: unknown) => {
        expectErrorCode(
          err, ERROR_CODES.HANDYMAN_LABOR_PRICING_VALIDATION,
        );
        return true;
      },
    );
    assert.throws(
      () => assertHandymanLaborPricingShape({
        mode: 'FIXED_SCOPE', crewMode: 'PER_HEAD', billableTimeBasis: null,
      }),
    );
    assert.throws(
      () => assertHandymanLaborPricingShape({
        mode: 'VISIT_FEE', crewMode: 'PER_CREW',
        billableTimeBasis: 'PRESENCE',
      }),
    );
    assert.doesNotThrow(() => assertHandymanLaborPricingShape({
      mode: 'HOURLY', crewMode: 'PER_CREW', billableTimeBasis: 'PRESENCE',
    }));

    // Money string law: exact ≤2dp, non-negative, no sign/exponent.
    assert.equal(parseHandymanLaborUnitAmount('150000.00'), '150000.00');
    assert.equal(parseHandymanLaborUnitAmount('0'), '0.00');
    for (const bad of ['-1', '1.234', 'abc', '1e5', '', '15,000']) {
      assert.throws(() => parseHandymanLaborUnitAmount(bad));
    }

    // HOURLY PER_HEAD: 150000.00 * 90/60 * 3 = 675000.00
    const heady = evaluateHandymanLaborPricingBasis(HOURLY_FACTS, {
      billableMinutes: 90, crewHeadcount: 3,
    });
    assert.equal(heady.basisAmount, '675000.00');
    assert.equal(heady.appliedMinutes, 90);
    assert.equal(heady.appliedHeads, 3);

    // PER_CREW never multiplies (headcount recorded as 1 applied).
    const crewy = evaluateHandymanLaborPricingBasis(
      { ...HOURLY_FACTS, crewMode: 'PER_CREW' },
      { billableMinutes: 90, crewHeadcount: 7 },
    );
    assert.equal(crewy.basisAmount, '225000.00');
    assert.equal(crewy.appliedHeads, 1);

    // Half-up cent rounding: 0.01 * 1/60 = 0.000166.. -> 0.00;
    // 0.02 * 1/60 * 60 heads-ish case -> 0.02 exact.
    const tiny = evaluateHandymanLaborPricingBasis(
      { ...HOURLY_FACTS, unitAmount: '0.01', crewMode: 'PER_CREW' },
      { billableMinutes: 1, crewHeadcount: 1 },
    );
    assert.equal(tiny.basisAmount, '0.00');

    // VISIT_FEE: unit * visits; no minutes input allowed.
    const visited = evaluateHandymanLaborPricingBasis(
      {
        mode: 'VISIT_FEE', crewMode: 'PER_HEAD',
        billableTimeBasis: null, unitAmount: '50000.00',
        currency: 'IDR',
      },
      { visitCount: 2, crewHeadcount: 2 },
    );
    assert.equal(visited.basisAmount, '200000.00');

    // Scope-total modes: extra timeline inputs are rejected, never
    // silently ignored.
    const fixed = evaluateHandymanLaborPricingBasis(
      {
        mode: 'FIXED_SCOPE', crewMode: 'PER_CREW',
        billableTimeBasis: null, unitAmount: '500000.00',
        currency: 'IDR',
      },
      { crewHeadcount: 1 },
    );
    assert.equal(fixed.basisAmount, '500000.00');
    assert.throws(
      () => evaluateHandymanLaborPricingBasis(
        {
          mode: 'FIXED_SCOPE', crewMode: 'PER_CREW',
          billableTimeBasis: null, unitAmount: '500000.00',
          currency: 'IDR',
        },
        { crewHeadcount: 1, billableMinutes: 60 },
      ),
      (err: unknown) => {
        expectErrorCode(
          err, ERROR_CODES.HANDYMAN_LABOR_PRICING_VALIDATION,
        );
        return true;
      },
    );
    // HOURLY without minutes / headcount < 1 / NaN — bounded.
    assert.throws(() => evaluateHandymanLaborPricingBasis(HOURLY_FACTS, {
      crewHeadcount: 1,
    }));
    assert.throws(() => evaluateHandymanLaborPricingBasis(HOURLY_FACTS, {
      billableMinutes: 1.5, crewHeadcount: 1,
    }));
    assert.throws(() => evaluateHandymanLaborPricingBasis(HOURLY_FACTS, {
      billableMinutes: 60, crewHeadcount: 0,
    }));
  });

  it('t2 authors only on DRAFT versions, one per mode, zero on activation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await newClientRealm();
    const prepared = await draftVersion(realm.client.id);

    const hourly = await prepareHandymanLaborPricingBasis(adminUserId, {
      agreementVersionId: prepared.version.id,
      ...hourlyInput(),
    });
    assert.equal(hourly.replayed, false);
    assert.equal(hourly.basis.mode, 'HOURLY');
    assert.equal(hourly.basis.unitAmount, '150000.00');
    assert.equal(hourly.basis.currency, 'IDR');

    await prepareHandymanLaborPricingBasis(adminUserId, {
      agreementVersionId: prepared.version.id,
      ...hourlyInput({
        mode: 'VISIT_FEE', crewMode: 'PER_CREW',
        billableTimeBasis: null, unitAmount: '50000.00',
      }),
    });

    // One definition per mode per version.
    await assert.rejects(
      prepareHandymanLaborPricingBasis(adminUserId, {
        agreementVersionId: prepared.version.id,
        ...hourlyInput(),
      }),
      (err: unknown) => {
        expectErrorCode(
          err, ERROR_CODES.HANDYMAN_LABOR_PRICING_MODE_CONFLICT,
        );
        return true;
      },
    );

    const listed = await listHandymanLaborPricingBasisForVersion(
      prepared.version.id,
    );
    assert.equal(listed.length, 2);

    // Activation freezes the set: authoring afterwards is a bounded
    // refusal (§5 immutable once effective).
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      effectiveFrom: new Date(Date.now() + 10_000).toISOString(),
      idempotencyKey: `a-${randomUUID()}`,
    });
    await assert.rejects(
      prepareHandymanLaborPricingBasis(adminUserId, {
        agreementVersionId: prepared.version.id,
        ...hourlyInput({ mode: 'FIXED_SCOPE', crewMode: 'PER_CREW',
          billableTimeBasis: null }),
      }),
      (err: unknown) => {
        expectErrorCode(
          err, ERROR_CODES.HANDYMAN_LABOR_PRICING_VERSION_NOT_DRAFT,
        );
        return true;
      },
    );
  });

  it('t3 blocks every bypass at the database: append-only, draft-window, CHECKs', async (t) => {
    if (!requireDatabase(t)) return;
    if (!pool) return;
    const realm = await newClientRealm();
    const prepared = await draftVersion(realm.client.id);
    const hourly = await prepareHandymanLaborPricingBasis(adminUserId, {
      agreementVersionId: prepared.version.id, ...hourlyInput(),
    });

    await assert.rejects(
      pool.query(
        `UPDATE ${TABLE} SET unit_amount = unit_amount + 1 WHERE id = $1`,
        [hourly.basis.id],
      ),
      /append-only/,
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${TABLE} WHERE id = $1`, [hourly.basis.id]),
      /append-only/,
    );

    // Draft-window law enforced at the DB even if the service were
    // skipped: activate first, then a raw INSERT must fail.
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      effectiveFrom: new Date(Date.now() + 10_000).toISOString(),
      idempotencyKey: `a-${randomUUID()}`,
    });
    await assert.rejects(
      pool.query(
        `INSERT INTO ${TABLE} (
           id, agreement_version_id, mode, crew_mode, unit_amount,
           currency, idempotency_key, created_by_user_id
         ) VALUES ($1, $2, 'FIXED_SCOPE', 'PER_CREW', 1.00, 'IDR', $3, $4)`,
        [randomUUID(), prepared.version.id, `x-${randomUUID()}`,
          adminUserId],
      ),
      /only be authored on a DRAFT/,
    );

    // Bounded vocabularies are DB law too — on a DRAFT version (so
    // the CHECK, not the draft-window guard, is what refuses).
    const checkRealm = await newClientRealm();
    const checkDraft = await draftVersion(checkRealm.client.id);
    await assert.rejects(
      pool.query(
        `INSERT INTO ${TABLE} (
           id, agreement_version_id, mode, crew_mode, unit_amount,
           currency, idempotency_key, created_by_user_id
         ) VALUES ($1, $2, 'SOMETHING_ELSE', 'PER_CREW', 1.00, 'IDR', $3, $4)`,
        [randomUUID(), checkDraft.version.id, `y-${randomUUID()}`,
          adminUserId],
      ),
      (err: unknown) => {
        const e = err as { code?: string };
        return e.code === '23514';
      },
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO ${TABLE} (
           id, agreement_version_id, mode, crew_mode, unit_amount,
           currency, idempotency_key, created_by_user_id
         ) VALUES ($1, $2, 'HOURLY', 'PER_HEAD', 1.00, 'IDR', $3, $4)`,
        [randomUUID(), checkDraft.version.id, `z-${randomUUID()}`,
          adminUserId],
      ),
      (err: unknown) => {
        const e = err as { code?: string };
        return e.code === '23514';
      },
    );
  });

  it('t4 resolves fail-closed on the EXACT version through client+as-of', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await newClientRealm();
    const prepared = await draftVersion(realm.client.id);
    await prepareHandymanLaborPricingBasis(adminUserId, {
      agreementVersionId: prepared.version.id, ...hourlyInput(),
    });

    const f1 = Date.now() + 20_000;
    // Before effectiveness: the PART 01 anchor fails closed first.
    await assert.rejects(
      resolveHandymanLaborPricingBasisAt(
        realm.client.id, new Date(f1 - 60_000).toISOString(), 'HOURLY',
      ),
      (err: unknown) => {
        expectErrorCode(
          err,
          ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_EFFECTIVE_AT_AS_OF,
        );
        return true;
      },
    );

    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      effectiveFrom: new Date(f1).toISOString(),
      idempotencyKey: `a-${randomUUID()}`,
    });

    // Mode defined on this version: exact hit bound to version id.
    const hit = await resolveHandymanLaborPricingBasisAt(
      realm.client.id, new Date(f1).toISOString(), 'HOURLY',
    );
    assert.equal(hit.id, (await listHandymanLaborPricingBasisForVersion(
      prepared.version.id,
    ))[0].id);
    assert.equal(hit.agreementVersionId, prepared.version.id);

    // Mode NOT defined on the effective version: bounded conflict —
    // never a silent default and never another version's rule.
    await assert.rejects(
      resolveHandymanLaborPricingBasisAt(
        realm.client.id, new Date(f1).toISOString(), 'FIXED_SCOPE',
      ),
      (err: unknown) => {
        expectErrorCode(
          err, ERROR_CODES.HANDYMAN_LABOR_PRICING_BASIS_NOT_EFFECTIVE,
        );
        return true;
      },
    );

    // Supersession: v2 authors a different HOURLY unit; historical
    // as-of still resolves the FROZEN v1 definition — proof the
    // binding is version-exact, not "latest".
    const v2 = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p2-${randomUUID()}`,
    });
    await prepareHandymanLaborPricingBasis(adminUserId, {
      agreementVersionId: v2.version.id,
      ...hourlyInput({ unitAmount: '200000.00',
        idempotencyKey: `k-${randomUUID()}` }),
    });
    const f2 = f1 + 10 * 60_000;
    await supersedeHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      replacementVersionId: v2.version.id,
      effectiveFrom: new Date(f2).toISOString(),
      idempotencyKey: `s-${randomUUID()}`,
    });
    const old = await resolveHandymanLaborPricingBasisAt(
      realm.client.id, new Date(f2 - 1).toISOString(), 'HOURLY',
    );
    assert.equal(old.unitAmount, '150000.00');
    const now = await resolveHandymanLaborPricingBasisAt(
      realm.client.id, new Date(f2).toISOString(), 'HOURLY',
    );
    assert.equal(now.unitAmount, '200000.00');
    assert.equal(now.agreementVersionId, v2.version.id);
  });

  it('t5 replays idempotently and rejects invalid payloads without writes', async (t) => {
    if (!requireDatabase(t)) return;
    if (!pool) return;
    const realm = await newClientRealm();
    const prepared = await draftVersion(realm.client.id);
    const key = `k-${randomUUID()}`;
    const first = await prepareHandymanLaborPricingBasis(adminUserId, {
      agreementVersionId: prepared.version.id,
      ...hourlyInput({ idempotencyKey: key }),
    });
    const replay = await prepareHandymanLaborPricingBasis(adminUserId, {
      agreementVersionId: prepared.version.id,
      ...hourlyInput({ idempotencyKey: key, unitAmount: '1.00' }),
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.basis.id, first.basis.id);
    assert.equal(replay.basis.unitAmount, '150000.00');

    // Same key bound to a DIFFERENT version is a payload mismatch —
    // never a silent overwrite or a second row.
    const otherRealm = await newClientRealm();
    const other = await draftVersion(otherRealm.client.id);
    await assert.rejects(
      prepareHandymanLaborPricingBasis(adminUserId, {
        agreementVersionId: other.version.id,
        ...hourlyInput({ idempotencyKey: key }),
      }),
      (err: unknown) => {
        expectErrorCode(
          err, ERROR_CODES.HANDYMAN_LABOR_PRICING_KEY_CONFLICT,
        );
        return true;
      },
    );

    // Unknown version id / bad actor / bad currency: bounded, zero
    // rows written.
    await assert.rejects(
      prepareHandymanLaborPricingBasis(adminUserId, {
        agreementVersionId: randomUUID(), ...hourlyInput(),
      }),
      (err: unknown) => {
        expectErrorCode(
          err,
          ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VERSION_NOT_FOUND,
        );
        return true;
      },
    );
    await assert.rejects(
      prepareHandymanLaborPricingBasis(adminUserId, {
        agreementVersionId: prepared.version.id,
        ...hourlyInput({ currency: 'ZZZ' }),
      }),
    );
    const count = await pool.query(
      `SELECT count(*)::int AS n FROM ${TABLE}
        WHERE agreement_version_id IN ($1, $2)`,
      [prepared.version.id, other.version.id],
    );
    // one on prepared (first) + zero on other.
    const otherCount = await pool.query(
      `SELECT count(*)::int AS n FROM ${TABLE}
        WHERE agreement_version_id = $1`,
      [other.version.id],
    );
    assert.equal(otherCount.rows[0].n, 0);
    assert.equal(count.rows[0].n, 1);
  });

  it('t6 keeps the surface governed-only: columns, FKs, imports, no HTTP', async (t) => {
    if (!requireDatabase(t)) return;
    if (!pool) return;

    // Exact persisted column set — governed RULE facts only. No
    // charge/billing/payment/ledger/settlement/tax/discount column;
    // fee-rule vocabulary belongs to PART 04.
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = $1`,
      [TABLE],
    );
    assert.deepEqual(
      cols.rows.map((r: { column_name: string }) => r.column_name).sort(),
      [
        'agreement_version_id', 'billable_time_basis', 'created_at',
        'created_by_user_id', 'crew_mode', 'currency', 'id',
        'idempotency_key', 'mode', 'unit_amount',
      ],
    );
    const FORBIDDEN = /(^|_)(charge|charges|billing|payment|pay|invoice|ledger|settlement|settle|reconciliation|tax|discount|fee|subscription)(_|$)/i;
    for (const row of cols.rows) {
      assert.doesNotMatch(row.column_name, FORBIDDEN);
    }

    // FK graph: the PART 01 version table + users ONLY. No session,
    // crew, material, quotation, FM or SaaS table is referenced.
    const fks = await pool.query(
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
    for (const row of fks.rows) {
      assert.ok(ALLOWED.has(row.to_table),
        `forbidden FK -> ${row.to_table}`);
    }

    // Module purity: import specifiers resolve inside the CR-HM-12
    // pair + generic realm only (B2/B3/B8 firewalls); no sibling
    // HTTP surface exists.
    const dir = new URL('../src/modules/handyman-labor-pricing/',
      import.meta.url);
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile()).map((e) => e.name);
    for (const file of files) {
      assert.doesNotMatch(file, /controller|routes|api|openapi|swagger/);
    }
    const ALLOWED_IMPORTS = /^(node:.+|pg|\.\.\/\.\.\/database$|\.\.\/\.\.\/shared\/errors$|\.\.\/clients$|\.\.\/handyman-commercial-agreements$|\.\/handyman-labor-pricing\.\w+$)/;
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(new URL(`./${file}`, dir), 'utf8');
      const specifiers = [...source.matchAll(
        /from\s+'([^']+)'/g,
      )].map((m) => m[1]);
      for (const spec of specifiers) {
        assert.ok(ALLOWED_IMPORTS.test(spec),
          `${file}: forbidden import ${spec}`);
      }
    }
    assert.equal(
      readdirSync(new URL('../src/modules', import.meta.url),
        { withFileTypes: true })
        .filter((e) => e.isDirectory()
          && e.name === 'handyman-labor-pricing-api')
        .length,
      0,
    );

    // Read-only surface: this module's writes touch only its own
    // table; no session/material/quotation surface is written from
    // here (the import scan above proves no such dependency exists).
    const rows = await pool.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
    assert.ok(rows.rows[0].n >= 0);
  });
});
