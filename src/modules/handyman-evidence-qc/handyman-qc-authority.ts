import type { PoolClient } from 'pg';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations';
import {
  handymanScopeAssignmentRepository,
  resolveHandymanAssignmentLead,
} from '../handyman-scope-assignments';
import { permissionService } from '../permissions';
import { handymanQcNotAuthorizedError } from './handyman-evidence-qc.errors';

/**
 * A reporting line identifies the current supervisor of the assigned Crew
 * Lead; it does NOT grant a permission by itself. Handyman QC additionally
 * requires this dedicated, explicitly granted RBAC capability and exact
 * Client/Building access. Neither tenant_company.manage nor the inspector's
 * inspection assignment implies this capability.
 */
export const HANDYMAN_QC_MANAGE_PERMISSION = 'handyman.qc.manage';

export async function lockHandymanQcScope(
  tx: PoolClient,
  executionScopeId: string,
) {
  // Assignment/reassignment and QC commands use this same scope-row lock.
  // Always acquire it before locking a run or defect to avoid lock inversion.
  const parent=(await tx.query<{original_scope_id:string}>(
    'SELECT original_scope_id FROM handyman_warranty_rework_executions WHERE execution_scope_id=$1',[executionScopeId])).rows[0];
  if (parent) await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR SHARE',[parent.original_scope_id]);
  const scope = await handymanScopeAssignmentRepository.lockScopeById(
    tx, executionScopeId,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  return scope;
}

export async function isHandymanQcSupervisor(
  executionScopeId: string,
  clientId: string,
  actorUserId: string,
  tx: PoolClient,
): Promise<boolean> {
  const permissions = await permissionService.resolvePermissionsForUser(
    actorUserId,
  );
  if (!permissions.includes(HANDYMAN_QC_MANAGE_PERMISSION)) return false;

  const assignment = await handymanScopeAssignmentRepository
    .findActiveAssignmentByScope(tx, executionScopeId);
  if (!assignment || assignment.clientId !== clientId) return false;

  // Lead designations take the crew-row lock. Holding it through the QC
  // decision prevents the Lead from changing between authority resolution
  // and the committed mutation.
  const crew = await tx.query(
    `SELECT id FROM handyman_work_crews
      WHERE id = $1 AND client_id = $2 AND status = 'ACTIVE'
      FOR UPDATE`,
    [assignment.handymanCrewId, clientId],
  );
  if (!crew.rows[0]) return false;
  const lead = await resolveHandymanAssignmentLead(
    executionScopeId, actorUserId,
  );
  if (!lead || lead.assignmentId !== assignment.id
      || lead.leadUserId === actorUserId) return false;

  // Resolve the ACTIVE, effective BE-03F reporting line through the actual
  // lead worker context. Check BOTH organizations' Client identities, the
  // supervisor's live User, and non-membership in the executing crew. A
  // broad Operations role, an inspector booking, or a frontend persona alone
  // cannot establish this relation. Lock the line/profiles so deactivation
  // cannot invalidate this decision before commit.
  const result = await tx.query(
    `SELECT rl.id
       FROM handyman_worker_contexts wc
       JOIN workforce_profiles lead_wp ON lead_wp.id = wc.workforce_profile_id
       JOIN organizations lead_org ON lead_org.id = lead_wp.organization_id
       JOIN workforce_reporting_lines rl
         ON rl.workforce_profile_id = lead_wp.id
       JOIN workforce_profiles sup_wp
         ON sup_wp.id = rl.supervisor_workforce_profile_id
       JOIN organizations sup_org ON sup_org.id = sup_wp.organization_id
       JOIN users u ON u.id = sup_wp.user_id
      WHERE wc.id = $1 AND wc.status = 'ACTIVE'
        AND lead_wp.user_id = $2 AND lead_wp.status = 'ACTIVE'
        AND lead_org.client_id = $3 AND sup_org.client_id = $3
        AND sup_wp.user_id = $4 AND sup_wp.status = 'ACTIVE'
        AND u.status = 'ACTIVE'
        AND rl.status = 'ACTIVE'
        AND (rl.effective_from IS NULL OR rl.effective_from <= NOW())
        AND (rl.effective_until IS NULL OR rl.effective_until >= NOW())
        AND NOT EXISTS (
          SELECT 1 FROM handyman_crew_memberships m
          JOIN handyman_worker_contexts member_wc
            ON member_wc.id = m.handyman_worker_context_id
          JOIN workforce_profiles member_wp
            ON member_wp.id = member_wc.workforce_profile_id
          WHERE m.handyman_crew_id = $5 AND m.status = 'ACTIVE'
            AND member_wp.user_id = $4
        )
      FOR SHARE OF wc, lead_wp, rl, sup_wp, u`,
    [lead.leadWorkerContextId, lead.leadUserId, clientId,
      actorUserId, assignment.handymanCrewId],
  );
  return result.rows.length > 0;
}

export async function assertHandymanQcSupervisor(
  scope: { id: string; clientId: string; buildingId: string },
  actorUserId: string,
  tx: PoolClient,
): Promise<void> {
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });
  if (!(await isHandymanQcSupervisor(
    scope.id, scope.clientId, actorUserId, tx,
  ))) {
    throw handymanQcNotAuthorizedError();
  }
}
