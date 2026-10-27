import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { assignmentResponseRepository, handymanAssignmentDeclinedError } from '../assignment-responses';
import { handymanDispatchService } from '../handyman-dispatch';
import { assertHandymanQcSupervisor } from '../handyman-evidence-qc/handyman-qc-authority';
import { assertCurrentGuardedHandymanQcPass } from '../handyman-evidence-qc/handyman-qc-pass-gate';
import { assertVerifiedManagedEvidenceReference } from '../handyman-field-evidence/handyman-field-evidence.service';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations';
import { handymanScopeAssignmentRepository, resolveHandymanAssignmentLead } from '../handyman-scope-assignments';
import { handymanScopeVariationRepository } from '../handyman-scope-variations/handyman-scope-variation.repository';
import { addLaborBindingFromEvents, addMaterialBindingFromEvents, assertPinnedVariationApproval }
  from '../handyman-scope-variations/handyman-scope-variation-material-authority';
import { handymanWorkSessionNotAuthorizedError } from '../handyman-work-sessions/handyman-work-session.errors';

type Scope = { id: string; clientId: string; buildingId: string; handymanRequestId: string; status: string };
type ApprovedLine = {
  quotationVersionId: string; quotationLineId: string; variationId: string | null;
  lineType: 'LABOR' | 'MATERIAL'; description: string; uomId: string;
  sourceItemId: string | null; approvedQty: string; originalApprovedQty: string;
  approvedVariationVersion: number | null;
};
export type Proof = {
  source: 'CREW_DECLARATION' | 'ADD_LABOR_EXECUTION'; id: string;
  sessionId: string; assignmentId: string; leadWorkerId: string; leadUserId: string;
  actualQty: string; evidenceId: string; evidenceReference: string; evidenceSha256: string;
};
export type ManifestItem = ApprovedLine & { actualQty: string; status: 'COMPLETED' | 'PARTIAL' | 'NOT_PERFORMED'; execution: Proof[] };
export type ManifestSnapshot = { protocol: string; executionScopeId: string; requestId: string; clientId: string;
  buildingId: string; approvedQuotationVersionId: string; approvedVariations: object[];
  sessions: { id: string; completedAt: string; completionEventId: string }[]; items: ManifestItem[] };

function invalid(message: string): AppError {
  return new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_COMPLETION_INVALID, message });
}
function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) throw AppError.validation(`${name} must be a UUID.`);
  return value.trim().toLowerCase();
}
function text(value: unknown, name: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw AppError.validation(`${name} is required (maximum ${max} characters).`);
  }
  return value.trim();
}
// Exact decimal arithmetic: never round a quantity or use binary floating-point
// sums as commercial scope authority. Inputs are bounded before using BigInt.
function decimal(value: unknown, name = 'quantity'): string {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,60}(?:\.\d{1,30})?$/.test(raw)) {
    throw AppError.validation(`${name} must be a non-negative decimal (up to 30 fractional digits).`);
  }
  const [whole, frac = ''] = raw.split('.');
  const w = whole.replace(/^0+(?=\d)/, '');
  const f = frac.replace(/0+$/, '');
  return f ? `${w}.${f}` : w;
}
function scaled(a: string, b: string): [bigint, bigint, number] {
  const ap = a.split('.'), bp = b.split('.');
  const scale = Math.max(ap[1]?.length ?? 0, bp[1]?.length ?? 0);
  const n = (p: string[]) => BigInt(p[0] + (p[1] ?? '').padEnd(scale, '0'));
  return [n(ap), n(bp), scale];
}
function calc(a: string, b: string, subtract = false): string {
  const [x, y, scale] = scaled(a, b);
  const n = subtract ? x - y : x + y;
  if (n < 0n) throw invalid('Approved reductions exceed the original quantity.');
  const digits = n.toString().padStart(scale + 1, '0');
  return decimal(scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits);
}
function compare(a: string, b: string): number {
  const [x, y] = scaled(a, b); return x === y ? 0 : x < y ? -1 : 1;
}
const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function lockedScope(tx: PoolClient, id: string): Promise<Scope> {
  const scope = await handymanScopeAssignmentRepository.lockScopeById(tx, id);
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (scope.status !== 'AUTHORIZED') throw invalid('Execution scope is not authorized.');
  return scope;
}
async function currentLead(tx: PoolClient, scope: Scope, actor: string) {
  await assertBuildingScopedResourceAccess(actor, { clientId: scope.clientId, buildingId: scope.buildingId }, tx);
  const lead = await resolveHandymanAssignmentLead(scope.id, actor, tx);
  if (!lead || lead.leadUserId !== actor) throw handymanWorkSessionNotAuthorizedError();
  const response = await assignmentResponseRepository.findByAssignmentId(lead.assignmentId, tx);
  if (response?.responseStatus === 'TIDAK_BISA') throw handymanAssignmentDeclinedError();
  return lead;
}

