import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { AppError, ERROR_CODES } from '../src/shared/errors';
import * as contractBarrel from '../src/modules/handyman-pricing-contract';
import {
  HANDYMAN_PRICING_CONTRACT_FACT_KIND,
  isHandymanPricingContractFactKind,
  readHandymanPricingContractAt,
  readHandymanLaborPricingEvaluationAt,
  readHandymanMaterialPricingCompositionAt,
  readHandymanBmFeeRuleConsumptionAt,
} from '../src/modules/handyman-pricing-contract';
import {
  prepareHandymanCommercialAgreement,
  activateHandymanCommercialAgreementVersion,
  supersedeHandymanCommercialAgreementVersion,
} from '../src/modules/handyman-commercial-agreements';
import { prepareHandymanLaborPricingBasis }
  from '../src/modules/handyman-labor-pricing';
import { prepareHandymanMaterialPricingBasis }
  from '../src/modules/handyman-material-pricing';
import { prepareHandymanBmFeeRule }
  from '../src/modules/handyman-bm-fee-rules';
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
 * CR-HM-12 PART 05 — published pricing/commercial READ CONTRACT +
 * frozen-firewall verification (FROZEN governance §10 row 05:
 * "Contracts for CR-HM-06/14/17 consumption; reference≠final and
 * no-SaaS-computation checks"; forbidden: new authority, second
 * write path, HTTP). Six focused cases.
 */

const MODULE_DIR = 'src/modules/handyman-pricing-contract';
const CONTRACT_TABLES = [
  'handyman_commercial_agreements',
  'handyman_commercial_agreement_versions',
  'handyman_commercial_agreement_events',
  'handyman_labor_pricing_basis_definitions',
  'handyman_material_pricing_basis_definitions',
  'handyman_bm_fee_rule_definitions',
];

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
    ${CONTRACT_TABLES.join(', ')},
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

async function tableCounts(): Promise<Record<string, number>> {
  const names = [
    ...CONTRACT_TABLES,
    'handyman_execution_scopes',
    'handyman_material_execution_lines',
    'handyman_quotation_lines',
  ];
  const out: Record<string, number> = {};
  for (const name of names) {
    const r = await q(`SELECT count(*)::int AS c FROM ${name}`);
    out[name] = r.rows[0].c;
  }
  return out;
}

function collectKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      acc.push(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

function moduleSources(dir: string): Record<string, string> {
  const strip = (raw: string) => raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith('.ts')) {
      out[name] = strip(readFileSync(`${dir}/${name}`, 'utf8'));
    }
  }
  return out;
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkTs(full, acc);
    else if (entry.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

async function draftAgreementVersion(clientId: string) {
  return prepareHandymanCommercialAgreement(adminUserId, {
    clientId, idempotencyKey: `p-${randomUUID()}`,
  });
}

async function activateVersion(versionId: string, offsetMs: number) {
  return activateHandymanCommercialAgreementVersion(adminUserId, {
    versionId,
    effectiveFrom: new Date(Date.now() + offsetMs).toISOString(),
    idempotencyKey: `a-${randomUUID()}`,
  });
}

function laborInput(over: Record<string, unknown> = {}) {
  return {
    mode: 'FIXED_SCOPE',
    // Frozen shape law: FIXED_SCOPE is a per-crew fixed scope fact.
    crewMode: 'PER_CREW',
    billableTimeBasis: null,
    unitAmount: '100.00',
    currency: 'IDR',
    idempotencyKey: `k-${randomUUID()}`,
    ...over,
  };
}

async function authorFullVersion(
  versionId: string,
  opts: {
    labor?: Array<Record<string, unknown>>;
    material?: 'SETTLED_USAGE' | 'APPROVED_QTY' | null;
    feeMode?: 'DEFAULT' | 'REFERENCE' | null;
  },
) {
  for (const over of opts.labor ?? [{}]) {
    await prepareHandymanLaborPricingBasis(adminUserId, {
      agreementVersionId: versionId,
      ...laborInput(over),
    });
  }
  if (opts.material) {
    await prepareHandymanMaterialPricingBasis(adminUserId, {
      agreementVersionId: versionId,
      mode: opts.material,
      idempotencyKey: `k-${randomUUID()}`,
    });
  }
  if (opts.feeMode) {
    await prepareHandymanBmFeeRule(adminUserId, {
      agreementVersionId: versionId,
      basis: 'LABOR_ONLY',
      mode: opts.feeMode,
      idempotencyKey: `k-${randomUUID()}`,
    });
  }
}

/** Full lawful CR-HM-09 chain (PART 03 pattern): AUTHORIZED scope
 * + Crew Lead + one MATERIAL snapshot line, lifecycle driven to
 * FINAL_CHARGE_READY with used 3 - returned 1 => finalUsed 2. */
async function settledScopeFixture() {
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
  const prepared = await draftAgreementVersion(f.scope.clientId);
  return {
    ...f,
    leadUserId: crew.leadUser.id,
    versionId: prepared.version.id,
  };
}

describe('CR-HM-12 PART 05 — published read contract', () => {
  it('t1 — frozen published surface: read family only, zero DB capability, unwired to HTTP', () => {
    const files = readdirSync(MODULE_DIR).sort();
    assert.deepEqual(files, [
      'handyman-pricing-contract.service.ts',
      'handyman-pricing-contract.types.ts',
      'index.ts',
    ]);

    // Exports: exactly the published read family — zero mutation
    // verbs anywhere in the surface.
    assert.deepEqual(Object.keys(contractBarrel).sort(), [
      'HANDYMAN_PRICING_CONTRACT_FACT_KIND',
      'isHandymanPricingContractFactKind',
      'readHandymanBmFeeRuleConsumptionAt',
      'readHandymanLaborPricingEvaluationAt',
      'readHandymanMaterialPricingCompositionAt',
      'readHandymanPricingContractAt',
    ]);
    for (const name of Object.keys(contractBarrel)) {
      assert.ok(
        !/prepare|activate|supersede|insert|update|delete|post|pay|refund|collect|invoice|settle|reconcile|cancel|mutate|write|record|compute|derive/i
          .test(name),
        `export ${name} must be read-family`,
      );
    }

    const sources = moduleSources(MODULE_DIR);
    for (const [name, src] of Object.entries(sources)) {
      const imports = [...src.matchAll(/from '([^']+)'/g)]
        .map((m) => m[1]);
      for (const p of imports) {
        assert.ok(
          /^(\.\/[^']+|\.\.\/clients$|\.\.\/handyman-(commercial-agreements|labor-pricing|material-pricing|bm-fee-rules)$)/
            .test(p),
          `${name}: forbidden import ${p}`,
        );
      }
      // Structural firewall: the contract imports no database
      // layer at all — it cannot write even by accident.
      assert.ok(
        !/\bfrom 'pg'|knex|getPool|withTransaction|PoolClient|initDatabase\b/
          .test(src),
        `${name}: contract must hold zero DB capability`,
      );
      assert.ok(
        !/\.insert\(|\.update\(|\.delete\(|\.del\(|\.raw\(|\.query\(|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b|\bCREATE TABLE\b/i
          .test(src),
        `${name}: contract must hold zero SQL surface`,
      );
      assert.ok(
        !/platform_subscriptions|platform_pricebooks|platform_billing|price-catalog|handyman_charge|ledger/i
          .test(src),
        `${name}: no SaaS/ledger surface even referenceable`,
      );
    }

    // No migration belongs to PART 05: no new table authority.
    const migrations = readdirSync('src/database/migrations')
      .filter((f) => parseInt(f, 10) >= 410);
    assert.deepEqual(migrations, []);

    // Unwired to HTTP: no file outside the module imports it.
    for (const file of walkTs('src')) {
      if (file.startsWith(MODULE_DIR)) continue;
      assert.ok(
        !readFileSync(file, 'utf8').includes('handyman-pricing-contract'),
        `${file}: contract must not be wired anywhere yet`,
      );
    }

    // The publication document exists and names the published reads.
    const doc = readFileSync(
      'docs/handyman/CR-HM-12_READ_CONTRACT.md', 'utf8',
    );
    for (const fn of [
      'readHandymanPricingContractAt',
      'readHandymanLaborPricingEvaluationAt',
      'readHandymanMaterialPricingCompositionAt',
      'readHandymanBmFeeRuleConsumptionAt',
    ]) {
      assert.ok(doc.includes(fn), `publication doc missing ${fn}`);
    }

    assert.equal(HANDYMAN_PRICING_CONTRACT_FACT_KIND, 'CR_HM_12_BASIS_FACT');
    assert.ok(isHandymanPricingContractFactKind('CR_HM_12_BASIS_FACT'));
    assert.ok(!isHandymanPricingContractFactKind('FINAL_CHARGE'));
  });

  it('t2 — v1 full bundle: exact-version anchor, frozen rule sets, firewall labels', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P05-t2');
    const prepared = await draftAgreementVersion(realm.client.id);
    await authorFullVersion(prepared.version.id, {
      labor: [
        { mode: 'HOURLY', crewMode: 'PER_CREW',
          billableTimeBasis: 'PRESENCE', unitAmount: '75.50' },
        { mode: 'FIXED_SCOPE', unitAmount: '150.00' },
      ],
      material: 'SETTLED_USAGE',
      feeMode: 'DEFAULT',
    });
    const activated = await activateVersion(prepared.version.id, -120_000);
    const asOf = new Date().toISOString();

    const before = await tableCounts();
    const bundle = await readHandymanPricingContractAt(realm.client.id, asOf);
    const after = await tableCounts();
    assert.deepEqual(after, before, 'contract read must write nothing');

    assert.deepEqual(bundle.binding, {
      clientId: realm.client.id,
      agreementId: activated.agreement.id,
      agreementVersionId: prepared.version.id,
      versionNumber: 1,
      status: 'ACTIVE',
      requestedAsOfUtc: asOf,
      effectiveFromUtc: activated.version.effectiveFrom.toISOString(),
      effectiveToUtc: null,
      factKind: 'CR_HM_12_BASIS_FACT',
    });

    // Frozen set of the exact version, deterministic order, every
    // row version-bound, every amount labeled basis fact.
    assert.equal(bundle.laborBasis.length, 2);
    assert.deepEqual(
      bundle.laborBasis.map((v) => [v.mode, v.crewMode, v.unitAmount]),
      [['FIXED_SCOPE', 'PER_CREW', '150.00'],
        ['HOURLY', 'PER_CREW', '75.50']],
    );
    for (const v of bundle.laborBasis) {
      assert.equal(v.agreementVersionId, prepared.version.id);
      assert.equal(v.isFinalCharge, false);
      assert.equal(v.currency, 'IDR');
    }
    assert.equal(bundle.laborBasis[0].billableTimeBasis, null);
    assert.equal(bundle.laborBasis[1].billableTimeBasis, 'PRESENCE');

    assert.ok(bundle.materialBasis);
    assert.equal(bundle.materialBasis.mode, 'SETTLED_USAGE');
    assert.equal(
      bundle.materialBasis.agreementVersionId, prepared.version.id,
    );
    assert.equal(bundle.materialBasis.isFinalCharge, false);

    assert.ok(bundle.bmFeeRule);
    assert.equal(bundle.bmFeeRule.basis, 'LABOR_ONLY');
    assert.equal(bundle.bmFeeRule.mode, 'DEFAULT');
    assert.equal(bundle.bmFeeRule.authoritativeForEntitlement, true);

    // No final-charge-shaped key exists anywhere in the bundle.
    for (const key of collectKeys(bundle)) {
      assert.ok(
        !/total|combined|grand|amountDue|ledger|payment|settl|billing|subscription|invoice|chargeId/i
          .test(key),
        `bundle key ${key} is final-charge-shaped`,
      );
    }
  });

  it('t3 — supersession switch is version-exact; REFERENCE ≠ final; history frozen', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P05-t3');
    const v1 = await draftAgreementVersion(realm.client.id);
    await authorFullVersion(v1.version.id, {
      labor: [{ unitAmount: '100.00' }],
      material: 'SETTLED_USAGE',
      feeMode: 'DEFAULT',
    });
    const f1 = Date.now() - 120_000;
    await activateVersion(v1.version.id, -120_000);

    const v2 = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id,
      idempotencyKey: `p2-${randomUUID()}`,
    });
    await authorFullVersion(v2.version.id, {
      labor: [
        { unitAmount: '300.00' },
        { mode: 'HOURLY', crewMode: 'PER_CREW',
          billableTimeBasis: 'ACTUAL_WORK', unitAmount: '90.25' },
      ],
      material: null,
      feeMode: 'REFERENCE',
    });
    const f2 = Date.now() - 60_000;
    await supersedeHandymanCommercialAgreementVersion(adminUserId, {
      versionId: v1.version.id,
      replacementVersionId: v2.version.id,
      effectiveFrom: new Date(f2).toISOString(),
      idempotencyKey: `s-${randomUUID()}`,
    });

    const current = await readHandymanPricingContractAt(
      realm.client.id, new Date().toISOString(),
    );
    assert.equal(current.binding.versionNumber, 2);
    assert.equal(current.binding.agreementVersionId, v2.version.id);
    assert.deepEqual(
      current.laborBasis.map((v) => [v.mode, v.unitAmount]),
      [['FIXED_SCOPE', '300.00'], ['HOURLY', '90.25']],
    );
    // Explicit absence — never inherited from v1, never defaulted.
    assert.equal(current.materialBasis, null);
    // reference ≠ final, machine-visible: the REFERENCE rule is
    // published but flagged NON-authoritative for entitlement.
    assert.ok(current.bmFeeRule);
    assert.equal(current.bmFeeRule.mode, 'REFERENCE');
    assert.equal(current.bmFeeRule.authoritativeForEntitlement, false);
    const consumption = await readHandymanBmFeeRuleConsumptionAt(
      realm.client.id, new Date().toISOString(),
    );
    assert.equal(consumption.rule.authoritativeForEntitlement, false);
    assert.equal(consumption.rule.agreementVersionId, v2.version.id);

    // Historical as-of reads the frozen v1 contract, unchanged.
    const past = await readHandymanPricingContractAt(
      realm.client.id, new Date((f1 + f2) / 2).toISOString(),
    );
    assert.equal(past.binding.versionNumber, 1);
    assert.equal(past.laborBasis.length, 1);
    assert.equal(past.laborBasis[0].unitAmount, '100.00');
    assert.equal(past.materialBasis?.mode, 'SETTLED_USAGE');
    assert.equal(past.bmFeeRule?.mode, 'DEFAULT');
    assert.equal(past.bmFeeRule?.authoritativeForEntitlement, true);

    // v1 rows are NOT visible through v2's contract, ever.
    for (const v of current.laborBasis) {
      assert.equal(v.agreementVersionId, v2.version.id);
    }
  });

  it('t4 — evaluation + composition published through the contract; scopes never borrow versions', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await settledScopeFixture();
    await authorFullVersion(f.versionId, {
      labor: [{ unitAmount: '200.00' }],
      material: 'SETTLED_USAGE',
      feeMode: null,
    });
    await activateVersion(f.versionId, -90_000);
    const asOf = new Date().toISOString();

    const quotationBefore = await q(
      `SELECT id, final_quoted_unit_amount, quantity
         FROM handyman_quotation_lines ORDER BY id`,
    );
    const executionBefore = await q(
      `SELECT id, status, issued_qty, used_qty, returned_qty
         FROM handyman_material_execution_lines ORDER BY id`,
    );

    const evaluated = await readHandymanLaborPricingEvaluationAt(
      f.scope.clientId, asOf, 'FIXED_SCOPE', { crewHeadcount: 3 },
    );
    // FIXED_SCOPE is fixed per scope: headcount applies to HOURLY/
    // VISIT_FEE only (PART 02 law) — no multiplier here.
    assert.equal(evaluated.evaluation.basisAmount, '200.00');
    // PER_CREW: heads are counted as one crew regardless of input.
    assert.equal(evaluated.evaluation.appliedHeads, 1);
    assert.equal(evaluated.evaluation.crewMode, 'PER_CREW');
    assert.equal(evaluated.basisRowId.length, 36);
    assert.equal(evaluated.binding.agreementVersionId, f.versionId);
    assert.equal(evaluated.factKind, 'CR_HM_12_BASIS_FACT');
    assert.equal(evaluated.isFinalCharge, false);

    const composed = await readHandymanMaterialPricingCompositionAt(
      f.scope.clientId, f.scope.id, asOf, f.leadUserId,
    );
    assert.equal(composed.executionScopeId, f.scope.id);
    assert.equal(composed.composition.totalFinalUsedQty, 2);
    assert.equal(composed.composition.basis.basisAmount, '50.00');
    assert.equal(composed.composition.agreementVersionId, f.versionId);
    assert.equal(composed.binding.agreementVersionId, f.versionId);
    assert.equal(composed.isFinalCharge, false);
    assert.equal(composed.mergedWithLabor, false);

    // Frozen firewalls: CR-HM-09 execution and CR-HM-06 approved
    // snapshot are read-only inputs of the contract — byte-identical.
    const quotationAfter = await q(
      `SELECT id, final_quoted_unit_amount, quantity
         FROM handyman_quotation_lines ORDER BY id`,
    );
    const executionAfter = await q(
      `SELECT id, status, issued_qty, used_qty, returned_qty
         FROM handyman_material_execution_lines ORDER BY id`,
    );
    assert.deepEqual(quotationAfter.rows, quotationBefore.rows);
    assert.deepEqual(executionAfter.rows, executionBefore.rows);

    // Another client's contract never borrows this scope's facts:
    // scope version vs caller version must match exactly.
    const other = await realmFixture('CR-HM-12-P05-t4x');
    const otherDraft = await draftAgreementVersion(other.client.id);
    await activateVersion(otherDraft.version.id, -10_000);
    const foreignAsOf = new Date(Date.now() - 5_000).toISOString();
    await assert.rejects(
      readHandymanMaterialPricingCompositionAt(
        other.client.id, f.scope.id, foreignAsOf, f.leadUserId,
      ),
      rejectsCode(ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VALIDATION),
    );

    // Fail-closed vocabulary: undefined mode on the effective
    // version is a bounded NOT_EFFECTIVE, never a silent default.
    await assert.rejects(
      readHandymanLaborPricingEvaluationAt(
        f.scope.clientId, asOf, 'VISIT_FEE', { crewHeadcount: 1 },
      ),
      rejectsCode(ERROR_CODES.HANDYMAN_LABOR_PRICING_BASIS_NOT_EFFECTIVE),
    );
    await assert.rejects(
      readHandymanLaborPricingEvaluationAt(
        f.scope.clientId, asOf, 'PER_DIEM', { crewHeadcount: 1 },
      ),
      rejectsCode(ERROR_CODES.HANDYMAN_LABOR_PRICING_VALIDATION),
    );
  });

  it('t5 — fail-closed postures inherited: anchor-first, absent slots, malformed input', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P05-t5');
    const prepared = await draftAgreementVersion(realm.client.id);
    await authorFullVersion(prepared.version.id, {
      labor: [{ unitAmount: '40.00' }],
      material: null,
      feeMode: null,
    });

    // DRAFT-only: nothing effective -> the PART 01 anchor refuses.
    await assert.rejects(
      readHandymanPricingContractAt(
        realm.client.id, new Date().toISOString(),
      ),
      rejectsCode(
        ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_EFFECTIVE_AT_AS_OF,
      ),
    );
    await assert.rejects(
      readHandymanBmFeeRuleConsumptionAt(
        realm.client.id, new Date().toISOString(),
      ),
      rejectsCode(
        ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_EFFECTIVE_AT_AS_OF,
      ),
    );

    await activateVersion(prepared.version.id, -120_000);
    const asOf = new Date().toISOString();

    // Published dual posture: the BUNDLE shows explicit absence for
    // the missing rule/material slots, while the entitlement
    // CONSUMPTION read fails closed — never a silent default.
    const bundle = await readHandymanPricingContractAt(realm.client.id, asOf);
    assert.equal(bundle.bmFeeRule, null);
    assert.equal(bundle.materialBasis, null);
    await assert.rejects(
      readHandymanBmFeeRuleConsumptionAt(realm.client.id, asOf),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_RULE_NOT_EFFECTIVE),
    );

    // Unknown scope through the composition read: bounded failure
    // from PART 03, propagated unchanged by the contract.
    await assert.rejects(
      readHandymanMaterialPricingCompositionAt(
        realm.client.id, randomUUID(), asOf, adminUserId,
      ),
      rejectsCode(ERROR_CODES.HANDYMAN_MATERIAL_PRICING_COMPOSITION_ERROR),
    );

    // Malformed inputs are validation errors, fail-closed, before
    // any resolution happens.
    await assert.rejects(
      readHandymanPricingContractAt('not-a-uuid', asOf),
      rejectsCode(ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VALIDATION),
    );
    await assert.rejects(
      readHandymanPricingContractAt(realm.client.id, 'not-a-timestamp'),
      rejectsCode(ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VALIDATION),
    );
    await assert.rejects(
      readHandymanMaterialPricingCompositionAt(
        realm.client.id, randomUUID(), asOf, 'bad-actor',
      ),
      rejectsCode(ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VALIDATION),
    );
  });

  it('t6 — no second write path: deterministic reads over a byte-stable database', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P05-t6');
    const prepared = await draftAgreementVersion(realm.client.id);
    await authorFullVersion(prepared.version.id, {
      labor: [{ unitAmount: '210.00' },
        { mode: 'HOURLY', crewMode: 'PER_CREW',
          billableTimeBasis: 'PRESENCE', unitAmount: '60.00' }],
      material: 'APPROVED_QTY',
      feeMode: 'DEFAULT',
    });
    await activateVersion(prepared.version.id, -120_000);

    const asOf = new Date(Date.now() - 60_000).toISOString();
    const battery = async () => {
      return {
        bundle: await readHandymanPricingContractAt(realm.client.id, asOf),
        hourly: await readHandymanLaborPricingEvaluationAt(
          realm.client.id, asOf, 'HOURLY',
          { billableMinutes: 90, crewHeadcount: 4 },
        ),
        fixed: await readHandymanLaborPricingEvaluationAt(
          realm.client.id, asOf, 'FIXED_SCOPE', { crewHeadcount: 2 },
        ),
        rule: await readHandymanBmFeeRuleConsumptionAt(
          realm.client.id, asOf,
        ),
      };
    };

    const before = await tableCounts();
    const first = await battery();
    const second = await battery();
    const after = await tableCounts();

    // Determinism: the same as-of yields the identical contract.
    assert.deepEqual(second, first);
    assert.equal(first.hourly.evaluation.basisAmount, '90.00');
    assert.equal(first.fixed.evaluation.basisAmount, '210.00');
    assert.equal(first.bundle.bmFeeRule?.authoritativeForEntitlement, true);

    // No second write path: every contract table byte-stable.
    for (const name of Object.keys(before)) {
      assert.deepEqual(after[name], before[name],
        `contract reads must never write ${name}`);
    }
    // Reads never advance the append-only event trail either.
    const events = await q(
      `SELECT count(*)::int AS c FROM handyman_commercial_agreement_events`,
    );
    const drafts = await q(
      `SELECT count(*)::int AS c
         FROM handyman_commercial_agreement_versions
        WHERE status = 'DRAFT'`,
    );
    assert.ok(events.rows[0].c >= 2);
    assert.equal(drafts.rows[0].c, 0, 'reads never open or revive drafts');
  });
});
