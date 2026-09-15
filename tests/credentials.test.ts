import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  credentialService,
  hashPassword,
  invalidPasswordError,
  passwordPolicyViolationError,
  validatePassword,
  verifyPassword,
} from '../src/modules/auth';
import { userService } from '../src/modules/users';
import { AppError } from '../src/shared/errors';
import { createAdminSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE users CASCADE');
  adminToken = await createAdminSession();
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function rejectsWithCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

describe('password policy', () => {
  it('accepts a policy-compliant password', () => {
    assert.equal(validatePassword('Str0ngPass!'), 'Str0ngPass!');
  });

  it('rejects a missing or empty password', () => {
    assert.throws(
      () => validatePassword(''),
      rejectsWithCode('PASSWORD_POLICY_VIOLATION'),
    );
    assert.throws(
      () => validatePassword(undefined),
      rejectsWithCode('PASSWORD_POLICY_VIOLATION'),
    );
  });

  it('rejects a password shorter than the minimum length', () => {
    assert.throws(
      () => validatePassword('short'),
      rejectsWithCode('PASSWORD_POLICY_VIOLATION'),
    );
  });

  it('rejects a password longer than the maximum length', () => {
    assert.throws(
      () => validatePassword('x'.repeat(73)),
      rejectsWithCode('PASSWORD_POLICY_VIOLATION'),
    );
  });

  it('exposes the policy violation as a controlled error', () => {
    const error = passwordPolicyViolationError([
      { field: 'password', message: 'too short' },
    ]);
    assert.equal(error.code, 'PASSWORD_POLICY_VIOLATION');
    assert.equal(error.statusCode, 400);
  });

  it('defines INVALID_PASSWORD for login verification', () => {
    const error = invalidPasswordError();
    assert.equal(error.code, 'INVALID_PASSWORD');
    assert.equal(error.statusCode, 401);
  });
});

describe('password hashing', () => {
  it('stores a salted hash, never the plaintext password', async () => {
    const password = 'Sup3rSecret!';
    const hash = await hashPassword(password);

    assert.notEqual(hash, password);
    assert.doesNotMatch(hash, /Sup3rSecret/);
    assert.match(hash, /^\$2[aby]\$/);
  });

  it('salts each hash uniquely', async () => {
    const first = await hashPassword('SamePassword123');
    const second = await hashPassword('SamePassword123');

    assert.notEqual(first, second);
  });

  it('verifies correct passwords as true and incorrect as false', async () => {
    const hash = await hashPassword('CorrectHorse9');

    assert.equal(await verifyPassword('CorrectHorse9', hash), true);
    assert.equal(await verifyPassword('WrongHorse9', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });
});

describe('credential creation', () => {
  it('creates a credential for an existing user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: 'cred-user@example.com',
      displayName: 'Credential User',
    });
    const password = 'InitialPass123';

    const record = await credentialService.createInitialCredential({
      userId: user.id,
      password,
    });

    assert.ok(record.id);
    assert.equal(record.userId, user.id);
    assert.notEqual(record.passwordHash, password);
    assert.equal(record.mustChangePassword, false);
    assert.ok(record.passwordChangedAt);
  });

  it('defaults must_change_password to false but supports true', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: 'must-change@example.com',
      displayName: 'Must Change',
    });

    const record = await credentialService.createInitialCredential({
      userId: user.id,
      password: 'TempPass123!',
      mustChangePassword: true,
    });

    assert.equal(record.mustChangePassword, true);
  });

  it('rejects a duplicate credential for the same user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: 'dup-cred@example.com',
      displayName: 'Duplicate Credential',
    });

    await credentialService.createInitialCredential({
      userId: user.id,
      password: 'FirstPass123',
    });

    await assert.rejects(
      () =>
        credentialService.createInitialCredential({
          userId: user.id,
          password: 'SecondPass123',
        }),
      rejectsWithCode('CREDENTIAL_ALREADY_EXISTS'),
    );
  });

  it('rejects credential creation for an unknown user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await assert.rejects(
      () =>
        credentialService.createInitialCredential({
          userId: randomUUID(),
          password: 'AnyPass123',
        }),
      rejectsWithCode('USER_NOT_FOUND'),
    );
  });

  it('rejects a password that violates the policy', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: 'policy@example.com',
      displayName: 'Policy User',
    });

    await assert.rejects(
      () =>
        credentialService.createInitialCredential({
          userId: user.id,
          password: 'short',
        }),
      rejectsWithCode('PASSWORD_POLICY_VIOLATION'),
    );
  });
});

