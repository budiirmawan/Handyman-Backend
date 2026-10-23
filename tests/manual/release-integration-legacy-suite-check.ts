/**
 * CR-HM-BACKEND-RELEASE-INTEGRATION-01 PART 02 — legacy suite reconciliation.
 *
 * Three suites in this repository call `ensureTestDatabase()` and, when no
 * PostgreSQL server answers on the configured host, they SKIP every test and
 * still exit 0. That made "NOT TESTED" indistinguishable from "PASS" for whole
 * surfaces (work order assignment, evidence commands, evidence files).
 *
 * `skip` is not coverage. This runner starts a DISPOSABLE embedded PostgreSQL
 * 18 cluster, points DB_* at it, and executes those suites for real, then
 * pins the expected test counts so a future silent skip fails the gate instead
 * of quietly reducing the evidence.
 *
 * It writes nothing outside a temporary directory and never touches a real
 * database — the same contract as `release-integration-migration-check.ts`.
 *
 * Usage: npx tsx tests/manual/release-integration-legacy-suite-check.ts
 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEmbeddedTestDatabase } from '../helpers/embedded-test-db';

const PORT = 55442;
const DATABASE = 'asentra_test';

/**
 * The suites that skip without a reachable server, with the number of tests
 * each one must actually execute. The counts are pinned deliberately: if a
 * suite starts skipping again the run fails here rather than reporting green.
 */
const SUITES: { file: string; expected: number }[] = [
  { file: 'tests/work-order-assignment.test.ts', expected: 20 },
  { file: 'tests/handyman-evidence-commands.test.ts', expected: 7 },
  { file: 'tests/evidence-file-api.test.ts', expected: 5 },
];

type Counts = { tests: number; pass: number; fail: number; skipped: number };

function parseCounts(output: string): Counts | null {
  const read = (key: string): number | null => {
    const match = output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const tests = read('tests');
  const pass = read('pass');
  const fail = read('fail');
  const skipped = read('skipped');
  if (tests === null || pass === null || fail === null || skipped === null) {
    return null;
  }
  return { tests, pass, fail, skipped };
}

function runSuite(env: NodeJS.ProcessEnv, file: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', '--test', '--test-concurrency=1', file], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('exit', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function main(): Promise<void> {
  const dir = join(await mkdtemp(join(tmpdir(), 'release-legacy-pg-')), 'data');
  const db = await startEmbeddedTestDatabase({ dir, port: PORT, database: DATABASE });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DB_HOST: '127.0.0.1',
    DB_PORT: String(PORT),
    DB_USER: 'postgres',
    DB_PASSWORD: '',
    DB_NAME: DATABASE,
    DB_SSL: 'false',
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
  };

  const reports: { suite: string; ok: boolean; detail: string }[] = [];

  try {
    for (const suite of SUITES) {
      const { code, output } = await runSuite(env, suite.file);
      const counts = parseCounts(output);

      if (!counts) {
        reports.push({
          suite: suite.file,
          ok: false,
          detail: 'no test summary found in the output',
        });
        continue;
      }

      if (counts.skipped > 0) {
        reports.push({
          suite: suite.file,
          ok: false,
          detail: `${counts.skipped} test(s) SKIPPED — a real database was available, so this is a regression, not a pass`,
        });
        continue;
      }

      if (counts.tests !== suite.expected) {
        reports.push({
          suite: suite.file,
          ok: false,
          detail: `expected ${suite.expected} executed tests, saw ${counts.tests} (coverage moved without this gate being updated)`,
        });
        continue;
      }

      reports.push({
        suite: suite.file,
        ok: counts.fail === 0 && code === 0,
        detail: `${counts.pass}/${counts.tests} passed, ${counts.fail} failed, ${counts.skipped} skipped`,
      });
    }
  } finally {
    await db.stop();
  }

  console.log('\n=== legacy suite reconciliation (disposable PostgreSQL 18) ===');
  for (const report of reports) {
    console.log(`${report.ok ? 'PASS' : 'FAIL'}  ${report.suite}\n      ${report.detail}`);
  }
  const failed = reports.filter((r) => !r.ok).length;
  console.log(`\n${reports.length - failed}/${reports.length} suites executed and green.`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main();
