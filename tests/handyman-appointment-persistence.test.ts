import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { migration0431CreateHandymanVisitAppointments } from '../src/database/migrations/0431_create_handyman_visit_appointments.ts';
import { appendHandymanVisitAttempt, insertHandymanVisitProposal, listHandymanVisitAppointments } from '../src/modules/handyman-appointment-contract/handyman-appointment.repository.ts';

const statements: string[] = [];
const ddlFake = { query: async (sql: string) => { statements.push(sql); return { rows: [] }; } } as unknown as PoolClient;

test('R1B migration creates both appointment kinds, capacity exclusivity and append-only visit attempts', async () => {
  statements.length = 0;
  await migration0431CreateHandymanVisitAppointments.up(ddlFake);
  const ddl = statements.join('\n');
  for (const sql of [
    'CREATE TABLE handyman_visit_appointments',
    'CREATE TABLE handyman_visit_capacity_reservations',
    'CREATE TABLE handyman_visit_attempts',
    'CREATE EXTENSION IF NOT EXISTS btree_gist',
    'EXCLUDE USING gist',
    'tstzrange(start_at, end_at,',
    'WHERE (active)',
    'handyman_visit_appointments_one_live_per_request_kind',
    "kind IN ('INSPECTION', 'EXECUTION')",
    'handyman_visit_appointment_scope_guard',
    'handyman_visit_capacity_scope_guard',
    'handyman_visit_attempts_immutable',
    'UNIQUE(appointment_id, idempotency_key)',
  ]) assert.ok(ddl.includes(sql), `missing expected schema invariant: ${sql}`);
  assert.ok(!ddl.includes('ALTER TABLE handyman_request_inspections'));
  assert.ok(!ddl.includes('ALTER TABLE handyman_scheduling_readiness'));
});

test('R1B migration down removes new tables without deleting btree_gist', async () => {
  statements.length = 0;
  await migration0431CreateHandymanVisitAppointments.down(ddlFake);
  const ddl = statements.join('\n');
  assert.match(ddl, /DROP TABLE IF EXISTS handyman_visit_appointments/);
  assert.match(ddl, /DROP TABLE IF EXISTS handyman_visit_attempts/);
  assert.doesNotMatch(ddl, /DROP EXTENSION/);
});

test('R1B proposed visit is request-derived, uses parameterized INSERT and never confirms booking', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const fake = { query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes('FROM handyman_service_requests')) {
      return { rows: [{ clientId: 'client-real', tenantCompanyId: 'tenant-real', buildingId: 'building-real' }] };
    }
    return { rows: [{ id: 'new-visit', state: 'PROPOSED' }] };
  } } as unknown as Pick<PoolClient, 'query'>;
  const result = await insertHandymanVisitProposal(fake, {
    handymanRequestId: 'request-1', kind: 'INSPECTION', resourceId: 'inspector-1',
    interval: { startAt: '2026-10-19T09:00:00+07:00', endAt: '2026-10-19T10:00:00+07:00', timezone: 'Asia/Jakarta' },
    createdByUserId: 'authenticated-user',
  });
  assert.equal(result.state, 'PROPOSED');
  assert.match(calls[0].sql, /FOR UPDATE/);
  assert.match(calls[1].sql, /'PROPOSED'/);
  assert.equal(calls[1].params[1], 'client-real');
  assert.equal(calls[1].params[3], 'tenant-real');
  assert.equal(calls[1].params[4], 'building-real');
  assert.equal(calls[1].params[7], 'INSPECTOR_USER');
});

test('R1B execution proposals cannot be created without execution scope', async () => {
  await assert.rejects(() => insertHandymanVisitProposal(ddlFake, {
    handymanRequestId: 'request-1', kind: 'EXECUTION', resourceId: 'crew-1',
    interval: { startAt: '2026-10-19T09:00:00Z', endAt: '2026-10-19T10:00:00Z', timezone: 'Asia/Jakarta' },
    createdByUserId: 'actor-1',
  }), /APPOINTMENT_SCOPE_KIND_MISMATCH/);
});

test('R1B appointment list scoped by both client and request', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const fake = { query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params }); return { rows: [] };
  } } as unknown as Pick<PoolClient, 'query'>;
  await listHandymanVisitAppointments(fake, 'client-1', 'request-1');
  assert.match(calls[0].sql, /client_id = \$1 AND handyman_request_id = \$2/);
  assert.deepEqual(calls[0].params, ['client-1', 'request-1']);
});

test('R1B attempt idempotency replays the same outcome without a second insert', async () => {
  let called = 0;
  const fake = { query: async () => (++called === 1 ? { rows: [] } : {
    rows: [{ id: 'attempt-1', outcome: 'NO_SHOW', actorUserId: 'inspector-1', evidenceReference: null, reason: 'Tenant absent' }],
  }) } as unknown as Pick<PoolClient, 'query'>;
  const result = await appendHandymanVisitAttempt(fake, {
    appointmentId: 'appointment-1', actorUserId: 'inspector-1',
    outcome: 'NO_SHOW', reason: 'Tenant absent', idempotencyKey: 'key-0123456789',
  });
  assert.equal(result.reused, true);
  assert.equal(called, 2);
});

test('R1B reused attempt key with different business result is rejected', async () => {
  let called = 0;
  const fake = { query: async () => (++called === 1 ? { rows: [] } : {
    rows: [{ id: 'attempt-1', outcome: 'COMPLETED', actorUserId: 'inspector-1', evidenceReference: null, reason: null }],
  }) } as unknown as Pick<PoolClient, 'query'>;
  await assert.rejects(() => appendHandymanVisitAttempt(fake, {
    appointmentId: 'appointment-1', actorUserId: 'inspector-1',
    outcome: 'NO_SHOW', idempotencyKey: 'key-0123456789',
  }), /HANDYMAN_VISIT_IDEMPOTENCY_CONFLICT/);
});

test('R1B deferred guard forbids confirmed bookings without active capacity at commit', async () => {
  statements.length = 0;
  await migration0431CreateHandymanVisitAppointments.up(ddlFake);
  const ddl = statements.join('\n');
  assert.match(ddl, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(ddl, /handyman_visit_capacity_commit_guard/);
  assert.match(ddl, /appointment_state IN \('CONFIRMED','IN_PROGRESS'\)/);
  assert.match(ddl, /Appointment identity and slot are immutable/);
});

test('R1B structural FK enforces correct request/tenant/building and execution scope', async () => {
  statements.length = 0;
  await migration0431CreateHandymanVisitAppointments.up(ddlFake);
  const ddl = statements.join('\n');
  assert.match(ddl, /FOREIGN KEY \(handyman_request_id, client_id\)/);
  assert.match(ddl, /expected.tenant_company_id IS DISTINCT FROM NEW.tenant_company_id/);
  assert.match(ddl, /es.handyman_request_id = NEW.handyman_request_id/);
  assert.match(ddl, /resource_type = 'INSPECTOR_USER'/);
  assert.match(ddl, /resource_type = 'CREW'/);
});
