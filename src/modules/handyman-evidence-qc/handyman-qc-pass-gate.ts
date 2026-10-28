import { assertReworkQcBinding } from './handyman-rework-qc-binding';
import type { PoolClient } from 'pg';
import { assertVerifiedManagedEvidenceReference }
  from '../handyman-field-evidence/handyman-field-evidence.service';
import { handymanExecutionScopeRepository } from '../handyman-quotations';
import { handymanQcPassBlockedError } from './handyman-evidence-qc.errors';
import { lockHandymanQcScope } from './handyman-qc-authority';

/**
 * Read-only consumer gate for the EXISTING QC run decision. BAST PREPARE and
 * variation finance must consume a guarded, CURRENT Supervisor PASS; neither
 * may adjudicate QC themselves or treat a historical unguarded PASS as valid.
 * Scope-row locking serializes this read with QC OPEN/FINISH/reassignment.
 */
export async function assertCurrentGuardedHandymanQcPass(
  tx: PoolClient,
  scope: { id: string; clientId: string; buildingId: string },
  expectedRunId?: string,
): Promise<{ runId: string; templateVersionId: string;
  checklistIdentity: string }> {
  const locked = await lockHandymanQcScope(tx, scope.id);
  if (locked.clientId !== scope.clientId
      || locked.buildingId !== scope.buildingId) {
    throw handymanQcPassBlockedError('QC scope identity mismatch');
  }
  const latest = await tx.query<{
    id: string; status: string; checklist_identity: string;
    created_at: Date; updated_at: Date;
  }>(
    `SELECT id, status, checklist_identity, created_at, updated_at
       FROM handyman_qc_runs
      WHERE execution_scope_id = $1 AND client_id = $2
      ORDER BY created_at DESC, id DESC LIMIT 1 FOR SHARE`,
    [scope.id, scope.clientId],
  );
  const run = latest.rows[0];
  if (!run || run.status !== 'PASSED'
      || (expectedRunId && expectedRunId !== run.id)) {
    throw handymanQcPassBlockedError('latest QC run is not the required PASS');
  }
  await assertReworkQcBinding(tx,scope.id,run.id);
  const manifest = await tx.query<{
    required_item_keys: string[]; checklist_version_id: string;
  }>(
    `SELECT s.required_item_keys, b.checklist_version_id
       FROM handyman_qc_checklist_specs s
       JOIN handyman_qc_scope_checklist_bindings b
         ON b.execution_scope_id = s.execution_scope_id
       JOIN handyman_qc_checklist_versions v
         ON v.id = b.checklist_version_id
        AND v.client_id = s.client_id
        AND v.required_item_keys = s.required_item_keys
      WHERE s.execution_scope_id = $1 AND s.client_id = $2
        AND s.checklist_identity = $3
        AND s.configured_at <= $4 AND b.bound_at <= $4`,
    [scope.id, scope.clientId, run.checklist_identity, run.created_at],
  );
  const spec = manifest.rows[0];
  if (!spec?.required_item_keys.length) {
    throw handymanQcPassBlockedError('no pre-run versioned required checklist');
  }
  const finish = await tx.query<{ actor_user_id: string }>(
    `SELECT actor_user_id FROM handyman_qc_run_events
      WHERE run_id = $1 AND client_id = $2 AND event_type = 'FINISH'
        AND metadata->>'outcome' = 'PASSED'
        AND metadata ? 'expectedVersion'
        AND metadata->>'templateVersionId' = $3
      LIMIT 1`, [run.id, scope.clientId, spec.checklist_version_id],
  );
  if (!finish.rows[0]) {
    throw handymanQcPassBlockedError('missing guarded Supervisor FINISH');
  }
  const items = await tx.query<{ item_key: string; outcome: string }>(
    `SELECT item_key, outcome FROM handyman_qc_run_items
      WHERE run_id = $1 FOR SHARE`, [run.id],
  );
  if (items.rows.length !== spec.required_item_keys.length
      || spec.required_item_keys.some((key) =>
        items.rows.find((item) => item.item_key === key)?.outcome
          !== 'PASS')) {
    throw handymanQcPassBlockedError('required checklist incomplete');
  }
  const unresolved = await tx.query<{ id: string }>(
    `SELECT id FROM handyman_defect_records
      WHERE execution_scope_id = $1 AND client_id = $2
        AND status <> 'VERIFIED' LIMIT 1 FOR SHARE`,
    [scope.id, scope.clientId],
  );
  if (unresolved.rows[0]) {
    throw handymanQcPassBlockedError('unverified defect exists');
  }
  const sessions = await tx.query<{
    status: string; completed_at: Date | null;
  }>(
    `SELECT status, completed_at FROM handyman_work_sessions
      WHERE execution_scope_id = $1 AND client_id = $2 FOR SHARE`,
    [scope.id, scope.clientId],
  );
  const isRework = (await tx.query<{scope_kind:string}>('SELECT scope_kind FROM handyman_execution_scopes WHERE id=$1',[scope.id])).rows[0]?.scope_kind==='WARRANTY_REWORK';
  if ((!isRework && !sessions.rows.length) || sessions.rows.some((row) =>
    !row.completed_at
      || !['COMPLETED', 'CHECKED_OUT'].includes(row.status))) {
    throw handymanQcPassBlockedError('Work Sessions not completed');
  }
  const previous = await tx.query<{
    status: string; updated_at: Date;
  }>(
    `SELECT status, updated_at FROM handyman_qc_runs
      WHERE execution_scope_id = $1 AND id <> $2
      ORDER BY created_at DESC, id DESC LIMIT 1 FOR SHARE`,
    [scope.id, run.id],
  );
  if (previous.rows[0]?.status === 'FAILED'
      && !sessions.rows.some((row) => row.completed_at
        && row.completed_at.getTime()
          > previous.rows[0].updated_at.getTime())) {
    throw handymanQcPassBlockedError('no corrective Work Session since FAIL');
  }
  const files = await tx.query<{
    attachment_reference: string; purpose: string;
    upload_status: string; verified_at: Date | null;
    execution_scope_id: string; client_id: string; building_id: string;
  }>(
    `SELECT u.attachment_reference, u.purpose, u.upload_status,
            u.verified_at, u.execution_scope_id, u.client_id, u.building_id
       FROM handyman_qc_run_evidence qe
       JOIN handyman_field_evidence_uploads u ON u.id = qe.evidence_upload_id
      WHERE qe.run_id = $1`, [run.id],
  );
  if (!files.rows.length) {
    throw handymanQcPassBlockedError('no bound QC upload');
  }
  const fullScope = await handymanExecutionScopeRepository.findScopeById(
    tx, scope.id);
  if (!fullScope) {
    throw handymanQcPassBlockedError('execution scope unavailable');
  }
  for (const file of files.rows) {
    if (!file.attachment_reference || file.purpose !== 'QC_EVIDENCE'
        || file.upload_status !== 'VERIFIED' || !file.verified_at
        || file.execution_scope_id !== scope.id
        || file.client_id !== scope.clientId
        || file.building_id !== scope.buildingId
        || file.verified_at.getTime() < run.created_at.getTime()
        || (previous.rows[0] && file.verified_at.getTime()
          <= previous.rows[0].updated_at.getTime())) {
      throw handymanQcPassBlockedError('QC upload is unverified or stale');
    }
    // Shared storage boundary re-hashes real bytes; a database row or
    // client-supplied URL alone is never sufficient BAST authority.
    await assertVerifiedManagedEvidenceReference(tx, {
      clientId: scope.clientId, buildingId: scope.buildingId,
      executionScopeId: scope.id,
      handymanRequestId: fullScope.handymanRequestId,
    }, file.attachment_reference);
  }
  return { runId: run.id,
    templateVersionId: spec.checklist_version_id,
    checklistIdentity: run.checklist_identity };
}