describe('password verification (service level)', () => {
  it('returns true for the correct password and false otherwise', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: 'verify@example.com',
      displayName: 'Verify User',
    });
    await credentialService.createInitialCredential({
      userId: user.id,
      password: 'CorrectPass123',
    });

    assert.equal(
      await credentialService.verifyPasswordForUser(user.id, 'CorrectPass123'),
      true,
    );
    assert.equal(
      await credentialService.verifyPasswordForUser(user.id, 'WrongPass123'),
      false,
    );
    assert.equal(
      await credentialService.verifyPasswordForUser(randomUUID(), 'CorrectPass123'),
      false,
    );
  });
});

describe('password update', () => {
  it('updates the hash and password_changed_at', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: 'update@example.com',
      displayName: 'Update User',
    });
    const original = await credentialService.createInitialCredential({
      userId: user.id,
      password: 'OldPass1234',
    });

    const updated = await credentialService.updatePassword(
      user.id,
      'NewPass1234',
    );

    assert.notEqual(updated.passwordHash, original.passwordHash);
    assert.ok(
      updated.passwordChangedAt.getTime() >= original.passwordChangedAt.getTime(),
    );
    assert.ok(Math.abs(Date.now() - updated.passwordChangedAt.getTime()) < 60_000);

    assert.equal(
      await credentialService.verifyPasswordForUser(user.id, 'NewPass1234'),
      true,
    );
    assert.equal(
      await credentialService.verifyPasswordForUser(user.id, 'OldPass1234'),
      false,
    );
  });

  it('rejects update when no credential exists', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: 'no-cred@example.com',
      displayName: 'No Credential',
    });

    await assert.rejects(
      () => credentialService.updatePassword(user.id, 'NewPass1234'),
      rejectsWithCode('CREDENTIAL_NOT_FOUND'),
    );
  });
});

describe('User API safety (BE-01A regression)', () => {
  it('never exposes credential or password fields on the user resource', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: 'safe-output@example.com',
      displayName: 'Safe Output',
    });
    await credentialService.createInitialCredential({
      userId: user.id,
      password: 'HiddenPass123',
    });

    const response = await api()
      .get(`/api/v1/users/${user.id}`)
      .set('authorization', `Bearer ${adminToken}`);

    assert.equal(response.status, 200);

    // Security contract (BE-01A): the user resource must carry the core
    // public identity fields and must NEVER expose credential / password /
    // secret material. We deliberately do NOT assert an exact complete key
    // set: legitimate additive PUBLIC metadata (e.g. the WhatsApp contact +
    // consent fields added by CR-BE-NOTIFY-PROV-01 PART 06) is allowed to
    // appear. The invariant we enforce is the ABSENCE of sensitive fields.
    const keys = Object.keys(response.body.data);
    for (const required of [
      'id',
      'email',
      'displayName',
      'status',
      'createdAt',
      'updatedAt',
    ]) {
      assert.ok(
        keys.includes(required),
        `user resource must include public field ${required}`,
      );
    }

    // Explicitly reject any credential / password / secret field name,
    // including the exact sensitive columns this repository uses.
    const sensitive = keys.filter((key) =>
      /password|passwd|credential|secret|token|hash|salt/i.test(key),
    );
    assert.deepEqual(
      sensitive,
      [],
      `user resource must not expose sensitive fields, got: ${sensitive.join(', ')}`,
    );

    // Defense in depth: the full payload must not serialize the password
    // value or any credential/secret fragment.
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /password|password_hash|passwordHash|token_hash|tokenHash|credential|secret|\bhash\b/i,
    );
  });
});

describe('secret leakage', () => {
  it('never writes the plaintext password or its hash to logs', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: 'no-log@example.com',
      displayName: 'No Log',
    });
    const password = 'NeverLogThisPass123';
    const secondPassword = 'AlsoNeverLogPass123';

    const originalWrite = process.stderr.write.bind(process.stderr);
    const originalLogLevel = process.env.LOG_LEVEL;
    let captured = '';

    process.env.LOG_LEVEL = 'info';
    resetAppConfigCache();
    process.stderr.write = ((chunk: unknown) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const record = await credentialService.createInitialCredential({
        userId: user.id,
        password,
      });
      await credentialService.updatePassword(user.id, secondPassword);

      assert.doesNotMatch(captured, /NeverLogThisPass123/);
      assert.doesNotMatch(captured, /AlsoNeverLogPass123/);
      assert.doesNotMatch(captured, /Sup3r|\\$2[aby]\\$/);
      assert.doesNotMatch(captured, new RegExp(record.passwordHash.replace(/[$]/g, '\\$&')));
      assert.match(captured, /credential\.create/);
      assert.match(captured, /credential\.update_password/);
    } finally {
      process.stderr.write = originalWrite;
      process.env.LOG_LEVEL = originalLogLevel;
      resetAppConfigCache();
    }
  });
});
