import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { AppError, ERROR_CODES } from '../src/shared/errors';
import {
  HANDYMAN_MATERIAL_PRICING_MODES,
  assertHandymanMaterialUnitAmount,
  evaluateHandymanMaterialPricingBasis,
  prepareHandymanMaterialPricingBasis,
  getHandymanMaterialPricingBasisForVersion,
  resolveHandymanMaterialPricingBasisAt,
  computeHandymanMaterialPricingBasisForScope,
} from '../src/modules/handyman-material-pricing';
import {
  prepareHandymanCommercialAgreement,
  activateHandymanCommercialAgreementVersion,
  supersedeHandymanCommercialAgreementVersion,
} from '../src/modules/handyman-commercial-agreements';
import {
  estimateHandymanMaterialExecutionLine,
  approveHandymanMaterialExecutionLine,
  issueHandymanMaterialExecutionLine,
  useHandymanMaterialExecutionLine,
  returnHandymanMaterialExecutionLine,
  settleHandymanMaterialExecutionLine,
} from '../src/modules/handyman-material-execution';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
  realmFixture,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-12 PART 03 — material pricing basis bound to EXACT
 * agreement versions, consuming the CR-HM-09 FINAL_CHARGE_READY
 * projection + CR-HM-06 MATERIAL line snapshot READ-ONLY ONLY
 * (FROZEN governance §6/§10). NO BM fee rules (PART 04), NO
 * ledger/payment/settlement, NO API. Six focused cases.
 */