/** Build only from the immutable approved quotation and exact authorized PIC
 * variation decisions. An ADD's own consented line is used, not a generic Work
 * Order relationship; later Work Order status is irrelevant to past execution. */
async function approvedScope(tx: PoolClient, scope: Scope) {
  const base = await tx.query(`SELECT s.approved_quotation_version_id, s.tenant_company_id, ql.id, ql.line_type, ql.description,
      ql.uom_id, ql.source_item_id, ql.quantity::text AS quantity
    FROM handyman_execution_scopes s
    JOIN handyman_service_requests req ON req.id=s.handyman_request_id AND req.client_id=s.client_id
      AND req.building_id=s.building_id AND req.tenant_company_id=s.tenant_company_id
    JOIN handyman_quotation_versions qv ON qv.id=s.approved_quotation_version_id AND qv.quotation_id=s.quotation_id
    JOIN handyman_quotation_decisions d ON d.id=s.quotation_decision_id AND d.client_id=s.client_id
      AND d.quotation_id=s.quotation_id AND d.quotation_version_id=qv.id AND d.decision='APPROVE'
      AND d.tenant_company_id=s.tenant_company_id AND d.tenant_pic_id IS NOT DISTINCT FROM s.tenant_pic_id
    JOIN handyman_quotation_lines ql ON ql.quotation_version_id=qv.id
    WHERE s.id=$1 ORDER BY ql.id`, [scope.id]);
  if (!base.rows.length) throw invalid('The exact approved quotation items are unavailable.');
  const quotationVersionId: string = base.rows[0].approved_quotation_version_id;
  const lines = new Map<string, ApprovedLine>();
  for (const r of base.rows) {
    const qty = decimal(r.quantity);
    lines.set(r.id, { quotationVersionId, quotationLineId: r.id, variationId: null,
      lineType: r.line_type, description: r.description, uomId: r.uom_id, sourceItemId: r.source_item_id,
      approvedQty: qty, originalApprovedQty: qty, approvedVariationVersion: null });
  }
  const approvedVariations: object[] = [];
  const variations = await handymanScopeVariationRepository.listByExecutionScope(scope.id, tx);
  for (const v of variations) {
    if (!['AUTHORIZED_SCOPE', 'EXECUTION', 'QC', 'FINAL_CHARGE_ELIGIBILITY'].includes(v.status)) continue;
    if (v.clientId !== scope.clientId || v.buildingId !== scope.buildingId ||
        v.handymanRequestId !== scope.handymanRequestId || v.tenantCompanyId !== base.rows[0].tenant_company_id || v.tenantDecisionOutcome !== 'APPROVED') {
      throw invalid('Authorized variation does not match the scope and approved tenant decision.');
    }
    const events = await handymanScopeVariationRepository.listEventsByVariation(v.id, tx);
    const decision = events.find(e => e.eventType === 'TENANT_DECISION');
    const version = (decision?.metadata.consentSnapshot as { version?: unknown } | undefined)?.version;
    const auth = events.find(e => e.eventType === 'AUTHORIZED_SCOPE' && e.actorRole === 'OPERATIONS_MANAGER');
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || !auth) {
      throw invalid('Variation lacks an exact tenant approval and Operations authorization.');
    }
    await assertPinnedVariationApproval(tx, v, version, events);
    const quantity = decimal(v.quantity);
    if (v.variationType === 'REDUCE') {
      const line = v.targetQuotationLineId ? lines.get(v.targetQuotationLineId) : undefined;
      if (!line || line.variationId !== null || line.lineType !== v.lineType || line.uomId !== v.uomId) {
        throw invalid('Reduction does not target an original approved quotation item.');
      }
      line.approvedQty = calc(line.approvedQty, quantity, true);
    } else {
      const binding = addLaborBindingFromEvents(v, events) ?? addMaterialBindingFromEvents(v, events);
      if (!binding || !v.revisedQuotationVersionId || v.quotedUnitAmount === null || !v.currency || lines.has(binding.revisedQuotationLineId)) {
        throw invalid('ADD variation has no unique, exactly approved quotation line.');
      }
      const found = await tx.query(`SELECT l.id,l.line_type,l.description,l.uom_id,l.source_item_id,l.quantity::text AS quantity
        FROM handyman_execution_scopes s JOIN handyman_quotation_versions qv ON qv.quotation_id=s.quotation_id
        JOIN handyman_quotation_lines l ON l.quotation_version_id=qv.id
        WHERE s.id=$1 AND qv.id=$2 AND qv.id<>s.approved_quotation_version_id AND l.id=$3
          AND l.line_type=$4 AND l.quantity=$5::numeric AND l.uom_id=$6
          AND l.final_quoted_unit_amount=$7::numeric AND l.currency=$8`,
      [scope.id, v.revisedQuotationVersionId, binding.revisedQuotationLineId, v.lineType,
        v.quantity, v.uomId, v.quotedUnitAmount, v.currency]);
      const r = found.rows[0];
      if (!r) throw invalid('ADD variation does not match its exact approved quotation item.');
      lines.set(r.id, { quotationVersionId: v.revisedQuotationVersionId, quotationLineId: r.id,
        variationId: v.id, lineType: r.line_type, description: r.description, uomId: r.uom_id,
        sourceItemId: r.source_item_id, approvedQty: quantity, originalApprovedQty: quantity,
        approvedVariationVersion: version });
    }
    approvedVariations.push({ id: v.id, type: v.variationType, lineType: v.lineType,
      targetQuotationLineId: v.targetQuotationLineId, approvedVersion: version, quantity,
      decisionEventId: decision!.id, authorizationEventId: auth.id });
  }
  approvedVariations.sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)));
  return { quotationVersionId, lines, approvedVariations };
}

