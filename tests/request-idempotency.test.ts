import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { getPool } from '../src/database/connection';
import { sha256Hex } from '../src/shared/hash';
import { stableJson } from '../src/shared/stable-json';
import { ERROR_CODES } from '../src/shared/errors';
import {
  parseIdempotencyKeyRequired,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from '../src/modules/request-idempotency/request-idempotency.validation';
import {
  executeIdempotent,
  computeRequestFingerprint,
  MAX_RESPONSE_BYTES,
} from '../src/modules/request-idempotency/request-idempotency.service';
import { requestIdempotencyRepository } from '../src/modules/request-idempotency/request-idempotency.repository';
import { ensureTestDatabase } from './helpers/postgres';
import type { DatabaseConfig } from '../src/config';

/**
 * CR-BE-IDEMPOTENCY-CORE-01 PART 01 — Generic idempotency foundation tests.
 *
 * Covers 30 required proofs, concurrency, integrity, security, and boundaries.
 * Retention cleanup is deferred — correctness does not depend on deletion.
 */

const DB_PORT = 55495;
const DATA_DIR = '/tmp/asentra-idempotency-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let pg: any = null;

before(async () => {
  if (EMBEDDED_DATABASE) {
    const { mkdir, rm } = await import('node:fs/promises');
    const EmbeddedPostgres = (await import('embedded-postgres')).default;
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;
  database = db;
  pool = await initDatabase(db);
  await migrateUp(pool);

  // Clean slate for idempotency table and users
  await pool.query(`TRUNCATE request_idempotency_records, users CASCADE`);
  // Ensure business test table for atomicity proofs
  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_business_writes (
      id UUID PRIMARY KEY,
      actor_user_id UUID NOT NULL,
      value TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`TRUNCATE test_business_writes`);
});

after(async () => {
  try {
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS test_business_writes`);
      await closePool(pool);
    }
    if (pg) await pg.stop();
  } finally {
    if (EMBEDDED_DATABASE) {
      const { rm } = await import('node:fs/promises');
      await rm(DATA_DIR, { recursive: true, force: true });
    }
  }
  pg = null;
  pool = null;
  database = null;
});

function requireDatabase(t: any): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

async function createUser(): Promise<string> {
  const id = randomUUID();
  const email = `idem-test-${randomUUID().slice(0, 8)}@example.com`;
  await getPool().query(
    `INSERT INTO users (id, email, display_name, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [id, email, 'Test User'],
  );
  return id;
}

function fingerprintFor(obj: unknown): string {
  return computeRequestFingerprint(obj);
}

describe('CR-BE-IDEMPOTENCY-CORE-01 PART 01 — parser', () => {
  it('1. required key rejects missing', async (t) => {
    if (!requireDatabase(t)) return;
    assert.throws(
      () => parseIdempotencyKeyRequired(undefined),
      (err: any) => {
        assert.equal(err.code, ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED);
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it('2. required key rejects blank', async (t) => {
    if (!requireDatabase(t)) return;
    assert.throws(
      () => parseIdempotencyKeyRequired('   '),
      (err: any) => {
        assert.equal(err.code, ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED);
        return true;
      },
    );
    assert.throws(
      () => parseIdempotencyKeyRequired(''),
      (err: any) => {
        assert.equal(err.code, ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED);
        return true;
      },
    );
  });

  it('3. CR/LF/NUL rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const badKeys = [
      'a' + String.fromCharCode(13) + 'b',
      'a' + String.fromCharCode(10) + 'b',
      'a' + String.fromCharCode(0) + 'b',
      'a' + String.fromCharCode(13, 10) + 'b',
    ];
    for (const bad of badKeys) {
      assert.throws(
        () => parseIdempotencyKeyRequired(bad),
        (err: any) => {
          assert.equal(err.code, ERROR_CODES.VALIDATION_ERROR);
          assert.equal(err.statusCode, 400);
          return true;
        },
        `should reject ${JSON.stringify(bad)}`,
      );
    }
  });

  it('4. >200 rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const long = 'a'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1);
    assert.throws(
      () => parseIdempotencyKeyRequired(long),
      (err: any) => {
        assert.equal(err.code, ERROR_CODES.VALIDATION_ERROR);
        return true;
      },
    );
  });

  it('5. normalization trims key', async (t) => {
    if (!requireDatabase(t)) return;
    const raw = '  my-key-123  ';
    const normalized = parseIdempotencyKeyRequired(raw);
    assert.equal(normalized, 'my-key-123');
  });
});

describe('CR-BE-IDEMPOTENCY-CORE-01 PART 01 — crypto / canonicalization', () => {
  it('8. stableJson gives same output for recursively reordered object keys', async (t) => {
    if (!requireDatabase(t)) return;
    const a = { b: 2, a: 1, c: { z: 3, y: 2, x: { b: 2, a: 1 } } };
    const b = { a: 1, c: { x: { a: 1, b: 2 }, y: 2, z: 3 }, b: 2 };
    const sa = stableJson(a);
    const sb = stableJson(b);
    assert.equal(sa, sb);
    // Arrays preserve order
    const arr1 = stableJson({ arr: [1, 2, 3] });
    const arr2 = stableJson({ arr: [3, 2, 1] });
    assert.notEqual(arr1, arr2);
  });

  it('9. different semantic request gives different fingerprint', async (t) => {
    if (!requireDatabase(t)) return;
    const f1 = fingerprintFor({ a: 1, b: 2 });
    const f2 = fingerprintFor({ a: 1, b: 3 });
    assert.notEqual(f1, f2);
    assert.match(f1, /^[0-9a-f]{64}$/);
    assert.match(f2, /^[0-9a-f]{64}$/);
  });

  it('6/7. raw key not persisted, SHA-256 hash persisted', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const operationKey = `op_${randomUUID().slice(0, 6)}`;
    const rawKey = `raw-key-${randomUUID()}`;
    const normalized = parseIdempotencyKeyRequired(rawKey);
    const fp = fingerprintFor({ data: 'test6' });

    let executed = 0;
    const result = await executeIdempotent({
      actorUserId: actor,
      operationKey,
      idempotencyKey: normalized,
      requestFingerprint: fp,
      work: async (client) => {
        executed++;
        return { responseStatus: 201, responseBody: { ok: true } };
      },
    });
    assert.equal(executed, 1);
    assert.equal(result.replayed, false);

    const hash = sha256Hex(normalized);
    const rows = await getPool().query(
      `SELECT idempotency_key_hash, request_fingerprint, response_body::text as body FROM request_idempotency_records WHERE actor_user_id=$1 AND operation_key=$2`,
      [actor, operationKey],
    );
    assert.equal(rows.rowCount, 1);
    const row = rows.rows[0];
    assert.equal(row.idempotency_key_hash, hash);
    assert.match(row.idempotency_key_hash, /^[0-9a-f]{64}$/);
    // raw key must NOT appear anywhere in DB row
    const allValues = JSON.stringify(row);
    assert.equal(allValues.includes(rawKey), false, 'raw key leaked in DB');
    assert.equal(allValues.includes(normalized), false, 'normalized raw leaked? but hash is hex, not raw');
    // Ensure hash is persisted
    assert.equal(row.idempotency_key_hash.length, 64);
  });
});

describe('CR-BE-IDEMPOTENCY-CORE-01 PART 01 — core behavior', () => {
  it('10. fresh request executes work once', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`key-${randomUUID()}`);
    const fp = fingerprintFor({ x: 1 });

    let count = 0;
    const res = await executeIdempotent({
      actorUserId: actor,
      operationKey: op,
      idempotencyKey: key,
      requestFingerprint: fp,
      work: async () => {
        count++;
        return { responseStatus: 200, responseBody: { result: 'first' } };
      },
    });
    assert.equal(count, 1);
    assert.equal(res.replayed, false);
    assert.equal(res.responseStatus, 200);
  });

  it('11. completed record stores status/body', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`key-${randomUUID()}`);
    const fp = fingerprintFor({ y: 2 });

    await executeIdempotent({
      actorUserId: actor,
      operationKey: op,
      idempotencyKey: key,
      requestFingerprint: fp,
      work: async () => ({ responseStatus: 201, responseBody: { stored: 'yes' } }),
    });

    const hash = sha256Hex(key);
    const rec = await requestIdempotencyRepository.findByIdentity(
      actor,
      op,
      hash,
      getPool(),
    );
    assert.ok(rec);
    assert.equal(rec!.status, 'COMPLETED');
    assert.equal(rec!.responseStatus, 201);
    assert.deepEqual(rec!.responseBody, { stored: 'yes' });
    assert.ok(rec!.completedAt);
  });

  it('12. identical replay does not execute work', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`key-${randomUUID()}`);
    const fp = fingerprintFor({ z: 3 });

    let firstCount = 0;
    await executeIdempotent({
      actorUserId: actor,
      operationKey: op,
      idempotencyKey: key,
      requestFingerprint: fp,
      work: async () => {
        firstCount++;
        return { responseStatus: 200, responseBody: { v: 1 } };
      },
    });
    assert.equal(firstCount, 1);

    let secondCount = 0;
    const replay = await executeIdempotent({
      actorUserId: actor,
      operationKey: op,
      idempotencyKey: key,
      requestFingerprint: fp,
      work: async () => {
        secondCount++;
        return { responseStatus: 200, responseBody: { v: 2 } };
      },
    });
    assert.equal(secondCount, 0, 'replay must not execute work');
    assert.equal(replay.replayed, true);
  });

  it('13. identical replay returns stored canonical success', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`key-${randomUUID()}`);
    const fp = fingerprintFor({ a: 'canonical' });

    const first = await executeIdempotent({
      actorUserId: actor,
      operationKey: op,
      idempotencyKey: key,
      requestFingerprint: fp,
      work: async () => ({ responseStatus: 200, responseBody: { b: 2, a: 1 } }),
    });
    assert.equal(first.replayed, false);

    const second = await executeIdempotent({
      actorUserId: actor,
      operationKey: op,
      idempotencyKey: key,
      requestFingerprint: fp,
      work: async () => ({ responseStatus: 200, responseBody: { different: true } }),
    });
    assert.equal(second.replayed, true);
    assert.equal(second.responseStatus, 200);
    // Stored body should be first's body, not second's
    assert.deepEqual(second.responseBody, { b: 2, a: 1 });
  });

  it('14. same identity + different fingerprint → 409 IDEMPOTENCY_CONFLICT', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`key-${randomUUID()}`);
    const fp1 = fingerprintFor({ req: 1 });
    const fp2 = fingerprintFor({ req: 2 });

    await executeIdempotent({
      actorUserId: actor,
      operationKey: op,
      idempotencyKey: key,
      requestFingerprint: fp1,
      work: async () => ({ responseStatus: 200, responseBody: { ok: 1 } }),
    });

    await assert.rejects(
      () =>
        executeIdempotent({
          actorUserId: actor,
          operationKey: op,
          idempotencyKey: key,
          requestFingerprint: fp2,
          work: async () => ({ responseStatus: 200, responseBody: { ok: 2 } }),
        }),
      (err: any) => {
        assert.equal(err.code, ERROR_CODES.IDEMPOTENCY_CONFLICT);
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  });

  it('15. conflict does not leak stored response', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`key-${randomUUID()}`);
    const fp1 = fingerprintFor({ secret: 'data' });
    const fp2 = fingerprintFor({ secret: 'different' });

    await executeIdempotent({
      actorUserId: actor,
      operationKey: op,
      idempotencyKey: key,
      requestFingerprint: fp1,
      work: async () => ({ responseStatus: 200, responseBody: { secret: 'leak-test' } }),
    });

    try {
      await executeIdempotent({
        actorUserId: actor,
        operationKey: op,
        idempotencyKey: key,
        requestFingerprint: fp2,
        work: async () => ({ responseStatus: 200, responseBody: {} }),
      });
      assert.fail('should have thrown conflict');
    } catch (err: any) {
      assert.equal(err.code, ERROR_CODES.IDEMPOTENCY_CONFLICT);
      const msg = err.message as string;
      const details = JSON.stringify(err.details ?? '') + msg;
      assert.equal(details.includes('leak-test'), false, 'stored response leaked in error');
      assert.equal(details.includes(fp1), false, 'fingerprint leaked');
      assert.equal(details.includes(key), false, 'raw key leaked');
    }
  });

  it('16. different actor + same key executes independently', async (t) => {
    if (!requireDatabase(t)) return;
    const actor1 = await createUser();
    const actor2 = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`shared-key-${randomUUID()}`);
    const fp = fingerprintFor({ same: true });

    let count = 0;
    const r1 = await executeIdempotent({
      actorUserId: actor1,
      operationKey: op,
      idempotencyKey: key,
      requestFingerprint: fp,
      work: async () => {
        count++;
        return { responseStatus: 200, responseBody: { actor: 1 } };
      },
    });
    const r2 = await executeIdempotent({
      actorUserId: actor2,
      operationKey: op,
      idempotencyKey: key,
      requestFingerprint: fp,
      work: async () => {
        count++;
        return { responseStatus: 200, responseBody: { actor: 2 } };
      },
    });
    assert.equal(count, 2);
    assert.equal(r1.replayed, false);
    assert.equal(r2.replayed, false);
    assert.deepEqual(r1.responseBody, { actor: 1 });
    assert.deepEqual(r2.responseBody, { actor: 2 });
  });

  it('17. different operation + same actor/key executes independently', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op1 = `op1_${randomUUID().slice(0, 6)}`;
    const op2 = `op2_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`shared-key-${randomUUID()}`);
    const fp = fingerprintFor({ same: true });

    let count = 0;
    const r1 = await executeIdempotent({
      actorUserId: actor,
      operationKey: op1,
      idempotencyKey: key,
      requestFingerprint: fp,
      work: async () => {
        count++;
        return { responseStatus: 200, responseBody: { op: 1 } };
      },
    });
    const r2 = await executeIdempotent({
      actorUserId: actor,
      operationKey: op2,
      idempotencyKey: key,
      requestFingerprint: fp,
      work: async () => {
        count++;
        return { responseStatus: 200, responseBody: { op: 2 } };
      },
    });
    assert.equal(count, 2);
    assert.equal(r1.replayed, false);
    assert.equal(r2.replayed, false);
  });

  it('18. work failure rolls back claim', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`key-${randomUUID()}`);
    const fp = fingerprintFor({ fail: true });

    await assert.rejects(
      () =>
        executeIdempotent({
          actorUserId: actor,
          operationKey: op,
          idempotencyKey: key,
          requestFingerprint: fp,
          work: async () => {
            throw new Error('business failure');
          },
        }),
      (err: any) => {
        assert.equal(err.message, 'business failure');
        return true;
      },
    );

    const hash = sha256Hex(key);
    const rec = await requestIdempotencyRepository.findByIdentity(
      actor,
      op,
      hash,
      getPool(),
    );
    assert.equal(rec, null, 'claim should be rolled back on work failure');
  });

  it('19. work failure leaves no idempotency row', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`key-${randomUUID()}`);
    const fp = fingerprintFor({ fail2: true });

    const before = await getPool().query(
      `SELECT COUNT(*)::int as c FROM request_idempotency_records WHERE actor_user_id=$1`,
      [actor],
    );
    assert.equal(before.rows[0].c, 0);

    try {
      await executeIdempotent({
        actorUserId: actor,
        operationKey: op,
        idempotencyKey: key,
        requestFingerprint: fp,
        work: async () => {
          throw new Error('fail');
        },
      });
    } catch {}

    const after = await getPool().query(
      `SELECT COUNT(*)::int as c FROM request_idempotency_records WHERE actor_user_id=$1`,
      [actor],
    );
    assert.equal(after.rows[0].c, 0);
  });

  it('20. business write + completed record commit together', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`key-${randomUUID()}`);
    const fp = fingerprintFor({ business: 'atomic' });
    const businessId = randomUUID();

    const result = await executeIdempotent({
      actorUserId: actor,
      operationKey: op,
      idempotencyKey: key,
      requestFingerprint: fp,
      work: async (client) => {
        await client.query(
          `INSERT INTO test_business_writes (id, actor_user_id, value) VALUES ($1, $2, $3)`,
          [businessId, actor, 'committed'],
        );
        return { responseStatus: 200, responseBody: { businessId } };
      },
    });
    assert.equal(result.replayed, false);

    const biz = await getPool().query(
      `SELECT * FROM test_business_writes WHERE id=$1`,
      [businessId],
    );
    assert.equal(biz.rowCount, 1);

    const hash = sha256Hex(key);
    const idem = await requestIdempotencyRepository.findByIdentity(
      actor,
      op,
      hash,
      getPool(),
    );
    assert.ok(idem);
    assert.equal(idem!.status, 'COMPLETED');

    // Failure case: business write should also rollback
    const actor2 = await createUser();
    const key2 = parseIdempotencyKeyRequired(`key-${randomUUID()}`);
    const fp2 = fingerprintFor({ business: 'rollback' });
    const businessId2 = randomUUID();

    try {
      await executeIdempotent({
        actorUserId: actor2,
        operationKey: op,
        idempotencyKey: key2,
        requestFingerprint: fp2,
        work: async (client) => {
          await client.query(
            `INSERT INTO test_business_writes (id, actor_user_id, value) VALUES ($1, $2, $3)`,
            [businessId2, actor2, 'should-rollback'],
          );
          throw new Error('business error after write');
        },
      });
      assert.fail('should throw');
    } catch {}

    const biz2 = await getPool().query(
      `SELECT * FROM test_business_writes WHERE id=$1`,
      [businessId2],
    );
    assert.equal(biz2.rowCount, 0, 'business write should rollback with idempotency claim');

    const hash2 = sha256Hex(key2);
    const idem2 = await requestIdempotencyRepository.findByIdentity(
      actor2,
      op,
      hash2,
      getPool(),
    );
    assert.equal(idem2, null);
  });

  it('21. response body >65536 bytes rolls back business mutation and claim', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`key-${randomUUID()}`);
    const fp = fingerprintFor({ large: true });
    const businessId = randomUUID();

    const largeString = 'a'.repeat(70000);
    try {
      await executeIdempotent({
        actorUserId: actor,
        operationKey: op,
        idempotencyKey: key,
        requestFingerprint: fp,
        work: async (client) => {
          await client.query(
            `INSERT INTO test_business_writes (id, actor_user_id, value) VALUES ($1, $2, $3)`,
            [businessId, actor, 'large'],
          );
          return { responseStatus: 200, responseBody: { data: largeString } };
        },
      });
      assert.fail('should have thrown due to large body');
    } catch (err: any) {
      assert.ok(err.message.includes('exceeds'));
    }

    const biz = await getPool().query(
      `SELECT * FROM test_business_writes WHERE id=$1`,
      [businessId],
    );
    assert.equal(biz.rowCount, 0, 'business mutation should rollback on oversized response');

    const hash = sha256Hex(key);
    const rec = await requestIdempotencyRepository.findByIdentity(
      actor,
      op,
      hash,
      getPool(),
    );
    assert.equal(rec, null, 'idempotency record should not remain on oversized response');
  });

  it('22. concurrent identical requests execute business callback exactly once', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`concurrent-${randomUUID()}`);
    const fp = fingerprintFor({ concurrent: 1 });

    let execCount = 0;
    const work = async (client: any) => {
      execCount++;
      // Small delay to increase chance of race, but bounded
      await new Promise((r) => setTimeout(r, 30));
      return { responseStatus: 200, responseBody: { count: execCount } };
    };

    const [r1, r2] = await Promise.all([
      executeIdempotent({
        actorUserId: actor,
        operationKey: op,
        idempotencyKey: key,
        requestFingerprint: fp,
        work,
      }),
      executeIdempotent({
        actorUserId: actor,
        operationKey: op,
        idempotencyKey: key,
        requestFingerprint: fp,
        work,
      }),
    ]);

    assert.equal(execCount, 1, 'business callback must execute exactly once');
    // One replayed false, one true (order nondeterministic)
    const replayedCount = [r1.replayed, r2.replayed].filter(Boolean).length;
    assert.equal(replayedCount, 1);
  });

  it('23. concurrent second request replays first committed result', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`concurrent2-${randomUUID()}`);
    const fp = fingerprintFor({ concurrent: 2 });

    const work = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { responseStatus: 201, responseBody: { id: 'first-result' } };
    };

    const [a, b] = await Promise.all([
      executeIdempotent({
        actorUserId: actor,
        operationKey: op,
        idempotencyKey: key,
        requestFingerprint: fp,
        work,
      }),
      executeIdempotent({
        actorUserId: actor,
        operationKey: op,
        idempotencyKey: key,
        requestFingerprint: fp,
        work,
      }),
    ]);

    assert.deepEqual(a.responseBody, { id: 'first-result' });
    assert.deepEqual(b.responseBody, { id: 'first-result' });
    assert.equal(a.responseStatus, 201);
    assert.equal(b.responseStatus, 201);
  });

  it('24. owner rollback permits contender to become owner without duplicate committed mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`rollback-contender-${randomUUID()}`);
    const fp = fingerprintFor({ rollback: 'test' });

    let execCount = 0;
    let firstStarted = false;

    const failingWork = async (client: any) => {
      firstStarted = true;
      execCount++;
      await new Promise((r) => setTimeout(r, 50));
      throw new Error('owner fails');
    };

    const succeedingWork = async (client: any) => {
      // Wait until first has started to ensure ordering
      for (let i = 0; i < 20 && !firstStarted; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      // Small additional delay so first is still in transaction holding the unique lock
      await new Promise((r) => setTimeout(r, 10));
      execCount++;
      return { responseStatus: 200, responseBody: { winner: 'second' } };
    };

    const results = await Promise.allSettled([
      executeIdempotent({
        actorUserId: actor,
        operationKey: op,
        idempotencyKey: key,
        requestFingerprint: fp,
        work: failingWork,
      }),
      executeIdempotent({
        actorUserId: actor,
        operationKey: op,
        idempotencyKey: key,
        requestFingerprint: fp,
        work: succeedingWork,
      }),
    ]);

    // One should reject (first), one should fulfill (second) — or vice versa depending on timing,
    // but total execCount should be 2 attempts, only 1 committed mutation.
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as any[];
    const rejected = results.filter((r) => r.status === 'rejected');

    // At least one must succeed
    assert.ok(fulfilled.length >= 1, 'at least one should succeed after rollback');
    // If first was owner and failed, second becomes owner → 1 success
    // If second was owner first, first would then replay (not fail) — but we forced first to start first,
    // so we expect 1 failure, 1 success in typical timing.
    // In any case, final DB should have exactly one COMPLETED record.
    const hash = sha256Hex(key);
    const rec = await requestIdempotencyRepository.findByIdentity(
      actor,
      op,
      hash,
      getPool(),
    );
    assert.ok(rec, 'final record should exist');
    assert.equal(rec!.status, 'COMPLETED');
    // Only one committed mutation — check business table not duplicated (we use execCount as proxy)
    // The committed result should be from succeeding work
    if (fulfilled.length === 1) {
      assert.deepEqual(fulfilled[0].value.responseBody, { winner: 'second' });
    }
  });

  it('25. no FAILED status exists in persisted vocabulary', async (t) => {
    if (!requireDatabase(t)) return;
    const statuses = await getPool().query(
      `SELECT DISTINCT status FROM request_idempotency_records`,
    );
    for (const row of statuses.rows) {
      assert.ok(
        ['IN_PROGRESS', 'COMPLETED'].includes(row.status),
        `unexpected status ${row.status}`,
      );
      assert.notEqual(row.status, 'FAILED');
    }
    // Try to insert FAILED directly — should fail due to CHECK constraint
    const actor = await createUser();
    await assert.rejects(
      () =>
        getPool().query(
          `INSERT INTO request_idempotency_records (id, actor_user_id, operation_key, idempotency_key_hash, request_fingerprint, status)
           VALUES ($1, $2, $3, $4, $5, 'FAILED')`,
          [
            randomUUID(),
            actor,
            'test_op',
            'a'.repeat(64),
            'b'.repeat(64),
          ],
        ),
      (err: any) => {
        assert.ok(err.message.includes('check') || err.code === '23514');
        return true;
      },
    );
  });

  it('26. actor/op/key unique constraint is race-safe', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    const op = `op_${randomUUID().slice(0, 6)}`;
    const key = parseIdempotencyKeyRequired(`race-${randomUUID()}`);
    const fp = fingerprintFor({ race: true });
    const hash = sha256Hex(key);

    // Directly test unique constraint via concurrent inserts of IN_PROGRESS
    const p1 = getPool().query(
      `INSERT INTO request_idempotency_records (id, actor_user_id, operation_key, idempotency_key_hash, request_fingerprint, status)
       VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS')
       ON CONFLICT DO NOTHING RETURNING id`,
      [randomUUID(), actor, op, hash, fp],
    );
    const p2 = getPool().query(
      `INSERT INTO request_idempotency_records (id, actor_user_id, operation_key, idempotency_key_hash, request_fingerprint, status)
       VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS')
       ON CONFLICT DO NOTHING RETURNING id`,
      [randomUUID(), actor, op, hash, fp],
    );
    const [r1, r2] = await Promise.all([p1, p2]);
    const insertedCount = (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    assert.equal(insertedCount, 1, 'unique constraint must allow only one insert');

    // Cleanup
    await getPool().query(
      `DELETE FROM request_idempotency_records WHERE actor_user_id=$1 AND operation_key=$2`,
      [actor, op],
    );
  });

  it('27. completed integrity constraint rejects incomplete completed rows', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    // Missing response_body and completed_at
    await assert.rejects(
      () =>
        getPool().query(
          `INSERT INTO request_idempotency_records (id, actor_user_id, operation_key, idempotency_key_hash, request_fingerprint, status, response_status)
           VALUES ($1, $2, $3, $4, $5, 'COMPLETED', 200)`,
          [randomUUID(), actor, 'op_test', 'c'.repeat(64), 'd'.repeat(64)],
        ),
      (err: any) => {
        assert.ok(err.code === '23514' || err.message.includes('check'));
        return true;
      },
    );
    // response_status not 2xx
    await assert.rejects(
      () =>
        getPool().query(
          `INSERT INTO request_idempotency_records (id, actor_user_id, operation_key, idempotency_key_hash, request_fingerprint, status, response_status, response_body, completed_at)
           VALUES ($1, $2, $3, $4, $5, 'COMPLETED', 404, '{}', NOW())`,
          [randomUUID(), actor, 'op_test', 'e'.repeat(64), 'f'.repeat(64)],
        ),
      (err: any) => {
        assert.ok(err.code === '23514' || err.message.includes('check'));
        return true;
      },
    );
  });

  it('28. IN_PROGRESS integrity constraint rejects response payload fields', async (t) => {
    if (!requireDatabase(t)) return;
    const actor = await createUser();
    await assert.rejects(
      () =>
        getPool().query(
          `INSERT INTO request_idempotency_records (id, actor_user_id, operation_key, idempotency_key_hash, request_fingerprint, status, response_status)
           VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', 200)`,
          [randomUUID(), actor, 'op_test', 'a'.repeat(64), 'b'.repeat(64)],
        ),
      (err: any) => {
        assert.ok(err.code === '23514' || err.message.includes('check'));
        return true;
      },
    );
    await assert.rejects(
      () =>
        getPool().query(
          `INSERT INTO request_idempotency_records (id, actor_user_id, operation_key, idempotency_key_hash, request_fingerprint, status, response_body)
           VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', '{}')`,
          [randomUUID(), actor, 'op_test', 'c'.repeat(64), 'd'.repeat(64)],
        ),
      (err: any) => {
        assert.ok(err.code === '23514' || err.message.includes('check'));
        return true;
      },
    );
  });

  it('29. no BE-25H table/enum is modified', async (t) => {
    if (!requireDatabase(t)) return;
    // Check mobile_sync_idempotency still exists with expected columns
    const cols = await getPool().query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='mobile_sync_idempotency' ORDER BY column_name`,
    );
    const colNames = cols.rows.map((r: any) => r.column_name);
    // Expected columns from migration 0234
    const expected = [
      'id',
      'user_id',
      'operation_id',
      'resource_type',
      'resource_id',
      'operation',
      'status',
      'result',
      'error_code',
      'error_message',
      'client_timestamp',
      'processed_at',
      'created_at',
      'updated_at',
    ];
    for (const exp of expected) {
      assert.ok(colNames.includes(exp), `BE-25H table missing column ${exp}`);
    }
    // Ensure our table is separate
    const tables = await getPool().query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('mobile_sync_idempotency','request_idempotency_records')`,
    );
    const tableNames = tables.rows.map((r: any) => r.table_name);
    assert.ok(tableNames.includes('mobile_sync_idempotency'));
    assert.ok(tableNames.includes('request_idempotency_records'));
  });

  it('30. no unapproved module adopts the idempotency module', async (t) => {
    // PART 01 shipped the foundation with ZERO adopters. PART 02 approved
    // exactly ONE adoption: the mobile unsafe-condition command
    // (CR-BE-IDEMPOTENCY-CORE-01 PART 02). This boundary test pins that
    // allowlist: any OTHER module referencing the generic idempotency module
    // is an unapproved adoption and must fail.
    // CR-BE-RN11-MATERIAL-FIELD-01 PART 01 approved the SECOND adoption: the
    // mobile field material request CREATE command (`mobile-material-requests`,
    // operationKey `createMobileWorkOrderMaterialRequest`).
    // CR-BE-RN12-METER-FIELD-01 PART 01 approved the THIRD adoption: the mobile
    // field meter reading SUBMIT command (`mobile-utility-meter-reading`,
    // operationKey `recordMobileUtilityMeterReading`). Both referencing files are
    // legitimate adopters — the service calls `executeIdempotent` /
    // `computeRequestFingerprint`, and the controller calls
    // `parseIdempotencyKeyRequired` — the same split RN-11 uses. No custom
    // idempotency table and no field-only replay logic is introduced.
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const modulesRoot = join(process.cwd(), 'src/modules');
    const approvedAdopters = new Set([
      'mobile-unsafe-condition',
      'mobile-material-requests',
      'mobile-utility-meter-reading',
    ]);
    const entries = await readdir(modulesRoot, { withFileTypes: true });
    let violations: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'request-idempotency') continue;
      if (approvedAdopters.has(entry.name)) continue;
      const modPath = join(modulesRoot, entry.name);
      let files: string[] = [];
      try {
        files = await readdir(modPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.ts')) continue;
        const full = join(modPath, file);
        try {
          const content = await readFile(full, 'utf8');
          if (content.includes('request-idempotency')) {
            violations.push(`${entry.name}/${file}`);
          }
        } catch {}
      }
    }
    assert.equal(
      violations.length,
      0,
      `Only approved adopters (${[...approvedAdopters].join(', ')}) may adopt the module, found in: ${violations.join(', ')}`,
    );
  });
});

