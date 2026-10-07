import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { AppError, ERROR_CODES } from '../src/shared/errors';
import * as bmFeeBarrel from '../src/modules/handyman-bm-fee-rules';
import {
  HANDYMAN_BM_FEE_BENEFICIARY_KINDS,
  HANDYMAN_BM_FEE_TERM_KINDS,
  getHandymanBmFeeBeneficiaryForVersion,
  getHandymanBmFeeTermForVersion,
  isHandymanBmFeeBeneficiaryKind,
  isHandymanBmFeeTermKind,
  prepareHandymanBmFeeBeneficiary,
  prepareHandymanBmFeeRule,
  prepareHandymanBmFeeTerm,
} from '../src/modules/handyman-bm-fee-rules';
import * as pricingBarrel from '../src/modules/handyman-pricing-contract';
import {
  HANDYMAN_PRICING_CONTRACT_BM_FEE_UNCONFIGURED_SLOTS,
  HANDYMAN_PRICING_CONTRACT_FACT_KIND,
  readHandymanBmFeeConfigurationAt,
  readHandymanBmFeeRuleConsumptionAt,
} from '../src/modules/handyman-pricing-contract';
import {
  activateHandymanCommercialAgreementVersion,
  prepareHandymanCommercialAgreement,
  supersedeHandymanCommercialAgreementVersion,
} from '../src/modules/handyman-commercial-agreements';
import { createAdminUser } from './helpers/access';
import { initHandymanFixtures, realmFixture }
  from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-12 PART 06B — BM fee TERM + BENEFICIARY authoring and the
 * fail-closed configuration read (FROZEN
 * `CR-HM-12_PART_06_BM_FEE_PREREQUISITE.md` §4/§5/§6), authorized by
 * `CR-HM-14_PREREQUISITE_DECISION_BM_FEE.md` §2/§3/§5.
 *
 * Six focused cases: frozen vocabularies + additive-only published
 * surface, term authoring law, beneficiary authoring law, the
 * fail-closed configuration read (explicit nulls, unconfiguredSlots,
 * gate), PART 05 read compatibility, and the firewall/source sweep.
 * NO fee-value math, NO entitlement/settlement, NO ledger, NO SaaS/FM
 * state is exercised or represented anywhere.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE handyman_bm_fee_term_definitions,
       handyman_bm_fee_beneficiary_definitions,
       handyman_bm_fee_rule_definitions,
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

