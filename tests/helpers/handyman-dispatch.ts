import { randomUUID } from 'node:crypto';
import { handymanDispatchService } from '../../src/modules/handyman-dispatch';
import { createHandymanPermitReadiness, createHandymanUnitAccessReadiness } from '../../src/modules/handyman-scheduling';
import { handymanScopeAssignmentRepository } from '../../src/modules/handyman-scope-assignments';

/**
 * Seed the confirmed EXECUTION appointment required by dispatch readiness,
 * then exercise the real release service. The appointment trigger is disabled
 * only for this isolated fixture insert, matching the dispatch-authority
 * suite, so these older work-session suites do not need to reproduce the
 * independent tenant-slot confirmation flow.
 */
export async function releaseDispatchFixture(input: {
  executionScopeId: string;
  handymanCrewId: string;
  actorUserId: string;
  query: (text: string, params?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  const appointmentId = randomUUID();
  const startAt = new Date(Date.now() - 60_000);
  const endAt = new Date(Date.now() + 4 * 3_600_000);

  await input.query(
    'ALTER TABLE handyman_visit_appointments DISABLE TRIGGER ALL',
  );
  try {
    await input.query(
      `INSERT INTO handyman_visit_appointments (
         id, client_id, handyman_request_id, execution_scope_id,
         tenant_company_id, building_id, kind, resource_type, resource_id,
         start_at, end_at, timezone, state, confirmed_by_user_id, confirmed_at,
         created_by_user_id, tenant_choice_evidence_ref, version
       )
       SELECT $1, es.client_id, es.handyman_request_id, es.id,
         es.tenant_company_id, es.building_id, 'EXECUTION', 'CREW', $2,
         $3, $4, COALESCE(b.timezone, 'UTC'), 'CONFIRMED', $5, NOW(),
         $5, 'work-session-fixture', 1
       FROM handyman_execution_scopes es
       JOIN buildings b ON b.id = es.building_id
       WHERE es.id = $6`,
      [
        appointmentId,
        input.handymanCrewId,
        startAt,
        endAt,
        input.actorUserId,
        input.executionScopeId,
      ],
    );
  } finally {
    await input.query(
      'ALTER TABLE handyman_visit_appointments ENABLE TRIGGER ALL',
    );
  }

  await input.query(
    `INSERT INTO handyman_visit_capacity_reservations (
       id, appointment_id, client_id, resource_type, resource_id,
       start_at, end_at, active
     )
     SELECT $1, $2, client_id, 'CREW', $3, $4, $5, TRUE
     FROM handyman_visit_appointments WHERE id = $2`,
    [
      randomUUID(),
      appointmentId,
      input.handymanCrewId,
      startAt,
      endAt,
    ],
  );

  const scope = await handymanScopeAssignmentRepository.findScopeById(undefined, input.executionScopeId);
  if (!scope) throw new Error('Fixture scope missing');
  await createHandymanPermitReadiness({
    handymanRequestId: scope.handymanRequestId, permitType: 'UNIT',
    validFrom: startAt.toISOString(), validUntil: endAt.toISOString(),
    authorizationNote: 'Explicit local test permit authorization',
  }, input.actorUserId);
  await createHandymanUnitAccessReadiness({
    handymanRequestId: scope.handymanRequestId,
    accessWindowStart: startAt.toISOString(), accessWindowEnd: endAt.toISOString(),
    authorizationNote: 'Explicit local test unit access authorization',
  }, input.actorUserId);

  await handymanDispatchService.releaseHandymanDispatch(
    {
      executionScopeId: input.executionScopeId,
      appointmentId,
    },
    input.actorUserId,
  );
}
