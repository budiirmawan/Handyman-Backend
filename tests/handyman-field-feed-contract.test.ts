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
test('unconfirmed proposals are not scheduled inspections or execution',()=>{
 assert.match(MY_JOBS_SQL,/booked\.state IN \('CONFIRMED','IN_PROGRESS'\)/);
 assert.match(MY_INSPECTIONS_SQL,/v\.state IN \('CONFIRMED','IN_PROGRESS'\)/);
 assert.doesNotMatch(MY_INSPECTIONS_SQL,/PROPOSED/);
});