function declaration(row: QueryResultRow) {
  return { id: row.id, executionScopeId: row.execution_scope_id, quotationVersionId: row.quotation_version_id,
    quotationLineId: row.quotation_line_id, variationId: row.variation_id, approvedQty: decimal(row.approved_qty),
    actualQty: decimal(row.actual_qty), status: row.status, sessionId: row.work_session_id,
    assignmentId: row.assignment_id, leadWorkerId: row.lead_worker_id, leadUserId: row.lead_user_id,
    evidenceId: row.evidence_id, evidenceReference: row.evidence_reference, evidenceSha256: row.evidence_sha256 };
}

export async function recordCompletionDeclaration(scopeInput: unknown, sessionInput: unknown,
  input: Record<string, unknown>, actorInput: unknown) {
  const scopeId = uuid(scopeInput, 'executionScopeId'), sessionId = uuid(sessionInput, 'sessionId');
  const actor = uuid(actorInput, 'actorUserId'), lineId = uuid(input.quotationLineId, 'quotationLineId');
  const variationId = input.variationId == null ? null : uuid(input.variationId, 'variationId');
  const quantity = decimal(input.actualQty, 'actualQty');
  const reference = text(input.evidenceReference, 'evidenceReference', 500), key = text(input.idempotencyKey, 'idempotencyKey');
  return withTransaction(async tx => {
    const scope = await lockedScope(tx, scopeId);
    const lead = await currentLead(tx, scope, actor);
    const replay = await tx.query(`SELECT * FROM handyman_completion_declarations WHERE execution_scope_id=$1 AND idempotency_key=$2`, [scopeId, key]);
    if (replay.rows[0]) {
      const r = replay.rows[0];
      if (r.lead_user_id !== actor || r.work_session_id !== sessionId || r.quotation_line_id !== lineId ||
          r.variation_id !== variationId || decimal(r.actual_qty) !== quantity || r.evidence_reference !== reference) {
        throw new AppError({ statusCode: 409, code: ERROR_CODES.IDEMPOTENCY_CONFLICT, message: 'Completion key belongs to different facts.' });
      }
      return { declaration: declaration(r), replayed: true };
    }
    const session = (await tx.query(`SELECT * FROM handyman_work_sessions WHERE id=$1 AND execution_scope_id=$2 FOR UPDATE`, [sessionId, scopeId])).rows[0];
    if (!session) throw AppError.notFound('Work session not found.');
    if (session.assignment_id !== lead.assignmentId || session.lead_user_id !== actor || session.lead_worker_id !== lead.leadWorkerContextId) {
      throw handymanWorkSessionNotAuthorizedError();
    }
    if (session.status !== 'IN_PROGRESS' || !session.started_work_at) throw invalid('Completion declaration requires an in-progress work session.');
    await handymanDispatchService.assertDispatchExecutionClearance(tx, scopeId, actor, lead.assignmentId);
    const confirmed = await currentLead(tx, scope, actor);
    if (confirmed.assignmentId !== lead.assignmentId || confirmed.leadWorkerContextId !== lead.leadWorkerContextId) throw handymanWorkSessionNotAuthorizedError();
    const approved = await approvedScope(tx, scope);
    const line = approved.lines.get(lineId);
    if (!line || line.variationId !== variationId || compare(line.approvedQty, '0') <= 0) throw invalid('Item is not in the current approved scope.');
    if (line.variationId && line.lineType === 'LABOR' && compare(quantity, '0') > 0) {
      throw invalid('Reuse the existing ADD labor execution record for performed ADD labor.');
    }
    const evidence = await assertVerifiedManagedEvidenceReference(tx, { clientId: scope.clientId,
      buildingId: scope.buildingId, handymanRequestId: scope.handymanRequestId, executionScopeId: scope.id }, reference,
      { requiredPurpose: 'BEFORE_AFTER_WORK' });
    if (!evidence) throw invalid('A byte-verified work evidence reference is required.');
    const binding = await tx.query(`SELECT 1 FROM handyman_field_evidence_uploads WHERE id=$1 AND execution_scope_id=$2
      AND (variation_id IS NULL OR variation_id=$3) AND uploaded_by_user_id=$4 AND uploaded_by_role='PIC_PEKERJAAN'
      AND verified_at >= $5`, [evidence.id, scopeId, variationId, actor, session.started_work_at]);
    if (!binding.rows[0]) throw invalid('Work evidence must belong to this scope, session and declaring Lead.');
    const conflicts = await tx.query(`SELECT 1 FROM handyman_completion_declarations d LEFT JOIN handyman_completion_revocations r ON r.declaration_id=d.id
      WHERE d.execution_scope_id=$1 AND r.id IS NULL AND (d.evidence_id=$3 OR (d.quotation_line_id=$2 AND d.work_session_id=$4))
      UNION ALL SELECT 1 FROM handyman_add_labor_executions l WHERE l.evidence_id=$3 LIMIT 1`, [scopeId, lineId, evidence.id, sessionId]);
    if (conflicts.rows[0]) throw invalid('The item was already declared in this session, or the evidence is already used.');
    const amounts = await tx.query<{ total: string; has_zero: boolean }>(`SELECT
      (COALESCE((SELECT SUM(d.actual_qty) FROM handyman_completion_declarations d LEFT JOIN handyman_completion_revocations r ON r.declaration_id=d.id
        WHERE d.execution_scope_id=$1 AND d.quotation_line_id=$2 AND r.id IS NULL),0)+
       COALESCE((SELECT SUM(l.actual_qty) FROM handyman_add_labor_executions l WHERE l.execution_scope_id=$1 AND l.quotation_line_id=$2),0))::text AS total,
      EXISTS (SELECT 1 FROM handyman_completion_declarations d LEFT JOIN handyman_completion_revocations r ON r.declaration_id=d.id
        WHERE d.execution_scope_id=$1 AND d.quotation_line_id=$2 AND d.actual_qty=0 AND r.id IS NULL) AS has_zero`, [scopeId, lineId]);
    const previous = decimal(amounts.rows[0].total), total = calc(previous, quantity);
    if (compare(total, line.approvedQty) > 0 || (quantity === '0' && (previous !== '0' || amounts.rows[0].has_zero)) || (quantity !== '0' && amounts.rows[0].has_zero)) {
      throw invalid('Actual quantity exceeds or contradicts the approved item.');
    }
    const status = quantity === '0' ? 'NOT_PERFORMED' : compare(quantity, line.approvedQty) === 0 ? 'COMPLETED' : 'PARTIAL';
    const result = await tx.query(`INSERT INTO handyman_completion_declarations
      (id,client_id,building_id,request_id,execution_scope_id,quotation_version_id,quotation_line_id,variation_id,
       approved_qty,actual_qty,status,work_session_id,assignment_id,lead_worker_id,lead_user_id,evidence_id,evidence_reference,evidence_sha256,idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [randomUUID(), scope.clientId, scope.buildingId, scope.handymanRequestId, scopeId, line.quotationVersionId, lineId,
      variationId, line.approvedQty, quantity, status, sessionId, lead.assignmentId, lead.leadWorkerContextId, actor,
      evidence.id, reference, evidence.sha256Checksum, key]);
    return { declaration: declaration(result.rows[0]), replayed: false };
  });
}

export async function revokeCompletionDeclaration(scopeInput: unknown, declarationInput: unknown,
  input: Record<string, unknown>, actorInput: unknown) {
  const scopeId = uuid(scopeInput, 'executionScopeId'), id = uuid(declarationInput, 'declarationId');
  const actor = uuid(actorInput, 'actorUserId'), reason = text(input.reason, 'reason', 2000), key = text(input.idempotencyKey, 'idempotencyKey');
  return withTransaction(async tx => {
    const scope = await lockedScope(tx, scopeId);
    await assertBuildingScopedResourceAccess(actor, { clientId: scope.clientId, buildingId: scope.buildingId }, tx);
    const target = (await tx.query(`SELECT * FROM handyman_completion_declarations WHERE id=$1 AND execution_scope_id=$2`, [id, scopeId])).rows[0];
    if (!target) throw AppError.notFound('Completion declaration not found.');
    if (target.lead_user_id !== actor) throw handymanWorkSessionNotAuthorizedError();
    const existing = (await tx.query(`SELECT * FROM handyman_completion_revocations WHERE execution_scope_id=$1 AND (idempotency_key=$2 OR declaration_id=$3)`, [scopeId, key, id])).rows[0];
    if (existing) {
      if (existing.idempotency_key !== key || existing.declaration_id !== id || existing.actor_user_id !== actor || existing.reason !== reason)
        throw invalid('Declaration is already revoked or the idempotency key is in use.');
      return { id: existing.id, declarationId: id, replayed: true };
    }
    const saved = (await tx.query(`INSERT INTO handyman_completion_revocations
      (id,declaration_id,execution_scope_id,actor_user_id,reason,idempotency_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [randomUUID(), id, scopeId, actor, reason, key])).rows[0];
    return { id: saved.id, declarationId: id, replayed: false };
  });
}

