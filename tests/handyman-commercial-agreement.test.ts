import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { AppError, ERROR_CODES } from '../src/shared/errors';
import {
  HANDYMAN_COMMERCIAL_AGREEMENT_EVENT_TYPES,
  HANDYMAN_COMMERCIAL_AGREEMENT_STATUSES,
  handymanCommercialAgreementRepository,
  nextHandymanCommercialAgreementVersionStatus,
  parseHandymanAgreementTimestamp,
  assertHandymanAgreementSupersessionWindow,
  prepareHandymanCommercialAgreement,
  activateHandymanCommercialAgreementVersion,
  supersedeHandymanCommercialAgreementVersion,
  resolveHandymanCommercialAgreementAt,
} from '../src/modules/handyman-commercial-agreements';
import { createAdminUser } from './helpers/access';
import { realmFixture, initHandymanFixtures } from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-12 PART 01 — commercial agreement aggregate + immutable
 * effective versions + fail-closed as-of resolution ONLY (FROZEN
 * governance `CR-HM-12_START_GOVERNANCE.md` §5/§10). NO pricing modes,
 * NO material basis, NO BM fee rules, NO ledger/payment/API. Six
 * focused cases.
 */

const TABLES = [
  'handyman_commercial_agreements',
  'handyman_commercial_agreement_versions',
  'handyman_commercial_agreement_events',
] as const;

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE handyman_commercial_agreement_events,
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
  return realmFixture(`CR-HM-12-P01-${randomUUID().slice(0, 4)}`);
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe('CR-HM-12 PART 01 commercial agreement versioning', () => {
  it('t1 freezes status/event vocabularies and the version state machine', () => {
    assert.deepEqual([...HANDYMAN_COMMERCIAL_AGREEMENT_STATUSES], [
      'DRAFT', 'ACTIVE', 'SUPERSEDED',
    ]);
    assert.deepEqual([...HANDYMAN_COMMERCIAL_AGREEMENT_EVENT_TYPES], [
      'PREPARE', 'ACTIVATE', 'SUPERSEDE',
    ]);

    assert.equal(
      nextHandymanCommercialAgreementVersionStatus('DRAFT', 'ACTIVATE'),
      'ACTIVE',
    );
    assert.equal(
      nextHandymanCommercialAgreementVersionStatus('ACTIVE', 'SUPERSEDE'),
      'SUPERSEDED',
    );
    for (const [from, action] of [
      ['ACTIVE', 'ACTIVATE'],
      ['SUPERSEDED', 'ACTIVATE'],
      ['DRAFT', 'SUPERSEDE'],
      ['SUPERSEDED', 'SUPERSEDE'],
      ['DRAFT', 'VOID'],
      ['ACTIVE', 'APPROVE'],
    ] as const) {
      assert.throws(
        () => nextHandymanCommercialAgreementVersionStatus(from, action),
        (err: unknown) => {
          expectErrorCode(
            err,
            ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_ILLEGAL_TRANSITION,
          );
          return true;
        },
        `${from} + ${action} must be illegal`,
      );
    }

    // Timestamps parse strictly; supersession windows move forward.
    assert.ok(parseHandymanAgreementTimestamp(iso(0), 'effectiveFrom')
      instanceof Date);
    for (const bad of ['', 'not-a-date', 42, null, undefined]) {
      assert.throws(
        () => parseHandymanAgreementTimestamp(bad, 'effectiveFrom'),
        (err: unknown) => {
          expectErrorCode(
            err, ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VALIDATION,
          );
          return true;
        },
      );
    }
    const base = new Date('2026-01-01T00:00:00Z');
    assert.throws(
      () => assertHandymanAgreementSupersessionWindow(base, base),
      (err: unknown) => {
        expectErrorCode(
          err, ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VALIDATION,
        );
        return true;
      },
    );
    assert.throws(
      () => assertHandymanAgreementSupersessionWindow(
        base, new Date(base.getTime() - 1),
      ),
    );
    assert.doesNotThrow(() => assertHandymanAgreementSupersessionWindow(
      base, new Date(base.getTime() + 1),
    ));
  });

  it('t2 anchors ONE agreement per client and numbers versions monotonically', async (t) => {
    if (!requireDatabase(t)) return;
    if (!pool) return;
    const realm = await newClientRealm();

    const first = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p1-${randomUUID()}`,
    });
    assert.equal(first.version.versionNumber, 1);
    assert.equal(first.version.status, 'DRAFT');
    assert.equal(first.version.effectiveFrom, null);
    assert.equal(first.version.effectiveTo, null);
    assert.equal(first.replayed, false);

    const second = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p2-${randomUUID()}`,
    });
    assert.equal(second.version.versionNumber, 2);
    assert.equal(second.agreement.id, first.agreement.id);

    const roots = await pool.query(
      'SELECT count(*)::int AS n FROM handyman_commercial_agreements WHERE client_id = $1',
      [realm.client.id],
    );
    assert.equal(roots.rows[0].n, 1);

    // DB-level aggregate anchor: a direct second root is a bounded
    // unique violation.
    await assert.rejects(
      pool.query(
        `INSERT INTO handyman_commercial_agreements (id, client_id, created_by_user_id)
         VALUES ($1, $2, $3)`,
        [randomUUID(), realm.client.id, adminUserId],
      ),
      (err: { code?: string }) => err.code === '23505',
    );

    // Unknown/garbage client input fails bounded, never creates.
    await assert.rejects(
      prepareHandymanCommercialAgreement(adminUserId, {
        clientId: 'nope', idempotencyKey: 'k',
      }),
      (err: unknown) => {
        expectErrorCode(
          err, ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VALIDATION,
        );
        return true;
      },
    );
    await assert.rejects(
      prepareHandymanCommercialAgreement(adminUserId, {
        clientId: randomUUID(), idempotencyKey: 'k',
      }),
      (err: unknown) => {
        expectErrorCode(
          err, ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VALIDATION,
        );
        return true;
      },
    );
  });

  it('t3 activates exactly one version and closes the window law', async (t) => {
    if (!requireDatabase(t)) return;
    if (!pool) return;
    const realm = await newClientRealm();
    const prepared = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p-${randomUUID()}`,
    });
    const from = iso(60_000);
    const activated = await activateHandymanCommercialAgreementVersion(
      adminUserId,
      {
        versionId: prepared.version.id,
        effectiveFrom: from,
        idempotencyKey: `a-${randomUUID()}`,
      },
    );
    assert.equal(activated.version.status, 'ACTIVE');
    assert.equal(
      activated.version.effectiveFrom.toISOString(),
      new Date(from).toISOString(),
    );
    assert.equal(activated.version.effectiveTo, null);

    // A second DRAFT cannot activate while one is ACTIVE (§5
    // uniqueness — bounded conflict, not first-wins).
    const draft2 = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p2-${randomUUID()}`,
    });
    await assert.rejects(
      activateHandymanCommercialAgreementVersion(adminUserId, {
        versionId: draft2.version.id,
        effectiveFrom: iso(120_000),
        idempotencyKey: `a2-${randomUUID()}`,
      }),
      (err: unknown) => {
        expectErrorCode(
          err, ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_ACTIVE_EXISTS,
        );
        return true;
      },
    );
    // DRAFT is not an effective window: re-activation of the ACTIVE
    // row is illegal, not a silent no-op.
    await assert.rejects(
      activateHandymanCommercialAgreementVersion(adminUserId, {
        versionId: prepared.version.id,
        effectiveFrom: from,
        idempotencyKey: `a3-${randomUUID()}`,
      }),
      (err: unknown) => {
        expectErrorCode(
          err,
          ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_ILLEGAL_TRANSITION,
        );
        return true;
      },
    );
  });

  it('t4 resolves as-of fail-closed: exact boundaries, historical windows, no implicit current', async (t) => {
    if (!requireDatabase(t)) return;
    if (!pool) return;
    const realm = await newClientRealm();
    const prepared = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p-${randomUUID()}`,
    });

    // Before anything is effective: bounded failure (no fallback).
    await assert.rejects(
      resolveHandymanCommercialAgreementAt(
        realm.client.id,
        new Date(Date.now() - 60 * 60_000).toISOString(),
      ),
      (err: unknown) => {
        expectErrorCode(
          err,
          ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_EFFECTIVE_AT_AS_OF,
        );
        return true;
      },
    );

    const f1 = Date.now() + 10_000;
    const f2 = f1 + 10 * 60_000;
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      effectiveFrom: new Date(f1).toISOString(),
      idempotencyKey: `a-${randomUUID()}`,
    });
    const draft2 = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p2-${randomUUID()}`,
    });

    // Boundary law: [effectiveFrom, effectiveTo) — inclusive open.
    const atOpen = await resolveHandymanCommercialAgreementAt(
      realm.client.id, new Date(f1).toISOString(),
    );
    assert.equal(atOpen.id, prepared.version.id);
    await assert.rejects(
      resolveHandymanCommercialAgreementAt(
        realm.client.id, new Date(f1 - 1).toISOString(),
      ),
    );

    // Supersede: v1 closes exactly when v2 opens — no gap, no overlap.
    await supersedeHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      replacementVersionId: draft2.version.id,
      effectiveFrom: new Date(f2).toISOString(),
      idempotencyKey: `s-${randomUUID()}`,
    });
    const historical = await resolveHandymanCommercialAgreementAt(
      realm.client.id, new Date(f2 - 1).toISOString(),
    );
    assert.equal(historical.id, prepared.version.id);
    assert.equal(historical.status, 'SUPERSEDED');
    const current = await resolveHandymanCommercialAgreementAt(
      realm.client.id, new Date(f2).toISOString(),
    );
    assert.equal(current.id, draft2.version.id);
    assert.equal(current.status, 'ACTIVE');

    // A DRAFT never resolves as "current" and another client resolves
    // to nothing (client isolation; no cross-client bleed).
    const draft3 = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p3-${randomUUID()}`,
    });
    assert.notEqual(draft3.version.status, 'ACTIVE');
    const otherRealm = await newClientRealm();
    await assert.rejects(
      resolveHandymanCommercialAgreementAt(
        otherRealm.client.id, new Date(f2 + 1000).toISOString(),
      ),
      (err: unknown) => {
        expectErrorCode(
          err,
          ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_EFFECTIVE_AT_AS_OF,
        );
        return true;
      },
    );
  });

  it('t5 freezes supersession immutability and window overlap at the DB', async (t) => {
    if (!requireDatabase(t)) return;
    if (!pool) return;
    const realm = await newClientRealm();
    const prepared = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p-${randomUUID()}`,
    });
    const activatedFrom = iso(10_000);
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      effectiveFrom: activatedFrom,
      idempotencyKey: `a-${randomUUID()}`,
    });

    // Version identity facts are trigger-blocked.
    await assert.rejects(
      pool.query(
        `UPDATE handyman_commercial_agreement_versions
            SET version_number = version_number + 1
          WHERE id = $1`,
        [prepared.version.id],
      ),
      /facts are immutable/,
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM handyman_commercial_agreement_versions WHERE id = $1',
        [prepared.version.id],
      ),
      /never deleted/,
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM handyman_commercial_agreements WHERE id = $1',
        [prepared.agreement.id],
      ),
      /never deleted/,
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM handyman_commercial_agreement_events',
      ),
      /cannot be updated or deleted/,
    );

    // Bypass attempt: a second ACTIVE row for the same agreement is
    // blocked even if the service guard were skipped.
    const draft = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: `p2-${randomUUID()}`,
    });
    await assert.rejects(
      pool.query(
        `UPDATE handyman_commercial_agreement_versions
            SET status = 'ACTIVE', effective_from = NOW() + interval '1 day'
          WHERE id = $1`,
        [draft.version.id],
      ),
      (err: unknown) => {
        const code = (err as { code?: string }).code;
        const message = String((err as Error).message);
        return code === '23505'
          || message.includes('must not overlap');
      },
    );

    // Same-instant supersession (window does not move forward) is a
    // bounded service failure.
    await assert.rejects(
      supersedeHandymanCommercialAgreementVersion(adminUserId, {
        versionId: prepared.version.id,
        replacementVersionId: draft.version.id,
        effectiveFrom: activatedFrom,
        idempotencyKey: `s-${randomUUID()}`,
      }),
      (err: unknown) => {
        expectErrorCode(
          err, ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VALIDATION,
        );
        return true;
      },
    );

    // Cross-agreement replacement is refused without rewriting either row.
    const otherRealm = await newClientRealm();
    const otherPrepared = await prepareHandymanCommercialAgreement(
      adminUserId,
      { clientId: otherRealm.client.id, idempotencyKey: `o-${randomUUID()}` },
    );
    await assert.rejects(
      supersedeHandymanCommercialAgreementVersion(adminUserId, {
        versionId: prepared.version.id,
        replacementVersionId: otherPrepared.version.id,
        effectiveFrom: iso(24 * 60 * 60_000),
        idempotencyKey: `s2-${randomUUID()}`,
      }),
      (err: unknown) => {
        expectErrorCode(
          err,
          ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_CLIENT_CONFLICT,
        );
        return true;
      },
    );
    const stillActive = await repo_active(pool, prepared.agreement.id);
    assert.equal(stillActive, 1);
  });

  it('t6 replays idempotently, preserves the zero-pricing surface, and stays domain-only', async (t) => {
    if (!requireDatabase(t)) return;
    if (!pool) return;
    const realm = await newClientRealm();
    const key = `p-${randomUUID()}`;
    const first = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: key,
    });
    const replay = await prepareHandymanCommercialAgreement(adminUserId, {
      clientId: realm.client.id, idempotencyKey: key,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.version.id, first.version.id);
    assert.equal(replay.event.id, first.event.id);

    const activation = await activateHandymanCommercialAgreementVersion(
      adminUserId,
      {
        versionId: first.version.id,
        effectiveFrom: iso(10_000),
        idempotencyKey: `a-${key}`,
      },
    );
    const activationReplay = await activateHandymanCommercialAgreementVersion(
      adminUserId,
      {
        versionId: first.version.id,
        effectiveFrom: iso(10_000),
        idempotencyKey: `a-${key}`,
      },
    );
    assert.equal(activationReplay.replayed, true);
    assert.equal(activationReplay.event.id, activation.event.id);

    // The exact persisted column sets: identity + lifecycle only.
    // Zero amount/price/rate/fee/currency/charge/billing/payment/
    // ledger/tax/discount vocabulary exists anywhere in this PART
    // (pricing execution is PART 02+, fee rules PART 04+, ledger is
    // CR-HM-13).
    const cols = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name = ANY($1)`,
      [TABLES as unknown as string[]],
    );
    const FORBIDDEN = /amount|price|rate|fee|charge|bill|pay|ledger|tax|discount|currency|invoice|settle|reconcil/i;
    for (const row of cols.rows) {
      assert.doesNotMatch(
        `${row.table_name}.${row.column_name}`, FORBIDDEN,
      );
    }
    const columnsByTable = new Map<string, string[]>();
    for (const row of cols.rows) {
      const list = columnsByTable.get(row.table_name) ?? [];
      list.push(row.column_name);
      columnsByTable.set(row.table_name, list);
    }
    assert.deepEqual(
      [...(columnsByTable.get('handyman_commercial_agreements') ?? [])].sort(),
      ['client_id', 'created_at', 'created_by_user_id', 'id', 'updated_at'],
    );
    assert.deepEqual(
      [...(columnsByTable.get('handyman_commercial_agreement_versions') ?? [])]
        .sort(),
      [
        'agreement_id', 'created_at', 'created_by_user_id',
        'effective_from', 'effective_to', 'id', 'status',
        'updated_at', 'version_number',
      ],
    );

    // Tenant FK graph: clients + users + the three internal tables
    // ONLY — no FM financial table, no SaaS platform_* table (§3).
    const fks = await pool.query(
      `SELECT crel.relname AS from_table,
              frel.relname AS to_table
         FROM pg_constraint tc
         JOIN pg_class crel ON crel.oid = tc.conrelid
         JOIN pg_class frel ON frel.oid = tc.confrelid
        WHERE tc.contype = 'f'
          AND tc.connamespace = 'public'::regnamespace
          AND crel.relname = ANY($1)`,
      [TABLES as unknown as string[]],
    );
    const ALLOWED = new Set<string>(TABLES);
    ALLOWED.add('clients');
    ALLOWED.add('users');
    for (const row of fks.rows) {
      assert.ok(
        ALLOWED.has(row.to_table),
        `forbidden FK ${row.from_table} -> ${row.to_table}`,
      );
    }

    // Domain-only surface: no HTTP anywhere in this module — no
    // controller/routes file inside the module and no `-api`
    // sibling module (that surface, if ever, is a later PART).
    const files = readdirSync(
      new URL('../src/modules/handyman-commercial-agreements',
        import.meta.url),
      { withFileTypes: true },
    ).filter((entry) => entry.isFile()).map((entry) => entry.name);
    for (const file of files) {
      assert.doesNotMatch(file, /controller|routes|api|openapi|swagger/);
    }
    assert.equal(
      readdirSync(new URL('../src/modules', import.meta.url),
        { withFileTypes: true })
        .filter((entry) => entry.isDirectory()
          && entry.name === 'handyman-commercial-agreements-api')
        .length,
      0,
    );

    // Repository-level read paths project only frozen facts.
    const version =
      await handymanCommercialAgreementRepository.findVersionById(
        pool, first.version.id,
      );
    assert.ok(version);
    assert.equal(version.status, 'ACTIVE');
  });
});

async function repo_active(pool: Pool, agreementId: string): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM handyman_commercial_agreement_versions
      WHERE agreement_id = $1 AND status = 'ACTIVE'`,
    [agreementId],
  );
  return result.rows[0].n;
}
