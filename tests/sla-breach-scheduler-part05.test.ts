import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const repo = readFileSync('src/modules/applied-slas/applied-sla.repository.ts', 'utf8');
const lifecycle = readFileSync('src/modules/applied-slas/sla-clock-lifecycle.service.ts', 'utf8');
const dispatcher = readFileSync('src/modules/due-job-dispatcher/due-job-dispatcher.service.ts', 'utf8');
const migration = readFileSync('src/database/migrations/0294_add_sla_clock_breach.ts', 'utf8');

test('due scheduler path persists a breach and emits the operational event', () => {
  assert.match(dispatcher, /processDueSlaClocks/);
  assert.match(repo, /UPDATE sla_clocks SET breached_at/);
  assert.match(lifecycle, /SLA_CLOCK_BREACHED/);
});

test('breach persistence and event emission are first-write idempotent', () => {
  assert.match(repo, /breached_at IS NULL/);
  assert.match(repo, /RETURNING/);
  assert.match(lifecycle, /if\(b\)await event/);
});

test('late lifecycle transitions evaluate breach before satisfaction or termination', () => {
  assert.match(lifecycle, /await evaluateBreach\(w,type,at,tx\)/);
  assert.match(lifecycle, /transitionClock\(c.id,'SATISFIED'/);
  assert.match(lifecycle, /transitionClock\(c.id,'TERMINATED'/);
});

test('breached_at is historical and does not add a BREACHED clock state', () => {
  assert.match(migration, /ADD COLUMN breached_at/);
  assert.doesNotMatch(migration, /BREACHED/);
  assert.doesNotMatch(repo, /status='BREACHED'/);
});

test('resolution due evaluation subtracts pause intervals while response does not', () => {
  assert.match(repo, /clock_type='RESOLUTION'/);
  assert.match(repo, /sla_clock_pause_intervals/);
  assert.match(repo, /'RESPONSE'\|'RESOLUTION'/);
});
