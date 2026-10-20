import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {MY_JOBS_SQL,MY_INSPECTIONS_SQL} from '../src/modules/handyman-field-feed/handyman-field-feed.service';

test('field feed scopes to authenticated user and active building',()=>{
 for(const sql of [MY_JOBS_SQL,MY_INSPECTIONS_SQL]){
  assert.match(sql,/\$1/);assert.match(sql,/user_building_assignments/);
  assert.match(sql,/uba\.status='ACTIVE'/);assert.match(sql,/LIMIT 100/);
 }
});
test('current lead is append-only, not historical or permission-derived',()=>{
 assert.match(MY_JOBS_SQL,/ORDER BY cl\.lead_seq DESC LIMIT 1/);
 assert.match(MY_JOBS_SQL,/cm\.handyman_crew_id=crew\.id/);
 assert.match(MY_JOBS_SQL,/a\.status='ACTIVE'/);
});
test('execution feed excludes proposals; R1C inspector queue shows live bookings only',()=>{
 // EXECUTION stays CONFIRMED/IN_PROGRESS-only: an unconfirmed proposal is
 // never scheduled work (R1C preserved).
 assert.match(MY_JOBS_SQL,/booked\.state IN \('CONFIRMED','IN_PROGRESS'\)/);
 // R1C visit-booking-authority merged the inspector lane: PROPOSED and
 // TENANT_SELECTED visits ARE inspector work-queue items, while terminal
 // states (CANCELLED/COMPLETED/NO_SHOW) never appear.
 assert.match(MY_INSPECTIONS_SQL,/v\.state IN \('PROPOSED','TENANT_SELECTED','CONFIRMED','IN_PROGRESS'\)/);
 assert.doesNotMatch(MY_INSPECTIONS_SQL,/CANCELLED|COMPLETED|NO_SHOW/);
});