/** Assemble the version from durable Lead declarations and existing ADD labor
 * executions. All authorized items need a real proof, including zero work. */
async function buildSnapshot(tx: PoolClient, scope: Scope): Promise<ManifestSnapshot> {
  const approved = await approvedScope(tx, scope);
  const sessionRows = await tx.query(`SELECT ws.id,ws.status,ws.completed_at::text AS completed_at,
    (SELECT ev.id FROM handyman_work_session_events ev WHERE ev.session_id=ws.id AND ev.execution_scope_id=ws.execution_scope_id
      AND ev.client_id=ws.client_id AND ev.event_type='COMPLETE' ORDER BY ev.occurred_at,ev.id LIMIT 1) AS completion_event_id
    FROM handyman_work_sessions ws WHERE ws.execution_scope_id=$1 AND ws.client_id=$2 ORDER BY ws.id`, [scope.id, scope.clientId]);
  if (!sessionRows.rows.length || sessionRows.rows.some(r => !r.completed_at || !r.completion_event_id ||
      !['COMPLETED', 'CHECKED_OUT'].includes(r.status))) {
    throw invalid('All real work sessions must be completed before a manifest is submitted.');
  }
  const sessions = sessionRows.rows.map(r => ({ id: r.id as string, completedAt: r.completed_at as string,
    completionEventId: r.completion_event_id as string }));
  const rows = await tx.query(`SELECT d.id,'CREW_DECLARATION' AS source,d.quotation_version_id,d.quotation_line_id,d.variation_id,
      NULL::integer AS approved_variation_version,d.actual_qty::text,d.work_session_id,d.assignment_id,d.lead_worker_id,d.lead_user_id,
      d.evidence_id,d.evidence_reference,d.evidence_sha256,d.recorded_at::text AS recorded_at
    FROM handyman_completion_declarations d LEFT JOIN handyman_completion_revocations r ON r.declaration_id=d.id
    WHERE d.execution_scope_id=$1 AND r.id IS NULL
    UNION ALL SELECT l.id,'ADD_LABOR_EXECUTION',l.quotation_version_id,l.quotation_line_id,l.variation_id,
      l.approved_variation_version,l.actual_qty::text,l.work_session_id,l.assignment_id,l.lead_worker_id,l.lead_user_id,
      l.evidence_id,l.evidence_reference,l.evidence_sha256,l.recorded_at::text
    FROM handyman_add_labor_executions l WHERE l.execution_scope_id=$1 ORDER BY quotation_line_id,id`, [scope.id]);
  const proofs = new Map<string, Proof[]>(), usedEvidence = new Set<string>(), usedSessions = new Set<string>();
  for (const r of rows.rows) {
    const line = approved.lines.get(r.quotation_line_id);
    if (!line || line.quotationVersionId !== r.quotation_version_id || line.variationId !== r.variation_id || line.approvedQty === '0' ||
        (r.source === 'ADD_LABOR_EXECUTION' && (line.lineType !== 'LABOR' || !line.variationId ||
          line.approvedVariationVersion !== r.approved_variation_version))) {
      throw invalid('Execution proof no longer matches current approved scope.');
    }
    const key = `${r.quotation_line_id}:${r.work_session_id}`;
    if (usedEvidence.has(r.evidence_id) || usedSessions.has(key)) throw invalid('Duplicate item execution or reused work evidence.');
    usedEvidence.add(r.evidence_id); usedSessions.add(key);
    const binding = await tx.query(`SELECT 1 FROM handyman_work_sessions ws JOIN handyman_field_evidence_uploads e ON e.id=$2
      WHERE ws.id=$1 AND ws.execution_scope_id=$3 AND ws.client_id=$4 AND ws.assignment_id=$5
        AND ws.lead_worker_id=$6 AND ws.lead_user_id=$7 AND ws.status IN ('COMPLETED','CHECKED_OUT')
        AND ws.started_work_at IS NOT NULL AND ws.completed_at IS NOT NULL
        AND $8::timestamptz <= ws.completed_at
        AND e.execution_scope_id=$3 AND e.client_id=$4 AND e.building_id=$9 AND e.handyman_request_id=$10
        AND (e.variation_id IS NULL OR e.variation_id=$11) AND e.purpose='BEFORE_AFTER_WORK' AND e.upload_status='VERIFIED'
        AND e.verified_at>=ws.started_work_at AND e.verified_at<=$8::timestamptz
        AND e.attachment_reference=$12 AND e.sha256_checksum=$13
        AND EXISTS (SELECT 1 FROM handyman_work_session_events ev WHERE ev.session_id=ws.id AND ev.execution_scope_id=ws.execution_scope_id
          AND ev.client_id=ws.client_id AND ev.event_type='COMPLETE')`,
    [r.work_session_id, r.evidence_id, scope.id, scope.clientId, r.assignment_id, r.lead_worker_id, r.lead_user_id,
      r.recorded_at, scope.buildingId, scope.handymanRequestId, line.variationId, r.evidence_reference, r.evidence_sha256]);
    if (!binding.rows[0]) throw invalid('Execution proof is not bound to a completed session and exact scope evidence.');
    const evidence = await assertVerifiedManagedEvidenceReference(tx, { clientId: scope.clientId, buildingId: scope.buildingId,
      handymanRequestId: scope.handymanRequestId, executionScopeId: scope.id }, r.evidence_reference,
      { requiredPurpose: 'BEFORE_AFTER_WORK' });
    if (!evidence || evidence.id !== r.evidence_id || evidence.sha256Checksum !== r.evidence_sha256) {
      throw invalid('Execution evidence bytes do not match the recorded proof.');
    }
    const proof: Proof = { source: r.source, id: r.id, sessionId: r.work_session_id, assignmentId: r.assignment_id,
      leadWorkerId: r.lead_worker_id, leadUserId: r.lead_user_id, actualQty: decimal(r.actual_qty),
      evidenceId: r.evidence_id, evidenceReference: r.evidence_reference, evidenceSha256: r.evidence_sha256 };
    proofs.set(line.quotationLineId, [...(proofs.get(line.quotationLineId) ?? []), proof]);
  }
  const items: ManifestItem[] = [];
  for (const line of [...approved.lines.values()].sort((a, b) => a.quotationLineId.localeCompare(b.quotationLineId))) {
    if (line.approvedQty === '0') continue;
    const execution = proofs.get(line.quotationLineId) ?? [];
    if (!execution.length) throw invalid('Every approved item needs an actual Lead execution declaration or existing execution fact.');
    const actualQty = execution.reduce((sum, proof) => calc(sum, proof.actualQty), '0');
    if (compare(actualQty, line.approvedQty) > 0 || (execution.some(p => p.actualQty === '0') && execution.length !== 1)) {
      throw invalid('Execution quantity exceeds or contradicts the approved item.');
    }
    const status = actualQty === '0' ? 'NOT_PERFORMED' : compare(actualQty, line.approvedQty) === 0 ? 'COMPLETED' : 'PARTIAL';
    items.push({ ...line, actualQty, status, execution });
  }
  if (!items.length) throw invalid('No remaining approved scope items are available for completion.');
  return { protocol: 'handyman-completion-manifest/v1', executionScopeId: scope.id, requestId: scope.handymanRequestId,
    clientId: scope.clientId, buildingId: scope.buildingId, approvedQuotationVersionId: approved.quotationVersionId,
    approvedVariations: approved.approvedVariations, sessions, items };
}

