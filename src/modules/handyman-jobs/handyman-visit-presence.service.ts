import { withTransaction } from '../../database';
import { recordOperationalEvent } from '../operational-events';
import { loadJobContext } from './handyman-job.service';
import { handymanServiceVisitNotFoundError } from './handyman-service-visit.errors';
import { handymanServiceVisitRepository } from './handyman-service-visit.repository';
import {
  assertHandymanVisitExecutionReadAccess,
  resolveFieldActorActiveBindingIds,
} from './handyman-visit-lead-chain';
import {
  handymanVisitPresenceActorNotLeadError,
  handymanVisitPresenceAssistedReasonRequiredError,
  handymanVisitPresenceMemberNotFoundError,
  handymanVisitPresenceNotCapturedError,
  handymanVisitPresenceStatusInvalidError,
} from './handyman-visit-presence.errors';
import { handymanVisitPresenceRepository } from './handyman-visit-presence.repository';
import {
  isHandymanVisitPresenceMark,
  type HandymanVisitPresenceEvaluation,
  type HandymanVisitPresenceReadView,
  type HandymanVisitPresenceRecord,
  type PublicHandymanVisitPresence,
  type RecordAssistedPresenceInput,
  type RecordPresenceByLeadInput,
} from './handyman-visit-presence.types';

/**
 * CR-HM-BE-06 RUN 1 — governed crew presence recording + the pure
 * execution-start presence evaluation consumed by Run 2.
 *
 * Governance encoded here:
 * - SNAPSHOT-BOUND: only members of the visit's presence snapshot (created
 *   atomically with the one VERIFIED arrival) can ever be marked. Arbitrary
 *   vendor workforce binding ids are rejected with a 404 — presence rows
 *   are never inserted outside the arrival transaction. Later crew
 *   membership changes never rewrite the snapshot; the frozen composition
 *   identity on each row stays authoritative for this visit.
 * - LEAD FIELD PATH: the authenticated user must resolve through the
 *   governed chain (user → BE-03C profile → ACTIVE BE-06F binding) onto the
 *   snapshot's LEAD_WORKER row. No hardcoded RBAC role names; helpers never
 *   authenticate (they have no user link, so the chain resolves to nothing
 *   for them by construction). The lead may mark themselves and any helper.
 * - STAFF-ASSISTED PATH: an explicit override through the EXISTING BE-05
 *   visit-management access idiom (loadJobContext), with a mandatory
 *   non-empty reason and the REAL recorder attributed (recorded_via =
 *   STAFF_ASSISTED) — never a silent impersonation of the Lead Worker.
 * - Marks are operational facts with full attribution (recorder, time,
 *   path); re-marking is allowed and last-writer-wins under the visit-row
 *   lock + snapshot-row lock (the Run-2 lock-order family head is kept:
 *   visit first).
 * - NOT attendance: no attendance_records row, no shift/roster semantics,
 *   no payroll or invoice meaning — duration and presence never become
 *   billing facts.
 *
 * Audit: HANDYMAN_VISIT_PRESENCE_RECORDED with IDs, role, status and the
 * recording path only — never worker PII (none exists on the rows) and
 * never the assisted free-text reason (it lives on the presence row).
 */

