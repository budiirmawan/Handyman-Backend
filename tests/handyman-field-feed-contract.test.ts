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
test('CR-HM-FIELD-OPS-ACK-01 PART 01: both feeds project assignmentId + target type',()=>{
 assert.match(MY_JOBS_SQL,/a\.id AS "assignmentId"/);
 assert.match(MY_JOBS_SQL,/COALESCE\(ar\.assignment_target_type, 'EXECUTION_SCOPE_ASSIGNMENT'\) AS "assignmentTargetType"/);
 assert.match(MY_JOBS_SQL,/a\.version AS "assignmentVersion"/);
 assert.match(MY_INSPECTIONS_SQL,/ia\.id AS "assignmentId"/);
 assert.match(MY_INSPECTIONS_SQL,/COALESCE\(ar\.assignment_target_type, 'INSPECTOR_VISIT_ASSIGNMENT'\) AS "assignmentTargetType"/);
 // The response/audit projection is tenant-bound at SQL level, not merely by id.
 assert.match(MY_JOBS_SQL,/ar\.client_id=es\.client_id AND ar\.building_id=es\.building_id/);
 assert.match(MY_INSPECTIONS_SQL,/ia\.client_id = v\.client_id/);
 assert.match(MY_INSPECTIONS_SQL,/ar\.client_id = v\.client_id AND ar\.building_id = v\.building_id/);
 // A declined assignment must not remain actionable in the worker feed.
 assert.match(MY_JOBS_SQL,/COALESCE\(ar\.response_status, 'PENDING'\) <> 'TIDAK_BISA'/);
 assert.match(MY_INSPECTIONS_SQL,/COALESCE\(ar\.response_status, 'PENDING'\) <> 'TIDAK_BISA'/);
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