function manifest(row: QueryResultRow) {
  return { id: row.id, executionScopeId: row.execution_scope_id, requestId: row.request_id,
    buildingId: row.building_id, version: row.version, sha256: row.source_sha256,
    submittedByUserId: row.submitted_by_user_id, submittedAt: row.submitted_at,
    snapshot: row.source_snapshot };
}
async function latestManifest(tx: PoolClient, scopeId: string) {
  return (await tx.query(`SELECT * FROM handyman_completion_manifests WHERE execution_scope_id=$1 ORDER BY version DESC LIMIT 1`, [scopeId])).rows[0];
}
async function requireSnapshotCurrent(tx: PoolClient, scope: Scope, row: QueryResultRow) {
  const canonical = stableJson(await buildSnapshot(tx, scope));
  if (row.source_canonical !== canonical || row.source_sha256 !== hash(canonical) || stableJson(row.source_snapshot) !== canonical) {
    throw invalid('Completion manifest is stale; submit and verify a new version.');
  }
}

export async function submitCompletionManifest(scopeInput: unknown, input: Record<string, unknown>, actorInput: unknown) {
  const scopeId = uuid(scopeInput, 'executionScopeId'), actor = uuid(actorInput, 'actorUserId'), key = text(input.idempotencyKey, 'idempotencyKey');
  return withTransaction(async tx => {
    const scope = await lockedScope(tx, scopeId);
    await currentLead(tx, scope, actor);
    const existing = (await tx.query(`SELECT * FROM handyman_completion_manifests WHERE execution_scope_id=$1 AND idempotency_key=$2`, [scopeId, key])).rows[0];
    if (existing) {
      if (existing.submitted_by_user_id !== actor) throw invalid('Manifest key belongs to another actor.');
      return { manifest: manifest(existing), replayed: true };
    }
    const snapshot = await buildSnapshot(tx, scope), canonical = stableJson(snapshot), digest = hash(canonical);
    const last = await latestManifest(tx, scopeId);
    if (last && last.source_sha256 === digest) throw invalid('The latest manifest already contains these completion facts.');
    const row = (await tx.query(`INSERT INTO handyman_completion_manifests
      (id,client_id,building_id,request_id,execution_scope_id,version,source_snapshot,source_canonical,source_sha256,submitted_by_user_id,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) RETURNING *`,
    [randomUUID(), scope.clientId, scope.buildingId, scope.handymanRequestId, scopeId, (last?.version ?? 0) + 1,
      canonical, canonical, digest, actor, key])).rows[0];
    return { manifest: manifest(row), replayed: false };
  });
}

