#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
let manifestPath = path.join(repository, 'scripts/ci/focused-tests.json');
if (args[0] === '--manifest') {
  if (!args[1] || !args[2]) {
    throw new Error('Usage: run-focused-tests.mjs [--manifest PATH] LANE');
  }
  manifestPath = path.resolve(args[1]);
  args.splice(0, 2);
}
const lane = args[0];
if (!lane || args.length !== 1) {
  throw new Error('Usage: run-focused-tests.mjs [--manifest PATH] LANE');
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const configuration = manifest[lane];
if (!configuration || !Array.isArray(configuration.tests) || configuration.tests.length === 0) {
  throw new Error(`Unknown or empty focused-test lane: ${lane}`);
}

const outputDirectory = path.resolve(
  process.env.CI_ARTIFACT_DIR ?? path.join(tmpdir(), `handyman-ci-${lane}`),
);
await mkdir(outputDirectory, { recursive: true });
const tsxCli = path.join(repository, 'node_modules/tsx/dist/cli.mjs');
const results = [];

function tapCount(output, key) {
  const match = output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
  return match ? Number(match[1]) : null;
}

function terminateProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function execute(test, index) {
  const startedAt = Date.now();
  const testArguments = [
    tsxCli,
    '--test',
    '--test-reporter=tap',
    '--test-concurrency=1',
  ];
  if (test.namePattern) {
    testArguments.push('--test-name-pattern', test.namePattern);
  }
  if (test.skipPattern) {
    testArguments.push('--test-skip-pattern', test.skipPattern);
  }
  testArguments.push(path.join(repository, test.file));

  const child = spawn(process.execPath, testArguments, {
    cwd: repository,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  let timedOut = false;
  const timeoutMs = test.timeoutMs ?? configuration.timeoutMs ?? 900000;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child, 'SIGTERM');
    const force = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), 5000);
    force.unref();
  }, timeoutMs);

  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, exitSignal) => {
      resolve({ code: exitCode, signal: exitSignal });
    });
  }).finally(() => clearTimeout(timeout));

  const counts = {
    tests: tapCount(output, 'tests'),
    pass: tapCount(output, 'pass'),
    fail: tapCount(output, 'fail'),
    cancelled: tapCount(output, 'cancelled'),
    skipped: tapCount(output, 'skipped'),
    todo: tapCount(output, 'todo'),
  };
  const failures = [];
  if (timedOut) failures.push(`timeout after ${timeoutMs}ms`);
  if (code !== 0) failures.push(`exit=${code ?? 'null'} signal=${signal ?? 'none'}`);
  for (const [key, value] of Object.entries(counts)) {
    if (value === null) failures.push(`missing TAP # ${key} count`);
  }
  if (counts.pass !== test.pass) {
    failures.push(`expected PASS=${test.pass}, actual PASS=${counts.pass ?? 'missing'}`);
  }
  if (counts.tests !== test.pass) {
    failures.push(`expected TESTS=${test.pass}, actual TESTS=${counts.tests ?? 'missing'}`);
  }
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) {
    if (counts[key] !== 0) failures.push(`expected ${key.toUpperCase()}=0, actual=${counts[key] ?? 'missing'}`);
  }

  const artifactName = `${String(index + 1).padStart(3, '0')}-${path.basename(test.file)}.tap`;
  await writeFile(path.join(outputDirectory, artifactName), output, 'utf8');
  return {
    file: test.file,
    namePattern: test.namePattern ?? null,
    skipPattern: test.skipPattern ?? null,
    selectionReason: test.selectionReason ?? null,
    expectedPass: test.pass,
    ...counts,
    exitCode: code,
    signal,
    timedOut,
    durationMs: Date.now() - startedAt,
    artifact: artifactName,
    failures,
    output,
  };
}

for (const [index, test] of configuration.tests.entries()) {
  if (!test.file || !Number.isInteger(test.pass) || test.pass <= 0) {
    throw new Error(`Invalid manifest entry at ${lane}[${index}]`);
  }
  if (test.namePattern && test.skipPattern) {
    throw new Error(`Manifest entry cannot combine namePattern and skipPattern: ${test.file}`);
  }
  if ((test.namePattern || test.skipPattern) && !test.selectionReason) {
    throw new Error(`Filtered manifest entry lacks selectionReason: ${test.file}`);
  }
  const result = await execute(test, index);
  results.push(result);
  const status = result.failures.length === 0 ? 'PASS' : 'FAIL';
  console.log(
    `${status} | ${lane} | ${result.file} | ` +
    `PASS=${result.pass ?? 0} FAIL=${result.fail ?? 0} SKIPPED=${result.skipped ?? 0} ` +
    `EXPECTED=${result.expectedPass} EXIT=${result.exitCode ?? 'null'} ` +
    `DURATION_MS=${result.durationMs}`,
  );
  if (result.selectionReason) console.log(`SELECTION | ${result.selectionReason}`);
  if (result.failures.length > 0) {
    console.error(`FAILURE_REASONS | ${result.file} | ${result.failures.join('; ')}`);
    console.error(`----- BEGIN ${result.file} -----\n${result.output}\n----- END ${result.file} -----`);
  }
}

const totals = results.reduce((sum, result) => ({
  pass: sum.pass + (result.pass ?? 0),
  fail: sum.fail + (result.fail ?? 0),
  skipped: sum.skipped + (result.skipped ?? 0),
}), { pass: 0, fail: 0, skipped: 0 });
const failedFiles = results.filter((result) => result.failures.length > 0);
const summary = {
  lane,
  manifest: path.relative(repository, manifestPath),
  files: results.length,
  ...totals,
  failedFiles: failedFiles.length,
  status: failedFiles.length === 0 ? 'PASS' : 'FAIL',
  results: results.map(({ output, ...result }) => result),
};
await writeFile(
  path.join(outputDirectory, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  'utf8',
);
const markdown = [
  `## ${lane}: ${summary.status}`,
  '',
  `**Totals:** ${totals.pass} PASS / ${totals.fail} FAIL / ${totals.skipped} SKIPPED across ${results.length} files.`,
  '',
  '| Test file | Expected | PASS | FAIL | SKIPPED | Exit | Result |',
  '|---|---:|---:|---:|---:|---:|---|',
  ...results.map((result) =>
    `| \`${result.file}\`${result.namePattern ? ` (name filter: \`${result.namePattern}\`)` : ''}${result.skipPattern ? ` (skip filter: \`${result.skipPattern}\`)` : ''} ` +
    `| ${result.expectedPass} | ${result.pass ?? 'missing'} | ${result.fail ?? 'missing'} ` +
    `| ${result.skipped ?? 'missing'} | ${result.exitCode ?? 'null'} ` +
    `| ${result.failures.length === 0 ? 'PASS' : `FAIL: ${result.failures.join('; ')}`} |`,
  ),
  '',
].join('\n');
await writeFile(path.join(outputDirectory, 'summary.md'), markdown, 'utf8');

console.log(
  `LANE_${summary.status} | ${lane} | FILES=${results.length} ` +
  `PASS=${totals.pass} FAIL=${totals.fail} SKIPPED=${totals.skipped} ` +
  `FAILED_FILES=${failedFiles.length}`,
);
console.log(`ARTIFACTS | ${outputDirectory}`);
if (failedFiles.length > 0) process.exitCode = 1;