function rejectsCode(code: string) {
  return (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError ${code}`);
    assert.equal(err.code, code);
    return true;
  };
}

async function draftVersion(clientId: string) {
  return prepareHandymanCommercialAgreement(adminUserId, {
    clientId, idempotencyKey: `p-${randomUUID()}`,
  });
}

function termInput(over: Record<string, unknown> = {}) {
  return {
    termKind: 'PERCENTAGE_OF_BASIS',
    ratePercent: '2.5',
    idempotencyKey: `t-${randomUUID()}`,
    ...over,
  };
}

function beneficiaryInput(referenceId: string, over = {}) {
  return {
    beneficiaryKind: 'CLIENT_ORGANIZATION',
    beneficiaryReferenceId: referenceId,
    idempotencyKey: `b-${randomUUID()}`,
    ...over,
  };
}

/** Configure a version fully (rule + term + beneficiary) while DRAFT. */
async function configureVersion(versionId: string, clientId: string) {
  await prepareHandymanBmFeeRule(adminUserId, {
    agreementVersionId: versionId,
    basis: 'LABOR_ONLY',
    mode: 'DEFAULT',
    idempotencyKey: `r-${randomUUID()}`,
  });
  await prepareHandymanBmFeeTerm(adminUserId, {
    agreementVersionId: versionId, ...termInput(),
  });
  await prepareHandymanBmFeeBeneficiary(
    adminUserId,
    { agreementVersionId: versionId, ...beneficiaryInput(clientId) },
  );
}

describe('CR-HM-12 PART 06B BM fee term/beneficiary authoring + read', () => {
  it('t1 freezes the new vocabularies and adds only read/data surface', () => {
    assert.deepEqual([...HANDYMAN_BM_FEE_TERM_KINDS], [
      'PERCENTAGE_OF_BASIS',
    ]);
    assert.deepEqual([...HANDYMAN_BM_FEE_BENEFICIARY_KINDS], [
      'CLIENT_ORGANIZATION',
    ]);
    assert.equal(isHandymanBmFeeTermKind('PERCENTAGE_OF_BASIS'), true);
    assert.equal(isHandymanBmFeeTermKind('FLAT_AMOUNT'), false);
    assert.equal(isHandymanBmFeeBeneficiaryKind('CLIENT_ORGANIZATION'), true);
    assert.equal(isHandymanBmFeeBeneficiaryKind('BM_ENTITY'), false);
    assert.deepEqual(
      [...HANDYMAN_PRICING_CONTRACT_BM_FEE_UNCONFIGURED_SLOTS],
      ['TERM', 'BENEFICIARY'],
    );

    // The BM fee barrel publishes authoring + exact reads ONLY: no
    // evaluation/derivation/valuation verb exists anywhere.
    const FORBIDDEN_EXPORT =
      /evaluate|derive|compute|calculate|percent|amount|value|rate|collect|invoice|ledger|settle|reconcil|subscription|billing/i;
    for (const name of Object.keys(bmFeeBarrel)) {
      assert.doesNotMatch(name, FORBIDDEN_EXPORT,
        `forbidden exported surface: ${name}`);
    }
    // The mandated authoring + read family is present.
    for (const name of [
      'prepareHandymanBmFeeTerm',
      'prepareHandymanBmFeeBeneficiary',
      'getHandymanBmFeeTermForVersion',
      'getHandymanBmFeeBeneficiaryForVersion',
    ]) {
      assert.ok(name in bmFeeBarrel, `missing export ${name}`);
    }

    // The configuration read is additive; every previously published
    // read remains exported and callable.
    for (const name of [
      'readHandymanPricingContractAt',
      'readHandymanLaborPricingEvaluationAt',
      'readHandymanMaterialPricingCompositionAt',
      'readHandymanBmFeeRuleConsumptionAt',
      'readHandymanBmFeeConfigurationAt',
    ]) {
      assert.equal(typeof (pricingBarrel as Record<string, unknown>)[name],
        'function', `missing read ${name}`);
    }

    // PART 06B adds NO new module file and NO migration.
    const files = readdirSync(
      new URL('../src/modules/handyman-bm-fee-rules/', import.meta.url),
    ).sort();
    assert.deepEqual(files, [
      'handyman-bm-fee-rule.errors.ts',
      'handyman-bm-fee-rule.repository.ts',
      'handyman-bm-fee-rule.service.ts',
      'handyman-bm-fee-rule.types.ts',
      'index.ts',
    ]);
    const migrations = readdirSync('src/database/migrations')
      .filter((f) => parseInt(f, 10) >= 416);
    assert.deepEqual(migrations, []);
  });

  it('t2 authors one term per version, DRAFT-only, canonical rate', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P06B-t2');
    const prepared = await draftVersion(realm.client.id);
    const versionId = prepared.version.id;

    const first = await prepareHandymanBmFeeTerm(adminUserId, {
      agreementVersionId: versionId, ...termInput({ ratePercent: '2.5' }),
    });
    assert.equal(first.replayed, false);
    assert.equal(first.term.termKind, 'PERCENTAGE_OF_BASIS');
    // Canonical decimal STRING (4 decimals), never a float.
    assert.equal(first.term.ratePercent, '2.5000');
    assert.equal(typeof first.term.ratePercent, 'string');

    // Exactly ONE term per agreement version.
    await assert.rejects(
      prepareHandymanBmFeeTerm(adminUserId, {
        agreementVersionId: versionId, ...termInput(),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_TERM_ALREADY_DEFINED),
    );

    // Rate law: (0, 100] at the frozen 4-decimal scale.
    for (const bad of [
      '0', '-1', '100.0001', '1e2', '2.50000', '', 'abc', '1.2.3',
      '  ', '+2.5', NaN, 2.5, null,
    ]) {
      await assert.rejects(
        prepareHandymanBmFeeTerm(adminUserId, {
          agreementVersionId: versionId, ...termInput({ ratePercent: bad }),
        }),
        rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_TERM_VALIDATION),
        `rate ${String(bad)} must be refused`,
      );
    }
    // Unknown kind and unknown version are bounded refusals.
    await assert.rejects(
      prepareHandymanBmFeeTerm(adminUserId, {
        agreementVersionId: versionId, ...termInput({ termKind: 'FLAT' }),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_TERM_VALIDATION),
    );
    await assert.rejects(
      prepareHandymanBmFeeTerm(adminUserId, {
        agreementVersionId: randomUUID(), ...termInput(),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VERSION_NOT_FOUND),
    );

    // Frozen once effective; revision = a NEW version.
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: `a-${randomUUID()}`,
    });
    await assert.rejects(
      prepareHandymanBmFeeTerm(adminUserId, {
        agreementVersionId: versionId, ...termInput(),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_TERM_VERSION_NOT_DRAFT),
    );

    // A sibling DRAFT version authors its own term, and the exact
    // read returns the frozen canonical rate (never "latest").
    const v2 = await draftVersion(realm.client.id);
    await prepareHandymanBmFeeTerm(adminUserId, {
      agreementVersionId: v2.version.id,
      ...termInput({ ratePercent: '100' }),
    });
    const readV2 = await getHandymanBmFeeTermForVersion(v2.version.id);
    assert.equal(readV2?.ratePercent, '100.0000');
    const readV1 = await getHandymanBmFeeTermForVersion(versionId);
    assert.equal(readV1?.ratePercent, '2.5000');
    const fresh = await draftVersion(realm.client.id);
    assert.equal(
      await getHandymanBmFeeTermForVersion(fresh.version.id), null,
    );

    // Idempotent replay returns the SAME row; a conflicting replay
    // (same key, different rate) is a bounded conflict and writes
    // nothing.
    const v3 = await draftVersion(realm.client.id);
    const key = `t-${randomUUID()}`;
    const authored = await prepareHandymanBmFeeTerm(adminUserId, {
      agreementVersionId: v3.version.id,
      ...termInput({ ratePercent: '3.75', idempotencyKey: key }),
    });
    const replay = await prepareHandymanBmFeeTerm(adminUserId, {
      agreementVersionId: v3.version.id,
      ...termInput({ ratePercent: '3.7500', idempotencyKey: key }),
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.term.id, authored.term.id);
    assert.equal(replay.term.ratePercent, '3.7500');
    await assert.rejects(
      prepareHandymanBmFeeTerm(adminUserId, {
        agreementVersionId: v3.version.id,
        ...termInput({ ratePercent: '9.9', idempotencyKey: key }),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_TERM_KEY_CONFLICT),
    );
    const rows = await q(
      `SELECT count(*)::int AS n FROM handyman_bm_fee_term_definitions
        WHERE agreement_version_id = $1`,
      [v3.version.id],
    );
    assert.equal(rows.rows[0].n, 1);
  });

  it('t3 binds the beneficiary to the version client, DRAFT-only', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P06B-t3');
    const foreign = await realmFixture('CR-HM-12-P06B-t3b');
    const prepared = await draftVersion(realm.client.id);
    const versionId = prepared.version.id;

    const first = await prepareHandymanBmFeeBeneficiary(adminUserId, {
      agreementVersionId: versionId,
      ...beneficiaryInput(realm.client.id),
    });
    assert.equal(first.replayed, false);
    assert.equal(first.beneficiary.beneficiaryKind, 'CLIENT_ORGANIZATION');
    assert.equal(first.beneficiary.beneficiaryReferenceId, realm.client.id);

    // Exactly ONE beneficiary per version.
    await assert.rejects(
      prepareHandymanBmFeeBeneficiary(adminUserId, {
        agreementVersionId: versionId,
        ...beneficiaryInput(realm.client.id),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_BENEFICIARY_ALREADY_DEFINED),
    );

    // No client/channel inference: only the version's OWN client is
    // representable (a foreign client / arbitrary uuid is refused
    // before any row lands).
    await assert.rejects(
      prepareHandymanBmFeeBeneficiary(adminUserId, {
        agreementVersionId: versionId,
        ...beneficiaryInput(foreign.client.id),
      }),
      rejectsCode(
        ERROR_CODES.HANDYMAN_BM_FEE_BENEFICIARY_CLIENT_MISMATCH,
      ),
    );
    await assert.rejects(
      prepareHandymanBmFeeBeneficiary(adminUserId, {
        agreementVersionId: versionId,
        ...beneficiaryInput(randomUUID()),
      }),
      rejectsCode(
        ERROR_CODES.HANDYMAN_BM_FEE_BENEFICIARY_CLIENT_MISMATCH,
      ),
    );
    // Unknown kind / unknown version / bad key are bounded.
    await assert.rejects(
      prepareHandymanBmFeeBeneficiary(adminUserId, {
        agreementVersionId: versionId,
        ...beneficiaryInput(realm.client.id, { beneficiaryKind: 'BM_ENTITY' }),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_BENEFICIARY_VALIDATION),
    );
    await assert.rejects(
      prepareHandymanBmFeeBeneficiary(adminUserId, {
        agreementVersionId: randomUUID(),
        ...beneficiaryInput(realm.client.id),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VERSION_NOT_FOUND),
    );
    await assert.rejects(
      prepareHandymanBmFeeBeneficiary(adminUserId, {
        agreementVersionId: versionId,
        ...beneficiaryInput(realm.client.id, {
          idempotencyKey: ' '.repeat(201),
        }),
      }),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_BENEFICIARY_VALIDATION),
    );

    // Frozen once effective.
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: `a-${randomUUID()}`,
    });
    await assert.rejects(
      prepareHandymanBmFeeBeneficiary(adminUserId, {
        agreementVersionId: versionId,
        ...beneficiaryInput(realm.client.id),
      }),
      rejectsCode(
        ERROR_CODES.HANDYMAN_BM_FEE_BENEFICIARY_VERSION_NOT_DRAFT,
      ),
    );

    // Exact read + replay on a fresh DRAFT version.
    const v2 = await draftVersion(realm.client.id);
    const key = `b-${randomUUID()}`;
    const authored = await prepareHandymanBmFeeBeneficiary(adminUserId, {
      agreementVersionId: v2.version.id,
      ...beneficiaryInput(realm.client.id, { idempotencyKey: key }),
    });
    const replay = await prepareHandymanBmFeeBeneficiary(adminUserId, {
      agreementVersionId: v2.version.id,
      ...beneficiaryInput(realm.client.id, { idempotencyKey: key }),
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.beneficiary.id, authored.beneficiary.id);
    await assert.rejects(
      prepareHandymanBmFeeBeneficiary(adminUserId, {
        agreementVersionId: v2.version.id,
        ...beneficiaryInput(foreign.client.id, { idempotencyKey: key }),
      }),
      rejectsCode(
        ERROR_CODES.HANDYMAN_BM_FEE_BENEFICIARY_KEY_CONFLICT,
      ),
    );
    const exact = await getHandymanBmFeeBeneficiaryForVersion(v2.version.id);
    assert.equal(exact?.beneficiaryReferenceId, realm.client.id);
    const empty = await draftVersion(realm.client.id);
    assert.equal(
      await getHandymanBmFeeBeneficiaryForVersion(empty.version.id), null,
    );
  });

  it('t4 fails closed when a slot is unconfigured, never defaulting', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P06B-t4');
    const prepared = await draftVersion(realm.client.id);
    const f1 = Date.now() - 120_000;

    // No effective version yet: the PART 01 anchor fails closed FIRST.
    await assert.rejects(
      readHandymanBmFeeConfigurationAt(
        realm.client.id, new Date(f1).toISOString(),
      ),
      rejectsCode(
        ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_EFFECTIVE_AT_AS_OF,
      ),
    );

    // An effective version with NO rule keeps the EXISTING bounded
    // refusal (compatibility with PART 05 consumers).
    const bare = await draftVersion(realm.client.id);
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: bare.version.id,
      effectiveFrom: new Date(f1).toISOString(),
      idempotencyKey: `a-${randomUUID()}`,
    });
    await assert.rejects(
      readHandymanBmFeeConfigurationAt(
        realm.client.id, new Date(f1 + 1000).toISOString(),
      ),
      rejectsCode(ERROR_CODES.HANDYMAN_BM_FEE_RULE_NOT_EFFECTIVE),
    );

    // Rule only: BOTH slots are explicit nulls, listed, and the
    // configuration is NON-authoritative — never a default rate or
    // payee, never zero, never the reference model.
    const partial = await draftVersion(realm.client.id);
    await prepareHandymanBmFeeRule(adminUserId, {
      agreementVersionId: partial.version.id,
      basis: 'LABOR_ONLY',
      mode: 'DEFAULT',
      idempotencyKey: `r-${randomUUID()}`,
    });
    const f2 = Date.now() - 60_000;
    await supersedeHandymanCommercialAgreementVersion(adminUserId, {
      versionId: bare.version.id,
      replacementVersionId: partial.version.id,
      effectiveFrom: new Date(f2).toISOString(),
      idempotencyKey: `s-${randomUUID()}`,
    });
    const unconfigured = await readHandymanBmFeeConfigurationAt(
      realm.client.id, new Date(f2 + 1000).toISOString(),
    );
    assert.equal(unconfigured.term, null);
    assert.equal(unconfigured.beneficiary, null);
    // Sorted subset of the frozen slot vocabulary.
    assert.deepEqual(unconfigured.unconfiguredSlots, [
      'BENEFICIARY', 'TERM',
    ]);
    assert.equal(unconfigured.authoritativeForEntitlement, false);
    assert.equal(unconfigured.factKind, HANDYMAN_PRICING_CONTRACT_FACT_KIND);
    assert.equal(unconfigured.isFinalCharge, false);
    assert.equal(unconfigured.binding.agreementVersionId, partial.version.id);

    // A term WITHOUT a beneficiary (authored while DRAFT): only the
    // missing slot is listed and the configuration stays
    // non-authoritative.
    const halfVersion = await draftVersion(realm.client.id);
    await prepareHandymanBmFeeRule(adminUserId, {
      agreementVersionId: halfVersion.version.id,
      basis: 'LABOR_ONLY',
      mode: 'DEFAULT',
      idempotencyKey: `r-${randomUUID()}`,
    });
    await prepareHandymanBmFeeTerm(adminUserId, {
      agreementVersionId: halfVersion.version.id,
      ...termInput({ ratePercent: '1.25' }),
    });
    const f2b = Date.now() - 30_000;
    await supersedeHandymanCommercialAgreementVersion(adminUserId, {
      versionId: partial.version.id,
      replacementVersionId: halfVersion.version.id,
      effectiveFrom: new Date(f2b).toISOString(),
      idempotencyKey: `s1-${randomUUID()}`,
    });
    const half = await readHandymanBmFeeConfigurationAt(
      realm.client.id, new Date(f2b + 1000).toISOString(),
    );
    assert.equal(half.term?.ratePercent, '1.2500');
    assert.equal(half.beneficiary, null);
    assert.deepEqual(half.unconfiguredSlots, ['BENEFICIARY']);
    assert.equal(half.authoritativeForEntitlement, false);

    // Fully configured on a NEW version: authoritative, empty slots,
    // exact version binding (never "latest").
    const full = await draftVersion(realm.client.id);
    await configureVersion(full.version.id, realm.client.id);
    const f3 = Date.now() + 5 * 60_000;
    await supersedeHandymanCommercialAgreementVersion(adminUserId, {
      versionId: halfVersion.version.id,
      replacementVersionId: full.version.id,
      effectiveFrom: new Date(f3).toISOString(),
      idempotencyKey: `s2-${randomUUID()}`,
    });
    const configured = await readHandymanBmFeeConfigurationAt(
      realm.client.id, new Date(f3 + 1000).toISOString(),
    );
    assert.deepEqual(configured.unconfiguredSlots, []);
    assert.equal(configured.authoritativeForEntitlement, true);
    assert.equal(configured.term?.termKind, 'PERCENTAGE_OF_BASIS');
    assert.equal(configured.term?.ratePercent, '2.5000');
    assert.equal(configured.term?.agreementVersionId, full.version.id);
    assert.equal(
      configured.beneficiary?.beneficiaryReferenceId, realm.client.id,
    );
    assert.equal(
      configured.beneficiary?.beneficiaryKind, 'CLIENT_ORGANIZATION',
    );
    // Historical as-of still resolves the FROZEN half-configured
    // version — version-exact history, never "latest".
    const historical = await readHandymanBmFeeConfigurationAt(
      realm.client.id, new Date(f3 - 1).toISOString(),
    );
    assert.equal(
      historical.binding.agreementVersionId, halfVersion.version.id,
    );
    assert.equal(historical.term?.ratePercent, '1.2500');
    assert.equal(historical.beneficiary, null);
    assert.equal(historical.authoritativeForEntitlement, false);
    assert.equal(historical.authoritativeForEntitlement, false);

    // A REFERENCE rule never becomes authoritative, even when both
    // prerequisite slots exist.
    const reference = await draftVersion(realm.client.id);
    await prepareHandymanBmFeeRule(adminUserId, {
      agreementVersionId: reference.version.id,
      basis: 'LABOR_ONLY',
      mode: 'REFERENCE',
      idempotencyKey: `r-${randomUUID()}`,
    });
    await prepareHandymanBmFeeTerm(adminUserId, {
      agreementVersionId: reference.version.id, ...termInput(),
    });
    await prepareHandymanBmFeeBeneficiary(adminUserId, {
      agreementVersionId: reference.version.id,
      ...beneficiaryInput(realm.client.id),
    });
    const f4 = Date.now() + 10 * 60_000;
    await supersedeHandymanCommercialAgreementVersion(adminUserId, {
      versionId: full.version.id,
      replacementVersionId: reference.version.id,
      effectiveFrom: new Date(f4).toISOString(),
      idempotencyKey: `s3-${randomUUID()}`,
    });
    const refRead = await readHandymanBmFeeConfigurationAt(
      realm.client.id, new Date(f4 + 1000).toISOString(),
    );
    assert.equal(refRead.rule.mode, 'REFERENCE');
    assert.equal(refRead.rule.authoritativeForEntitlement, false);
    assert.deepEqual(refRead.unconfiguredSlots, []);
    assert.equal(refRead.authoritativeForEntitlement, false);
  });

  it('t5 keeps the PART 05 read byte-compatible and composite', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture('CR-HM-12-P06B-t5');
    const prepared = await draftVersion(realm.client.id);
    const f1 = Date.now() - 60_000;
    await configureVersion(prepared.version.id, realm.client.id);
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      effectiveFrom: new Date(f1).toISOString(),
      idempotencyKey: `a-${randomUUID()}`,
    });
    const asOf = new Date(f1 + 1000).toISOString();

    // The existing consumption read is UNCHANGED: same keys, same
    // authority semantics (DEFAULT => true), no rate/payee added.
    const consumption = await readHandymanBmFeeRuleConsumptionAt(
      realm.client.id, asOf,
    );
    assert.deepEqual(Object.keys(consumption).sort(), ['binding', 'rule']);
    assert.deepEqual(Object.keys(consumption.rule).sort(), [
      'agreementVersionId', 'authoritativeForEntitlement', 'basis',
      'factKind', 'mode', 'ruleRowId',
    ]);
    assert.equal(consumption.rule.authoritativeForEntitlement, true);
    assert.equal(consumption.rule.basis, 'LABOR_ONLY');
    assert.equal(
      consumption.rule.agreementVersionId, prepared.version.id,
    );

    // The new configuration read composes the same binding + rule
    // view (no divergence) and only ADDS the prerequisite data.
    const configuration = await readHandymanBmFeeConfigurationAt(
      realm.client.id, asOf,
    );
    assert.deepEqual(configuration.binding, consumption.binding);
    assert.deepEqual(configuration.rule, consumption.rule);
    assert.deepEqual(Object.keys(configuration).sort(), [
      'authoritativeForEntitlement', 'beneficiary', 'binding', 'factKind',
      'isFinalCharge', 'rule', 'term', 'unconfiguredSlots',
    ]);
    // No amount/value/currency key exists anywhere in the published
    // configuration (data only — the VALUE is CR-HM-14's).
    const FORBIDDEN_KEY =
      /amount|total|balance|settle|payout|currency|invoice|ledger|payment/i;
    for (const key of Object.keys(configuration)) {
      assert.doesNotMatch(key, FORBIDDEN_KEY, `forbidden key ${key}`);
    }
    for (const key of Object.keys(configuration.term ?? {})) {
      assert.doesNotMatch(key, FORBIDDEN_KEY, `forbidden term key ${key}`);
    }

    // Reads write nothing (both surfaces, repeated).
    const before = await q(
      `SELECT (SELECT count(*) FROM handyman_bm_fee_rule_definitions)
              + (SELECT count(*) FROM handyman_bm_fee_term_definitions)
              + (SELECT count(*) FROM
                   handyman_bm_fee_beneficiary_definitions) AS n`,
    );
    await readHandymanBmFeeConfigurationAt(realm.client.id, asOf);
    await readHandymanBmFeeRuleConsumptionAt(realm.client.id, asOf);
    const after = await q(
      `SELECT (SELECT count(*) FROM handyman_bm_fee_rule_definitions)
              + (SELECT count(*) FROM handyman_bm_fee_term_definitions)
              + (SELECT count(*) FROM
                   handyman_bm_fee_beneficiary_definitions) AS n`,
    );
    assert.deepEqual(after.rows, before.rows);
  });

  it('t6 holds no valuation, ledger, SaaS/FM, or HTTP surface', async (t) => {
    if (!requireDatabase(t)) return;

    const bmDir = new URL('../src/modules/handyman-bm-fee-rules/',
      import.meta.url);
    const contractDir = new URL('../src/modules/handyman-pricing-contract/',
      import.meta.url);
    const sources = (dir: URL) => readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => [f, readFileSync(new URL(`./${f}`, dir), 'utf8')] as const);

    // No controller/routes/HTTP anywhere in either module.
    for (const dir of [bmDir, contractDir]) {
      for (const file of readdirSync(dir)) {
        assert.doesNotMatch(file, /controller|routes|api|openapi|swagger/);
      }
    }

    // The contract module still holds ZERO DB capability and ZERO
    // SQL, and imports only the sanctioned module seams.
    for (const [name, src] of sources(contractDir)) {
      for (const m of src.matchAll(/from '([^']+)'/g)) {
        assert.ok(
          /^(\.\/[^']+|\.\.\/clients$|\.\.\/handyman-(commercial-agreements|labor-pricing|material-pricing|bm-fee-rules)$)/
            .test(m[1]),
          `${name}: forbidden import ${m[1]}`,
        );
      }
      assert.ok(
        !/\bfrom 'pg'|knex|getPool|withTransaction|PoolClient|initDatabase\b/
          .test(src),
        `${name}: contract must hold zero DB capability`,
      );
      assert.ok(
        !/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b|\bCREATE TABLE\b/i
          .test(src),
        `${name}: contract must hold zero SQL surface`,
      );
    }

    // PART 06B adds NO valuation arithmetic: the new authoring and
    // read surface never multiplies/applies a rate, and neither
    // module references ledger/SaaS/FM/entitlement/settlement state.
    const FORBIDDEN_TABLE =
      /platform_\w+|saas_\w+|subscriptions|module_entitlements|feature_entitlement_configurations|tenant_invoices|tenant_charges|vendor_invoices|utility_tariffs|payment_receipts|invoice_payment_status|work_contracts|handyman_customer_|handyman_charge_|handyman_payment_|handyman_ledger_|handyman_quotation|handyman_work_session|handyman_material_execution|handyman_bast/i;
    for (const [dir] of [[bmDir], [contractDir]]) {
      for (const [name, src] of sources(dir as URL)) {
        assert.doesNotMatch(src, FORBIDDEN_TABLE,
          `${name}: forbidden table reference`);
      }
    }
    const service = readFileSync(
      new URL('./handyman-bm-fee-rule.service.ts', bmDir), 'utf8',
    );
    // No valuation exists in the module: scanning CODE only (comments
    // describe the absent surface), the single arithmetic is the
    // integer ten-thousandths validation — never a rate applied to a
    // base.
    const serviceCode = service
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(
      !/ratePercent\s*\*|\*\s*ratePercent|ratePercent\s*[*/]|[*/]\s*ratePercent|applyRate|computeFee|feeAmountCollected|feeCents/i
        .test(serviceCode),
      'no fee valuation may exist',
    );
    assert.match(serviceCode, /RATE_SCALE_UNITS/);
    // The authoring module (unlike the read contract) legitimately
    // holds the shared transaction helper — proof the SQL lives here
    // and not in the published read family.
    assert.match(serviceCode, /withTransaction/);
    assert.match(serviceCode, /INSERT INTO handyman_bm_fee_term_definitions|insertTerm/);
    for (const [name, src] of sources(contractDir)) {
      assert.ok(!/withTransaction|INSERT INTO|getPool/.test(src),
        `${name}: contract must hold zero DB capability`);
    }

    // Error codes are bounded and carry no fee-value/SaaS vocabulary.
    for (const key of Object.keys(ERROR_CODES)) {
      if (!key.startsWith('HANDYMAN_BM_FEE_')) continue;
      assert.doesNotMatch(key, /AMOUNT|VALUE|PAYOUT|GATEWAY|SETTLE|SAAS/i);
    }

    // No HTTP wiring exists for either module.
    for (const file of readdirSync('src/routes')) {
      const src = readFileSync(`src/routes/${file}`, 'utf8');
      assert.ok(
        !src.includes('handyman-bm-fee') && !src.includes(
          'handyman-pricing-contract',
        ),
        `src/routes/${file}: module must stay unwired to HTTP`,
      );
    }
  });
});
