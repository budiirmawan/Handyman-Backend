import { getPool } from '../../database';
import { resolveCurrentSupervisor } from '../workforce-reporting-lines';
import type { RecipientScope, RecipientSpec } from '../recipient-resolution';
import type {
  SlaEscalationDerivedTarget,
  SlaEscalationRecipientRule,
} from '../sla-escalation-policies/sla-escalation-policy.types';
import type { SlaEscalationActionRecord } from './sla-escalation-action.types';

/**
 * CR-BE-SLA-02 PART 03 — derived recipient-target expansion.
 *
 * PART 01 stores two kinds of recipient target on a level's `recipient_rule`:
 * static BE-26C `specs[]`, and `derived[]` targets that can only be known at
 * breach time (who is assigned, who supervises them, who is responsible for the
 * Building). BE-26C resolves the first kind and must not learn about the
 * second — so this module is the *adapter*: it expands each derived target into
 * ordinary BE-26C specs, and `resolveRecipients` remains the only resolver.
 *
 * BOUNDARY
 * --------
 * Every expansion follows a link that ALREADY EXISTS in the schema:
 *
 *   - `work_order_assignments` (BE-08E, one ACTIVE row per Work Order),
 *   - `workforceReportingLineService.resolveCurrentSupervisor` (BE-03F),
 *   - `work_orders.created_by_user_id` (NOT NULL),
 *   - `roles` / `permissions` + the BE-02F Building scope BE-26C applies.
 *
 * No organization relationship is invented. In particular there is no team
 * supervisor relation, so a TEAM assignee has no supervisor and expands to
 * nothing rather than to a guess. Every expansion is read-only.
 *
 * "Building operational responsibility" is deliberately modelled as
 * `BUILDING_ROLE` / `BUILDING_PERMISSION` — "users holding this role/permission
 * who can access this Building" — because the enforced scope (below) already
 * pins the Building. The repository has no building-manager column and this CR
 * does not add one.
 */

/** The `work_order_assignments` fields expansion needs. */
type ActiveAssignment = {
  assigneeType: 'WORKFORCE' | 'TEAM' | 'VENDOR' | 'VENDOR_WORKFORCE';
  workforceProfileId: string | null;
  teamId: string | null;
  vendorId: string | null;
};

async function findActiveAssignment(workOrderId: string): Promise<ActiveAssignment | null> {
  return (
    await getPool().query<ActiveAssignment>(
      `SELECT assignee_type AS "assigneeType",workforce_profile_id AS "workforceProfileId",
              team_id AS "teamId",vendor_id AS "vendorId"
         FROM work_order_assignments WHERE work_order_id=$1 AND status='ACTIVE' LIMIT 1`,
      [workOrderId],
    )
  ).rows[0] ?? null;
}

async function findCreatorUserId(workOrderId: string): Promise<string | null> {
  return (
    await getPool().query<{ createdByUserId: string }>(
      `SELECT created_by_user_id AS "createdByUserId" FROM work_orders WHERE id=$1`,
      [workOrderId],
    )
  ).rows[0]?.createdByUserId ?? null;
}

/**
 * Expands one derived target into zero or more BE-26C specs.
 *
 * Every "no answer" case returns an empty list rather than throwing: a Work
 * Order with no ACTIVE assignment, a TEAM/VENDOR assignee with no supervisor
 * relation, a workforce member with no reporting line. An unresolvable target
 * legitimately contributes no recipients (governance §5.5) — it is not an
 * execution failure.
 */
async function expandTarget(
  target: SlaEscalationDerivedTarget,
  action: Pick<SlaEscalationActionRecord, 'workOrderId'>,
): Promise<RecipientSpec[]> {
  switch (target.kind) {
    case 'WORK_ORDER_ASSIGNEE': {
      const assignment = await findActiveAssignment(action.workOrderId);
      if (!assignment) return [];
      // VENDOR_WORKFORCE carries both a vendor and a workforce profile; the
      // profile is the person actually working, so it wins.
      if (assignment.workforceProfileId) {
        return [{ kind: 'WORKFORCE', workforceProfileId: assignment.workforceProfileId }];
      }
      if (assignment.teamId) return [{ kind: 'TEAM', teamId: assignment.teamId }];
      if (assignment.vendorId) return [{ kind: 'VENDOR_PIC', vendorId: assignment.vendorId }];
      return [];
    }
    case 'WORK_ORDER_ASSIGNEE_SUPERVISOR': {
      const assignment = await findActiveAssignment(action.workOrderId);
      // No assignee, or an assignee that is a Team/Vendor rather than a person:
      // there is no supervisor relation to follow and none is invented.
      if (!assignment?.workforceProfileId) return [];
      const supervisor = await resolveCurrentSupervisor(assignment.workforceProfileId);
      if (!supervisor) return [];
      return [{ kind: 'WORKFORCE', workforceProfileId: supervisor.supervisorWorkforceProfileId }];
    }
    case 'WORK_ORDER_CREATOR': {
      const userId = await findCreatorUserId(action.workOrderId);
      return userId ? [{ kind: 'USER', userId }] : [];
    }
    case 'BUILDING_ROLE':
      // The Building half is the enforced scope below, not a separate filter.
      return target.roleCode ? [{ kind: 'ROLE', roleCode: target.roleCode }] : [];
    case 'BUILDING_PERMISSION':
      return target.permissionCode ? [{ kind: 'PERMISSION', permissionCode: target.permissionCode }] : [];
    default:
      return [];
  }
}

/**
 * The full spec list for a claimed action: the snapshotted static specs first,
 * then the expanded derived targets, in stored order. Duplicates are harmless —
 * BE-26C deduplicates by User id — but they are removed here anyway so the
 * spec list is a faithful description of what was asked for.
 */
export async function expandActionRecipientSpecs(
  action: Pick<SlaEscalationActionRecord, 'workOrderId' | 'recipientRule'>,
): Promise<RecipientSpec[]> {
  const rule = (action.recipientRule ?? {}) as SlaEscalationRecipientRule;
  const specs: RecipientSpec[] = Array.isArray(rule.specs) ? [...rule.specs] : [];

  for (const target of Array.isArray(rule.derived) ? rule.derived : []) {
    specs.push(...(await expandTarget(target, action)));
  }

  const seen = new Set<string>();
  return specs.filter((spec) => {
    const key = JSON.stringify(spec);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The mandatory Client/Building scope (governance §5.4).
 *
 * The action row's OWN `client_id` / `building_id` — snapshotted from the
 * authoritative SLA chain at materialization — are the ceiling. A stored rule
 * may narrow within them; it can never widen beyond them, so a misconfigured
 * policy cannot leak an escalation across Clients or Buildings.
 *
 * Returns `null` when the stored rule narrows to the empty set (it named a
 * different Client, or Buildings that do not include this action's Building).
 * The caller treats that as zero recipients rather than as unscoped resolution
 * — the one outcome that must never be reached by falling back to "no scope".
 */
export function forceActionScope(
  action: Pick<SlaEscalationActionRecord, 'clientId' | 'buildingId' | 'recipientRule'>,
): RecipientScope | null {
  const stored = ((action.recipientRule ?? {}) as SlaEscalationRecipientRule).scope;

  if (stored?.clientId && stored.clientId !== action.clientId) return null;
  if (Array.isArray(stored?.buildingIds) && !stored.buildingIds.includes(action.buildingId)) return null;

  return { clientId: action.clientId, buildingIds: [action.buildingId] };
}