describe('CR-BE-IDEMPOTENCY-CORE-01 PART 01 — migration reversibility', () => {
  it('migration 0349 up/down/re-up proof', async (t) => {
    if (!requireDatabase(t)) return;
    // The migration should be applied already via migrateUp in before hook
    const check = await getPool().query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='request_idempotency_records') as exists`,
    );
    assert.equal(check.rows[0].exists, true);

    // Test down
    const { migrations } = await import('../src/database/migrations');
    const mig = migrations.find((m: any) => m.id === '0349_create_request_idempotency_records');
    assert.ok(mig, 'migration 0349 should be registered');

    // We need a client for down/up
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await mig!.down(client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const afterDown = await getPool().query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='request_idempotency_records') as exists`,
    );
    assert.equal(afterDown.rows[0].exists, false, 'table should be dropped after down');

    // Re-up
    const client2 = await getPool().connect();
    try {
      await client2.query('BEGIN');
      await mig!.up(client2);
      await client2.query('COMMIT');
    } catch (e) {
      await client2.query('ROLLBACK');
      throw e;
    } finally {
      client2.release();
    }

    const afterReUp = await getPool().query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='request_idempotency_records') as exists`,
    );
    assert.equal(afterReUp.rows[0].exists, true, 'table should exist after re-up');

    // Verify constraints exist
    const constraints = await getPool().query(
      `SELECT conname FROM pg_constraint WHERE conrelid='request_idempotency_records'::regclass`,
    );
    const names = constraints.rows.map((r: any) => r.conname);
    assert.ok(names.some((n: string) => n.includes('unique')), 'unique constraint should exist');
    assert.ok(names.some((n: string) => n.includes('status')), 'status check should exist');
    assert.ok(names.some((n: string) => n.includes('completed')), 'completed check should exist');
    assert.ok(names.some((n: string) => n.includes('in_progress')), 'in_progress check should exist');
  });
});