export async function listCompletionDeclarations(scopeInput: unknown, actorInput: unknown) {
  const scopeId = uuid(scopeInput, 'executionScopeId'), actor = uuid(actorInput, 'actorUserId');
  return withTransaction(async tx => {
    const scope = await lockedScope(tx, scopeId);
    await assertBuildingScopedResourceAccess(actor, { clientId: scope.clientId, buildingId: scope.buildingId }, tx);
    const lead = await resolveHandymanAssignmentLead(scopeId, actor, tx);
    if (!lead || lead.leadUserId !== actor) await assertHandymanQcSupervisor(scope, actor, tx);
    const rows = await tx.query(`SELECT d.*,r.id AS revocation_id,r.reason AS revocation_reason,r.revoked_at
      FROM handyman_completion_declarations d LEFT JOIN handyman_completion_revocations r ON r.declaration_id=d.id
      WHERE d.execution_scope_id=$1 ORDER BY d.recorded_at,d.id`, [scopeId]);
    return { declarations: rows.rows.map(r => ({ ...declaration(r),
      revocation: r.revocation_id ? { id: r.revocation_id, reason: r.revocation_reason, revokedAt: r.revoked_at } : null })) };
  });
}

export async function getCompletionManifest(scopeInput: unknown, manifestInput: unknown, actorInput: unknown) {
  const scopeId = uuid(scopeInput, 'executionScopeId'), id = manifestInput === 'latest' ? 'latest' : uuid(manifestInput, 'manifestId'), actor = uuid(actorInput, 'actorUserId');
  return withTransaction(async tx => {
    const scope = await lockedScope(tx, scopeId);
    await assertBuildingScopedResourceAccess(actor, { clientId: scope.clientId, buildingId: scope.buildingId }, tx);
    const lead = await resolveHandymanAssignmentLead(scopeId, actor, tx);
    if (!lead || lead.leadUserId !== actor) await assertHandymanQcSupervisor(scope, actor, tx);
    const row = id === 'latest' ? await latestManifest(tx, scopeId) :
      (await tx.query(`SELECT * FROM handyman_completion_manifests WHERE id=$1 AND execution_scope_id=$2`, [id, scopeId])).rows[0];
    if (!row) throw AppError.notFound('Completion manifest not found.');
    const verification = (await tx.query(`SELECT id,qc_run_id,qc_run_version,qc_finish_event_id,verified_by_user_id,verified_at
      FROM handyman_completion_verifications WHERE manifest_id=$1`, [row.id])).rows[0] ?? null;
    return { manifest: manifest(row), verification };
  });
}