const TABLE = 'handyman_material_pricing_basis_definitions';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let disciplineId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE
    ${TABLE},
    handyman_commercial_agreement_events,
    handyman_commercial_agreement_versions,
    handyman_commercial_agreements,
    handyman_material_execution_events,
    handyman_material_execution_lines,
    handyman_execution_scope_assignments,
    handyman_execution_scopes, handyman_quotation_decisions,
    handyman_quotation_lines, handyman_quotation_versions,
    handyman_quotations,
    handyman_crew_leads, handyman_crew_memberships,
    handyman_work_crews, handyman_worker_contexts,
    handyman_provider_contexts,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    inventory_items,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings,
    properties, units_of_measure, users, roles, permissions,
    clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!d) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  disciplineId = d.id;
  initHandymanFixtures({
    adminUserId,
    disciplineId,
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
  const prepared = await prepareHandymanCommercialAgreement(adminUserId, {
    clientId, idempotencyKey: `p-${randomUUID()}`,
  });
  return prepared;
}

function lineInput(over: Record<string, unknown> = {}) {
  return {
    quotationLineId: randomUUID(),
    materialExecutionLineId: randomUUID(),
    finalQuotedUnitAmount: '25.00',
    currency: 'IDR',
    approvedQty: 4,
    finalUsedQty: 2,
    ...over,
  };
}

/**
 * Full lawful chain for composition tests: AUTHORIZED scope + Crew
 * Lead + one MATERIAL snapshot line (unit 25.00, qty 4) and the
 * material lifecycle driven to FINAL_CHARGE_READY with
 * used 3 and 1 unused unit returned => finalUsed 3.
 */
async function settledScopeFixture(agreementClient = true) {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  const versionId = f.scope.approvedQuotationVersionId;
  const uomRow = await q(
    `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
    [f.scope.clientId],
  );
  const materialLineId = randomUUID();
  await q(
    `INSERT INTO handyman_quotation_lines (
       id, quotation_version_id, line_type, description, quantity,
       uom_id, final_quoted_unit_amount, line_total, currency,
       source_item_id, created_by_user_id
     ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Cable 3x2.5mm', 4,
               $3::uuid, 25, 100, 'IDR', NULL, $4::uuid)`,
    [materialLineId, versionId, uomRow.rows[0].id, adminUserId],
  );
  const k = () => `k-${randomUUID()}`;
  const est = await estimateHandymanMaterialExecutionLine({
    executionScopeId: f.scope.id,
    quotationVersionId: versionId,
    quotationLineId: materialLineId,
    estimatedQty: 3,
    supplierReference: null,
    idempotencyKey: k(),
  }, crew.leadUser.id);
  const lineId = est.line.id;
  await approveHandymanMaterialExecutionLine(
    { executionScopeId: f.scope.id, lineId, idempotencyKey: k() },
    crew.leadUser.id,
  );
  await issueHandymanMaterialExecutionLine(
    { executionScopeId: f.scope.id, lineId, quantity: 4,
      supplierReference: null, idempotencyKey: k() },
    crew.leadUser.id,
  );
  await useHandymanMaterialExecutionLine(
    { executionScopeId: f.scope.id, lineId, quantity: 3,
      idempotencyKey: k() },
    crew.leadUser.id,
  );
  await returnHandymanMaterialExecutionLine(
    { executionScopeId: f.scope.id, lineId, quantity: 1,
      idempotencyKey: k() },
    crew.leadUser.id,
  );
  await settleHandymanMaterialExecutionLine(
    { executionScopeId: f.scope.id, lineId, idempotencyKey: k() },
    crew.leadUser.id,
  );

  let agreement: { versionId: string } | null = null;
  if (agreementClient) {
    const prepared = await draftAgreementVersion(f.scope.clientId);
    agreement = { versionId: prepared.version.id };
  }
  return {
    ...f,
    leadUserId: crew.leadUser.id,
    materialLineId,
    executionLineId: lineId,
    agreement,
  };
}

async function tableCounts(): Promise<Record<string, number>> {
  const names = [
    'handyman_material_execution_lines',
    'handyman_material_execution_events',
    'handyman_quotation_lines',
    'handyman_quotation_versions',
    'handyman_commercial_agreement_versions',
    'handyman_commercial_agreement_events',
    'handyman_material_pricing_basis_definitions',
  ];
  const out: Record<string, number> = {};
  for (const name of names) {
    const r = await q(`SELECT count(*)::int AS n FROM ${name}`);
    out[name] = r.rows[0].n;
  }
  return out;
}

describe('CR-HM-12 PART 03 material pricing basis', () => {
  it('t1 freezes the mode vocabulary and the pure quantity/amount laws', () => {
    assert.deepEqual([...HANDYMAN_MATERIAL_PRICING_MODES], [
      'SETTLED_USAGE', 'APPROVED_QTY',
    ]);

    // SETTLED_USAGE applies finalUsedQty; APPROVED_QTY approvedQty.
    const settled = evaluateHandymanMaterialPricingBasis(
      'SETTLED_USAGE', [lineInput()],
    );
    assert.equal(settled.basisAmount, '50.00');
    assert.equal(settled.lines[0].appliedQty, 2);
    assert.equal(settled.currency, 'IDR');
    const approved = evaluateHandymanMaterialPricingBasis(
      'APPROVED_QTY', [lineInput()],
    );
    assert.equal(approved.basisAmount, '100.00');
    assert.equal(approved.lines[0].appliedQty, 4);

    // Multi-line scope basis is the exact sum of line bases;
    // half-up per line (25.00 * 0.5 = 12.50; 0.01 * 0.5 -> 0.01).
    const multi = evaluateHandymanMaterialPricingBasis('SETTLED_USAGE', [
      lineInput(),
      lineInput({ finalQuotedUnitAmount: '25.00', finalUsedQty: 0.5 }),
    ]);
    assert.equal(multi.basisAmount, '62.50');
    assert.equal(
      evaluateHandymanMaterialPricingBasis('SETTLED_USAGE', [
        lineInput({ finalQuotedUnitAmount: '0.01', finalUsedQty: 0.5,
          approvedQty: 1 }),
      ]).basisAmount,
      '0.01',
    );

    // Zero settled quantity is lawful truth (0.00), not an error.
    assert.equal(
      evaluateHandymanMaterialPricingBasis('SETTLED_USAGE', [
        lineInput({ finalUsedQty: 0 }),
      ]).basisAmount,
      '0.00',
    );

    // Bounded input failures — never reinterpretation.
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => evaluateHandymanMaterialPricingBasis(
        'SETTLED_USAGE', [lineInput({ finalUsedQty: bad })],
      ));
    }
    // CR-HM-09 quantity law: finalUsed > approved is rejected.
    assert.throws(() => evaluateHandymanMaterialPricingBasis(
      'SETTLED_USAGE',
      [lineInput({ approvedQty: 1, finalUsedQty: 2 })],
    ), rejectsCode(
      ERROR_CODES.HANDYMAN_MATERIAL_PRICING_VALIDATION,
    ));
    // Mixed currencies: bounded. Empty set: bounded.
    assert.throws(() => evaluateHandymanMaterialPricingBasis(
      'SETTLED_USAGE',
      [lineInput(), lineInput({ currency: 'USD' })],
    ));
    assert.throws(() => evaluateHandymanMaterialPricingBasis(
      'SETTLED_USAGE', [],
    ));
    assert.throws(() => evaluateHandymanMaterialPricingBasis(
      'QUOTED_MARKUP', [lineInput()],
    ));
    // Unit amount law: exact 2dp text only.
    assert.equal(assertHandymanMaterialUnitAmount(' 25.00 '), '25.00');
    for (const bad of ['25', '25.000', '-1', 'abc']) {
      assert.throws(() => assertHandymanMaterialUnitAmount(bad));
    }
  });

  it('t2 authors one basis per version, only while DRAFT', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P03-t2');
    const prepared = await draftAgreementVersion(realm.client.id);

    const first = await prepareHandymanMaterialPricingBasis(adminUserId, {
      agreementVersionId: prepared.version.id,
      mode: 'SETTLED_USAGE',
      idempotencyKey: `k-${randomUUID()}`,
    });
    assert.equal(first.basis.mode, 'SETTLED_USAGE');
    assert.equal(first.replayed, false);

    // Exactly ONE material pricing basis per version — the second is
    // a bounded conflict.
    await assert.rejects(
      prepareHandymanMaterialPricingBasis(adminUserId, {
        agreementVersionId: prepared.version.id,
        mode: 'APPROVED_QTY',
        idempotencyKey: `k-${randomUUID()}`,
      }),
      rejectsCode(
        ERROR_CODES.HANDYMAN_MATERIAL_PRICING_ALREADY_DEFINED,
      ),
    );

    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: `a-${randomUUID()}`,
    });

    // Frozen once effective: authoring on the ACTIVE version refuses.
    const v2 = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p2-${randomUUID()}`,
    });
    await assert.rejects(
      prepareHandymanMaterialPricingBasis(adminUserId, {
        agreementVersionId: prepared.version.id,
        mode: 'APPROVED_QTY',
        idempotencyKey: `k-${randomUUID()}`,
      }),
      rejectsCode(
        ERROR_CODES.HANDYMAN_MATERIAL_PRICING_VERSION_NOT_DRAFT,
      ),
    );
    const onDraft = await prepareHandymanMaterialPricingBasis(adminUserId, {
      agreementVersionId: v2.version.id,
      mode: 'APPROVED_QTY',
      idempotencyKey: `k2-${randomUUID()}`,
    });
    assert.equal(onDraft.basis.mode, 'APPROVED_QTY');

    // Unknown version: 404 bounded; invalid mode: 400 bounded.
    await assert.rejects(
      prepareHandymanMaterialPricingBasis(adminUserId, {
        agreementVersionId: randomUUID(),
        mode: 'SETTLED_USAGE',
        idempotencyKey: `k3-${randomUUID()}`,
      }),
      rejectsCode(
        ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VERSION_NOT_FOUND,
      ),
    );
    await assert.rejects(
      prepareHandymanMaterialPricingBasis(adminUserId, {
        agreementVersionId: prepared.version.id,
        mode: 'REFERENCE_PRICE',
        idempotencyKey: `k4-${randomUUID()}`,
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_MATERIAL_PRICING_VALIDATION),
    );
  });

  it('t3 freezes the schema surface and blocks every DB bypass', async (t) => {
    if (!requireDatabase(t)) return;
    if (!pool) return;

    // Exact persisted columns: a choice-of-basis fact and NOTHING
    // else — no amount/qty/currency/supplier column exists (§6:
    // unit amounts stay in the snapshot, quantities in CR-HM-09).
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = $1`,
      [TABLE],
    );
    assert.deepEqual(
      cols.rows.map((r: { column_name: string }) => r.column_name).sort(),
      [
        'agreement_version_id', 'created_at', 'created_by_user_id', 'id',
        'idempotency_key', 'mode',
      ],
    );
    const FORBIDDEN = /amount|qty|quantity|price|cost|supplier|currency|charge|pay|invoice|ledger|fee|tax|discount/i;
    for (const row of cols.rows) {
      if (row.column_name === 'mode') continue;
      assert.doesNotMatch(row.column_name, FORBIDDEN);
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
    for (const row of fks.rows) {
      assert.ok(ALLOWED.has(row.to_table),
        `forbidden FK -> ${row.to_table}`);
    }

    const realm = await realmFixture('CR-HM-12-P03-t3');
    const prepared = await draftAgreementVersion(realm.client.id);
    const basis = await prepareHandymanMaterialPricingBasis(adminUserId, {
      agreementVersionId: prepared.version.id,
      mode: 'SETTLED_USAGE',
      idempotencyKey: `k-${randomUUID()}`,
    });

    await assert.rejects(
      q(`UPDATE ${TABLE} SET mode = 'APPROVED_QTY' WHERE id = $1`,
        [basis.basis.id]),
      /append-only/,
    );
    await assert.rejects(
      q(`DELETE FROM ${TABLE} WHERE id = $1`, [basis.basis.id]),
      /append-only/,
    );
    await assert.rejects(
      q(
        `INSERT INTO ${TABLE} (
           id, agreement_version_id, mode, idempotency_key,
           created_by_user_id
         ) VALUES ($1, $2, 'SETTLED_USAGE', $3, $4)`,
        [randomUUID(), prepared.version.id, `dup-${randomUUID()}`,
          adminUserId],
      ),
      (err: { code?: string }) => err.code === '23505',
    );
    // Bad mode refuses on a FRESH DRAFT version — so the refusal is
    // provably the CHECK (23514), never a UNIQUE race (23505).
    const t3b = await realmFixture('CR-HM-12-P03-t3b');
    const t3bVersion = await draftAgreementVersion(t3b.client.id);
    await assert.rejects(
      q(
        `INSERT INTO ${TABLE} (
           id, agreement_version_id, mode, idempotency_key,
           created_by_user_id
         ) VALUES ($1, $2, 'RETAIL_PLUS', $3, $4)`,
        [randomUUID(), t3bVersion.version.id, `bad-${randomUUID()}`,
          adminUserId],
      ),
      (err: { code?: string }) => err.code === '23514',
    );

    // Draft-window law survives service bypass.
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: `a-${randomUUID()}`,
    });
    const v2 = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p2-${randomUUID()}`,
    });
    await assert.rejects(
      q(
        `INSERT INTO ${TABLE} (
           id, agreement_version_id, mode, idempotency_key,
           created_by_user_id
         ) VALUES ($1, $2, 'APPROVED_QTY', $3, $4)`,
        [randomUUID(), prepared.version.id, `bypass-${randomUUID()}`,
          adminUserId],
      ),
      /only be authored on a DRAFT/,
    );
    // …while a DRAFT sibling can still be authored (DB agrees with
    // the service law, not the other way around).
    await q(
      `INSERT INTO ${TABLE} (
         id, agreement_version_id, mode, idempotency_key,
         created_by_user_id
       ) VALUES ($1, $2, 'APPROVED_QTY', $3, $4)`,
      [randomUUID(), v2.version.id, `draft-ok-${randomUUID()}`,
        adminUserId],
    );
  });

  it('t4 resolves fail-closed on the exact version across supersession', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P03-t4');
    const prepared = await draftAgreementVersion(realm.client.id);
    const f1 = Date.now() - 120_000;

    await assert.rejects(
      resolveHandymanMaterialPricingBasisAt(
        realm.client.id, new Date(f1).toISOString(),
      ),
      rejectsCode(
        ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_EFFECTIVE_AT_AS_OF,
      ),
    );

    await prepareHandymanMaterialPricingBasis(adminUserId, {
      agreementVersionId: prepared.version.id,
      mode: 'SETTLED_USAGE',
      idempotencyKey: `k1-${randomUUID()}`,
    });
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      effectiveFrom: new Date(f1).toISOString(),
      idempotencyKey: `a1-${randomUUID()}`,
    });

    const hit = await resolveHandymanMaterialPricingBasisAt(
      realm.client.id, new Date(f1 + 1000).toISOString(),
    );
    assert.equal(hit.agreementVersionId, prepared.version.id);
    assert.equal(hit.mode, 'SETTLED_USAGE');

    // v2 with a DIFFERENT basis, then supersede at f2: as-of before
    // f2 still resolves the FROZEN v1 basis — never "latest".
    const v2 = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p2-${randomUUID()}`,
    });
    await prepareHandymanMaterialPricingBasis(adminUserId, {
      agreementVersionId: v2.version.id,
      mode: 'APPROVED_QTY',
      idempotencyKey: `k2-${randomUUID()}`,
    });
    const f2 = Date.now() - 60_000;
    await supersedeHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      replacementVersionId: v2.version.id,
      effectiveFrom: new Date(f2).toISOString(),
      idempotencyKey: `s-${randomUUID()}`,
    });
    const old = await resolveHandymanMaterialPricingBasisAt(
      realm.client.id, new Date(f2 - 1).toISOString(),
    );
    assert.equal(old.agreementVersionId, prepared.version.id);
    assert.equal(old.mode, 'SETTLED_USAGE');
    const now = await resolveHandymanMaterialPricingBasisAt(
      realm.client.id, new Date(f2).toISOString(),
    );
    assert.equal(now.agreementVersionId, v2.version.id);
    assert.equal(now.mode, 'APPROVED_QTY');

    // A version WITHOUT a material basis fails closed (never falls
    // back to another version).
    const v3 = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p3-${randomUUID()}`,
    });
    assert.equal(
      await getHandymanMaterialPricingBasisForVersion(v3.version.id),
      null,
    );
    const f3 = Date.now() + 600_000;
    await supersedeHandymanCommercialAgreementVersion(adminUserId, {
      versionId: v2.version.id,
      replacementVersionId: v3.version.id,
      effectiveFrom: new Date(f3).toISOString(),
      idempotencyKey: `s2-${randomUUID()}`,
    });
    await assert.rejects(
      resolveHandymanMaterialPricingBasisAt(
        realm.client.id, new Date(f3).toISOString(),
      ),
      rejectsCode(
        ERROR_CODES.HANDYMAN_MATERIAL_PRICING_BASIS_NOT_EFFECTIVE,
      ),
    );
  });

  it('t5 replays idempotently and refuses mismatched payloads', async (t) => {
    if (!requireDatabase(t)) return;
    if (!pool) return;
    const realm = await realmFixture('CR-HM-12-P03-t5');
    const prepared = await draftAgreementVersion(realm.client.id);
    const key = `k-${randomUUID()}`;
    const first = await prepareHandymanMaterialPricingBasis(adminUserId, {
      agreementVersionId: prepared.version.id,
      mode: 'SETTLED_USAGE',
      idempotencyKey: key,
    });
    const replay = await prepareHandymanMaterialPricingBasis(adminUserId, {
      agreementVersionId: prepared.version.id,
      mode: 'APPROVED_QTY',
      idempotencyKey: key,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.basis.id, first.basis.id);
    assert.equal(replay.basis.mode, 'SETTLED_USAGE');

    const otherRealm = await realmFixture('CR-HM-12-P03-t5b');
    const other = await draftAgreementVersion(otherRealm.client.id);
    await assert.rejects(
      prepareHandymanMaterialPricingBasis(adminUserId, {
        agreementVersionId: other.version.id,
        mode: 'SETTLED_USAGE',
        idempotencyKey: key,
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_MATERIAL_PRICING_KEY_CONFLICT),
    );
    const rows = await q(
      `SELECT count(*)::int AS n FROM ${TABLE}
        WHERE agreement_version_id = $1`,
      [other.version.id],
    );
    assert.equal(rows.rows[0].n, 0);
  });

  it('t6 composes from the read-only seams and never writes upstream', async (t) => {
    if (!requireDatabase(t)) return;
    if (!pool) return;

    // Import allowlist: read-consumer edges only (CR-HM-06/09
    // published reads + PART 01 anchor); no sessions, no FM, no
    // SaaS platform modules, no HTTP.
    const dir = new URL('../src/modules/handyman-material-pricing/',
      import.meta.url);
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile()).map((e) => e.name);
    for (const file of files) {
      assert.doesNotMatch(file, /controller|routes|api|openapi|swagger/);
    }
    const ALLOWED_IMPORTS = /^(node:.+|pg|\.\.\/\.\.\/database$|\.\.\/\.\.\/shared\/errors$|\.\.\/clients$|\.\.\/handyman-commercial-agreements$|\.\.\/handyman-material-execution$|\.\.\/handyman-quotations$|\.\/handyman-material-pricing\.\w+$)/;
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(new URL(`./${file}`, dir), 'utf8');
      for (const m of source.matchAll(/from\s+'([^']+)'/g)) {
        assert.ok(ALLOWED_IMPORTS.test(m[1]),
          `${file}: forbidden import ${m[1]}`);
      }
    }

    const f = await settledScopeFixture();
    assert.ok(f.agreement);
    const versionId = f.agreement.versionId;

    // Basis before any definition exists: fail-closed at as-of.
    await assert.rejects(
      computeHandymanMaterialPricingBasisForScope(
        f.scope.id, new Date().toISOString(), f.leadUserId,
      ),
      rejectsCode(
        ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_EFFECTIVE_AT_AS_OF,
      ),
    );

    await prepareHandymanMaterialPricingBasis(adminUserId, {
      agreementVersionId: versionId,
      mode: 'SETTLED_USAGE',
      idempotencyKey: `b-${randomUUID()}`,
    });
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: `a-${randomUUID()}`,
    });

    const before = await tableCounts();
    const result = await computeHandymanMaterialPricingBasisForScope(
      f.scope.id, new Date().toISOString(), f.leadUserId,
    );
    const after = await tableCounts();
    for (const name of Object.keys(before)) {
      assert.deepEqual(after[name], before[name],
        `composition must never write ${name}`);
    }

    // Returned quantity is unused stock; 25.00 x used(3) = 75.00.
    assert.equal(result.basis.basisAmount, '75.00');
    assert.equal(result.basis.mode, 'SETTLED_USAGE');
    assert.equal(result.basis.lines.length, 1);
    assert.equal(result.basis.lines[0].appliedQty, 3);
    assert.equal(result.finalUsedByUom.length, 1);
    assert.equal(result.finalUsedByUom[0].quantity, 3);
    assert.equal(result.agreementVersionId, versionId);
    assert.equal(result.basis.currency, 'IDR');

    // APPROVED_QTY via supersession recomputes the basis to
    // 25.00 x approvedQty(4) = 100.00 on the SAME frozen inputs.
    const v2 = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: f.scope.clientId, idempotencyKey: `p2-${randomUUID()}`,
    });
    await prepareHandymanMaterialPricingBasis(adminUserId, {
      agreementVersionId: v2.version.id,
      mode: 'APPROVED_QTY',
      idempotencyKey: `b2-${randomUUID()}`,
    });
    const f2 = Date.now() + 5 * 60_000;
    await supersedeHandymanCommercialAgreementVersion(adminUserId, {
      versionId,
      replacementVersionId: v2.version.id,
      effectiveFrom: new Date(f2).toISOString(),
      idempotencyKey: `s-${randomUUID()}`,
    });
    const future = await computeHandymanMaterialPricingBasisForScope(
      f.scope.id, new Date(f2).toISOString(), f.leadUserId,
    );
    assert.equal(future.basis.basisAmount, '100.00');
    assert.equal(future.basis.mode, 'APPROVED_QTY');
    // Historical as-of still yields the frozen SETTLED_USAGE basis.
    const past = await computeHandymanMaterialPricingBasisForScope(
      f.scope.id, new Date(f2 - 1).toISOString(), f.leadUserId,
    );
    assert.equal(past.basis.basisAmount, '75.00');

    // Non-Lead actor: CR-HM-09 authority wall stays in force — the
    // composition NEVER bypasses read authority.
    const { userService } = await import('../src/modules/users');
    const outsider = await userService.createUser({
      email: `out-${randomUUID().slice(0, 8)}@example.com`,
      displayName: 'Not The Lead',
    });
    await assert.rejects(
      computeHandymanMaterialPricingBasisForScope(
        f.scope.id, new Date().toISOString(), outsider.id,
      ),
    );
  });
});