export function toPublicHandymanVisitPresence(
  record: HandymanVisitPresenceRecord,
): PublicHandymanVisitPresence {
  // The assisted free-text reason deliberately stays off the read model.
  return {
    id: record.id,
    clientId: record.clientId,
    handymanServiceVisitId: record.handymanServiceVisitId,
    handymanVisitArrivalId: record.handymanVisitArrivalId,
    handymanJobAssignmentId: record.handymanJobAssignmentId,
    handymanWorkCrewId: record.handymanWorkCrewId,
    vendorWorkforceBindingId: record.vendorWorkforceBindingId,
    crewRole: record.crewRole,
    presenceStatus: record.presenceStatus,
    recordedVia: record.recordedVia,
    recordedByUserId: record.recordedByUserId,
    recordedAt: record.recordedAt ? record.recordedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function requireMark(value: unknown): 'PRESENT' | 'ABSENT' {
  if (!isHandymanVisitPresenceMark(value)) {
    throw handymanVisitPresenceStatusInvalidError();
  }
  return value;
}

async function requireSnapshot(visitId: string) {
  const rows = await handymanVisitPresenceRepository.listByVisitId(visitId);
  if (rows.length === 0) {
    throw handymanVisitPresenceNotCapturedError();
  }
  return rows;
}

async function auditPresenceMark(
  row: HandymanVisitPresenceRecord,
  actorUserId: string,
  tx: Parameters<Parameters<typeof withTransaction>[0]>[0],
): Promise<void> {
  await recordOperationalEvent(
    {
      clientId: row.clientId,
      eventType: 'HANDYMAN_VISIT_PRESENCE_RECORDED',
      entityType: 'HANDYMAN_VISIT_PRESENCE',
      entityId: row.id,
      actorUserId,
      summary: 'Handyman visit crew presence recorded',
      metadata: {
        handymanServiceVisitId: row.handymanServiceVisitId,
        handymanVisitArrivalId: row.handymanVisitArrivalId,
        vendorWorkforceBindingId: row.vendorWorkforceBindingId,
        crewRole: row.crewRole,
        presenceStatus: row.presenceStatus,
        recordedVia: row.recordedVia,
      },
    },
    tx,
  );
}

/* ------------------------------------------------------------------ */
/* LEAD FIELD MARK                                                      */
/* ------------------------------------------------------------------ */

/**
 * Marks one snapshot member PRESENT/ABSENT through the authenticated Lead
 * Worker field path. The lead may mark themselves and any helper; helpers
 * never authenticate. The chain resolves against the FROZEN snapshot (the
 * composition at VERIFIED-arrival time), so later crew changes never move
 * this visit's presence authority.
 */
export async function recordHandymanVisitPresenceByLead(
  visitId: string,
  input: RecordPresenceByLeadInput,
  actorUserId: string,
): Promise<PublicHandymanVisitPresence> {
  const mark = requireMark(input.presenceStatus);
  const rows = await requireSnapshot(visitId);
  const leadRow = rows.find((row) => row.crewRole === 'LEAD_WORKER');
  if (!leadRow) {
    // Structurally impossible (the composition guarantees exactly one
    // ACTIVE lead at snapshot time) — fail closed, never guess.
    throw handymanVisitPresenceActorNotLeadError();
  }
  const actorBindingIds = await resolveFieldActorActiveBindingIds(actorUserId);
  if (!actorBindingIds.includes(leadRow.vendorWorkforceBindingId)) {
    throw handymanVisitPresenceActorNotLeadError();
  }
  const target = rows.find(
    (row) => row.vendorWorkforceBindingId === input.vendorWorkforceBindingId,
  );
  if (!target) {
    throw handymanVisitPresenceMemberNotFoundError();
  }

  return withTransaction(async (tx) => {
    // Lock-order family head: the visit row first.
    const lockedVisit = await handymanServiceVisitRepository.lockVisitById(
      visitId,
      tx,
    );
    if (!lockedVisit) {
      throw handymanServiceVisitNotFoundError();
    }
    const lockedRow =
      await handymanVisitPresenceRepository.lockByVisitAndBinding(
        visitId,
        input.vendorWorkforceBindingId,
        tx,
      );
    if (!lockedRow) {
      throw handymanVisitPresenceMemberNotFoundError();
    }
    const updated = await handymanVisitPresenceRepository.markPresence(
      lockedRow.id,
      {
        presenceStatus: mark,
        recordedVia: 'LEAD',
        recordedByUserId: actorUserId,
        assistedReason: null,
      },
      tx,
    );
    if (!updated) {
      throw handymanVisitPresenceMemberNotFoundError();
    }
    await auditPresenceMark(updated, actorUserId, tx);
    return toPublicHandymanVisitPresence(updated);
  });
}

/* ------------------------------------------------------------------ */
/* STAFF-ASSISTED MARK (explicit override, never a lead impersonation)  */
/* ------------------------------------------------------------------ */

/**
 * Marks one snapshot member PRESENT/ABSENT through the staff-assisted
 * path: the EXISTING BE-05 visit-management access idiom (loadJobContext
 * asserts the recorder's client scope), a mandatory non-empty reason, and
 * the REAL recorder attributed as STAFF_ASSISTED — the lead is never
 * silently impersonated.
 */
export async function recordAssistedHandymanVisitPresence(
  visitId: string,
  input: RecordAssistedPresenceInput,
  actorUserId: string,
): Promise<PublicHandymanVisitPresence> {
  const mark = requireMark(input.presenceStatus);
  if (
    typeof input.assistedReason !== 'string' ||
    input.assistedReason.trim() === ''
  ) {
    throw handymanVisitPresenceAssistedReasonRequiredError();
  }
  const visit = await handymanServiceVisitRepository.findVisitById(visitId);
  if (!visit) {
    throw handymanServiceVisitNotFoundError();
  }
  // Staff access authority (existing BE-05 idiom) — the snapshot governs
  // the markable members, not the current composition.
  await loadJobContext(visit.handymanJobId, actorUserId);
  const rows = await requireSnapshot(visitId);
  const target = rows.find(
    (row) => row.vendorWorkforceBindingId === input.vendorWorkforceBindingId,
  );
  if (!target) {
    throw handymanVisitPresenceMemberNotFoundError();
  }

  return withTransaction(async (tx) => {
    const lockedVisit = await handymanServiceVisitRepository.lockVisitById(
      visitId,
      tx,
    );
    if (!lockedVisit) {
      throw handymanServiceVisitNotFoundError();
    }
    const lockedRow =
      await handymanVisitPresenceRepository.lockByVisitAndBinding(
        visitId,
        input.vendorWorkforceBindingId,
        tx,
      );
    if (!lockedRow) {
      throw handymanVisitPresenceMemberNotFoundError();
    }
    const updated = await handymanVisitPresenceRepository.markPresence(
      lockedRow.id,
      {
        presenceStatus: mark,
        recordedVia: 'STAFF_ASSISTED',
        recordedByUserId: actorUserId,
        assistedReason: input.assistedReason,
      },
      tx,
    );
    if (!updated) {
      throw handymanVisitPresenceMemberNotFoundError();
    }
    await auditPresenceMark(updated, actorUserId, tx);
    return toPublicHandymanVisitPresence(updated);
  });
}

/* ------------------------------------------------------------------ */
/* PURE EXECUTION-START PRESENCE EVALUATION (the Run-2 gate input)      */
/* ------------------------------------------------------------------ */

/**
 * Answers: "Does this visit satisfy the minimum execution-start presence
 * rule?" — a PURE READ (no locks, no audit, no mutation):
 *   1. a presence snapshot exists (from the one VERIFIED arrival), and
 *   2. the snapshot's Lead Worker is PRESENT.
 * Helper PRESENT/ABSENT/PENDING states are reported as operational facts
 * but NEVER gate execution start; no minimum-helper staffing policy exists.
 */
export async function evaluateHandymanVisitExecutionPresence(
  visitId: string,
): Promise<HandymanVisitPresenceEvaluation> {
  const rows = await handymanVisitPresenceRepository.listByVisitId(visitId);
  const leadRow = rows.find((row) => row.crewRole === 'LEAD_WORKER') ?? null;
  return {
    handymanServiceVisitId: visitId,
    snapshotExists: rows.length > 0,
    leadPresent: leadRow?.presenceStatus === 'PRESENT',
    leadVendorWorkforceBindingId: leadRow?.vendorWorkforceBindingId ?? null,
    members: rows.map((row) => ({
      vendorWorkforceBindingId: row.vendorWorkforceBindingId,
      crewRole: row.crewRole,
      presenceStatus: row.presenceStatus,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Run-3 HTTP surface — gated presence read                            */
/* ------------------------------------------------------------------ */

/**
 * CR-HM-BE-06 RUN 3 — presence snapshot + evaluation of one visit behind
 * the shared field-execution read scope (staff client access, an involved
 * recorder, or the current composition's Lead Worker). A THIN READ: it
 * composes the EXISTING pure evaluation with the EXISTING public projection
 * — no new domain rule, no mutation, no event, and no gate decision (the
 * Run-2 execution start remains the sole consumer of presence authority).
 * Before the one VERIFIED arrival the snapshot does not exist yet: the view
 * reports `snapshotExists: false` with an empty presence list (a factual
 * read, never an error).
 */
export async function getHandymanVisitExecutionPresence(
  visitId: string,
  actorUserId: string,
): Promise<HandymanVisitPresenceReadView> {
  const visit = await handymanServiceVisitRepository.findVisitById(visitId);
  if (!visit) {
    throw handymanServiceVisitNotFoundError();
  }
  const rows = await handymanVisitPresenceRepository.listByVisitId(visitId);
  await assertHandymanVisitExecutionReadAccess(
    visit,
    actorUserId,
    rows
      .map((row) => row.recordedByUserId)
      .filter((userId): userId is string => userId !== null),
  );
  const evaluation = await evaluateHandymanVisitExecutionPresence(visitId);
  return {
    handymanServiceVisitId: evaluation.handymanServiceVisitId,
    snapshotExists: evaluation.snapshotExists,
    leadPresent: evaluation.leadPresent,
    leadVendorWorkforceBindingId: evaluation.leadVendorWorkforceBindingId,
    presence: rows.map(toPublicHandymanVisitPresence),
  };
}