/** Explicit, separate Supervisor review of the exact snapshot and exact current
 * PASS event/version. No historic QC decision is rewritten or backfilled. */
export async function verifyCompletionManifest(scopeInput: unknown, manifestInput: unknown,
  input: Record<string, unknown>, actorInput: unknown) {
  const scopeId = uuid(scopeInput, 'executionScopeId'), id = uuid(manifestInput, 'manifestId'), actor = uuid(actorInput, 'actorUserId');
  const runId = uuid(input.qcRunId, 'qcRunId'), key = text(input.idempotencyKey, 'idempotencyKey');
  const version = input.manifestVersion, digest = input.manifestSha256, runVersion = input.qcRunVersion;
  if (!Number.isSafeInteger(version) || Number(version) < 1 || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) ||
      !Number.isSafeInteger(runVersion) || Number(runVersion) < 1 || input.reviewed !== true) {
    throw AppError.validation('Explicit review, exact manifest version/hash and QC run version are required.');
  }
  return withTransaction(async tx => {
    const scope = await lockedScope(tx, scopeId);
    await assertHandymanQcSupervisor(scope, actor, tx);
    const previous = (await tx.query(`SELECT * FROM handyman_completion_verifications WHERE execution_scope_id=$1 AND idempotency_key=$2`, [scopeId, key])).rows[0];
    if (previous) {
      if (previous.verified_by_user_id !== actor || previous.manifest_id !== id || previous.qc_run_id !== runId ||
          previous.manifest_version !== version || previous.manifest_sha256 !== digest || previous.qc_run_version !== runVersion) {
        throw new AppError({ statusCode: 409, code: ERROR_CODES.IDEMPOTENCY_CONFLICT, message: 'Verification key belongs to different review facts.' });
      }
      return { verificationId: previous.id, manifestId: id, qcRunId: runId, replayed: true };
    }
    const row = await latestManifest(tx, scopeId);
    if (!row || row.id !== id || row.version !== version || row.source_sha256 !== digest) throw invalid('Manifest version or checksum is stale.');
    await requireSnapshotCurrent(tx, scope, row);
    await assertCurrentGuardedHandymanQcPass(tx, scope, runId);
    const run = (await tx.query(`SELECT q.version,e.id AS finish_id FROM handyman_qc_runs q
      JOIN handyman_qc_run_events e ON e.run_id=q.id AND e.event_type='FINISH' AND e.metadata->>'outcome'='PASSED'
      WHERE q.id=$1 AND q.execution_scope_id=$2 AND q.status='PASSED'
        AND NOT EXISTS (SELECT 1 FROM handyman_work_sessions ws WHERE ws.execution_scope_id=q.execution_scope_id
          AND (ws.completed_at IS NULL OR ws.completed_at>e.occurred_at))
      ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1`, [runId, scopeId])).rows[0];
    if (!run || run.version !== runVersion) throw invalid('QC PASS version is stale.');
    const existingRun = (await tx.query(`SELECT id FROM handyman_completion_verifications WHERE qc_run_id=$1`, [runId])).rows[0];
    if (existingRun) throw invalid('This QC PASS already reviewed a different completion manifest; a new QC run is required.');
    const saved = (await tx.query(`INSERT INTO handyman_completion_verifications
      (id,execution_scope_id,manifest_id,manifest_version,manifest_sha256,qc_run_id,qc_run_version,qc_finish_event_id,verified_by_user_id,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [randomUUID(), scopeId, id, version, digest, runId, runVersion, run.finish_id, actor, key])).rows[0];
    return { verificationId: saved.id, manifestId: id, qcRunId: runId, replayed: false };
  });
}

/** ISSUE-only consumer gate. Customer acceptance and old BASTs are untouched. */
export async function requireVerifiedCompletionForIssue(tx: PoolClient, scope: Scope, qcRunId: string) {
  const row = await latestManifest(tx, scope.id);
  if (!row) throw invalid('New BAST issuance requires a verified completion manifest.');
  const verification = (await tx.query(`SELECT v.id FROM handyman_completion_verifications v JOIN handyman_qc_runs q ON q.id=v.qc_run_id
    JOIN handyman_qc_run_events e ON e.id=v.qc_finish_event_id AND e.run_id=q.id AND e.event_type='FINISH' AND e.metadata->>'outcome'='PASSED'
    WHERE v.execution_scope_id=$1 AND v.manifest_id=$2 AND v.manifest_version=$3 AND v.manifest_sha256=$4
      AND v.qc_run_id=$5 AND q.status='PASSED' AND q.version=v.qc_run_version
      AND NOT EXISTS (SELECT 1 FROM handyman_work_sessions ws WHERE ws.execution_scope_id=q.execution_scope_id
        AND (ws.completed_at IS NULL OR ws.completed_at>e.occurred_at))`,
  [scope.id, row.id, row.version, row.source_sha256, qcRunId])).rows[0];
  if (!verification) throw invalid('The current QC PASS has not verified this exact completion manifest.');
  await requireSnapshotCurrent(tx, scope, row);
  return { verificationId: verification.id as string, manifestId: row.id as string, manifestVersion: row.version as number,
    manifestSha256: row.source_sha256 as string };
}
