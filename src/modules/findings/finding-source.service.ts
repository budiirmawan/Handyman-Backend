import { getPool } from '../../database';
import { recordFindingEvent } from '../finding-history/finding-history.service';
import { resolveAuthoritativeChecklistSourceContext } from '../checklist-executions/checklist-execution.service';
import { workOrderRepository } from '../work-orders';
import {
  findingNotFoundError,
  findingNotOpenError,
  findingSourceBuildingMismatchError,
  findingSourceClientMismatchError,
  findingSourceNotFoundError,
} from './finding.errors';
import { findingRepository } from './finding.repository';
import type {
  FindingSourceState,
  ResolvedFindingSourceContext,
  UpdateFindingSourceInput,
} from './finding-source.types';
import type { FindingRecord, FindingSourceType } from './finding.types';

export async function resolveFindingSourceContext(
  sourceType: FindingSourceType,
  sourceId: string,
): Promise<ResolvedFindingSourceContext> {
  if (sourceType === 'WORK_ORDER') {
    const source = await workOrderRepository.findById(sourceId);
    if (!source) throw findingSourceNotFoundError();
    return {
      sourceType,
      sourceId: source.id,
      clientId: source.clientId,
      buildingId: source.buildingId,
      status: source.status,
      referenceType: 'WORK_ORDER',
      referenceId: source.id,
      referenceCode: source.workOrderNumber,
      title: source.title,
    };
  }

  if (sourceType === 'FORM_INSTANCE') {
    const result = await getPool().query<{
      id: string;
      clientId: string;
      formTemplateVersionId: string;
      status: string;
    }>(
      `SELECT id, client_id AS "clientId",
              form_template_version_id AS "formTemplateVersionId", status
       FROM form_instances WHERE id = $1`,
      [sourceId],
    );
    const source = result.rows[0];
    if (!source) throw findingSourceNotFoundError();
    return {
      sourceType,
      sourceId: source.id,
      clientId: source.clientId,
      buildingId: null,
      status: source.status,
      referenceType: 'FORM_TEMPLATE_VERSION',
      referenceId: source.formTemplateVersionId,
      referenceCode: null,
      title: null,
    };
  }

  // CHECKLIST_EXECUTION — authoritative source context (MOB-C05 PART 01).
  //
  // Resolve the exact Building/Client through the C04 generated-task binding
  // (checklist_execution → generated_task_id → generated_tasks → building_id).
  // The authoritative resolver FAILS CLOSED (returns null) for unbound,
  // missing-task, Building-less and cross-Client executions; it never guesses
  // a Building from a checklist template / occurrence / first-match / title.
  const authoritative =
    await resolveAuthoritativeChecklistSourceContext(sourceId);

  if (authoritative) {
    return {
      sourceType,
      sourceId: authoritative.sourceId,
      clientId: authoritative.clientId,
      buildingId: authoritative.buildingId,
      status: authoritative.status,
      referenceType: 'CHECKLIST_TEMPLATE',
      referenceId: authoritative.checklistTemplateId,
      referenceCode: null,
      title: null,
    };
  }

  // Legacy managed path: a checklist execution that truly is UNBOUND
  // (`generated_task_id IS NULL` — standalone / admin / domain-bound
  // executions that carry their own binding) keeps resolving as a loose
  // source context with no Building, matching prior behaviour and the
  // FORM_INSTANCE parity. Such an execution is NOT valid authoritative mobile
  // field-work source context. A bound execution that failed authoritative
  // resolution (missing / Building-less / cross-Client task) FAILS CLOSED.
  const result = await getPool().query<{
    id: string;
    clientId: string;
    generatedTaskId: string | null;
    checklistTemplateId: string;
    status: string;
  }>(
    `SELECT id, client_id AS "clientId",
            generated_task_id AS "generatedTaskId",
            checklist_template_id AS "checklistTemplateId", status
     FROM checklist_executions WHERE id = $1`,
    [sourceId],
  );
  const source = result.rows[0];
  if (!source) throw findingSourceNotFoundError();
  if (source.generatedTaskId !== null) throw findingSourceNotFoundError();
  return {
    sourceType,
    sourceId: source.id,
    clientId: source.clientId,
    buildingId: null,
    status: source.status,
    referenceType: 'CHECKLIST_TEMPLATE',
    referenceId: source.checklistTemplateId,
    referenceCode: null,
    title: null,
  };
}

export async function getFindingSource(
  findingId: string,
): Promise<FindingSourceState> {
  const finding = await findingRepository.findById(findingId);
  if (!finding) throw findingNotFoundError();
  if (!finding.sourceType || !finding.sourceId) {
    return { findingId: finding.id, sourceType: null, sourceId: null, context: null };
  }
  return {
    findingId: finding.id,
    sourceType: finding.sourceType,
    sourceId: finding.sourceId,
    context: await resolveFindingSourceContext(finding.sourceType, finding.sourceId),
  };
}

export async function updateFindingSource(
  findingId: string,
  input: UpdateFindingSourceInput,
  actorUserId?: string,
): Promise<FindingSourceState> {
  const finding = await findingRepository.findById(findingId);
  if (!finding) throw findingNotFoundError();
  if (finding.status !== 'OPEN') throw findingNotOpenError();

  if (input.sourceType === null || input.sourceId === null) {
    await findingRepository.updateSource(finding.id, null, null);
    if (finding.sourceType !== null || finding.sourceId !== null) {
      await recordSourceChange(finding, actorUserId, null, null);
    }
    return { findingId: finding.id, sourceType: null, sourceId: null, context: null };
  }

  const context = await resolveFindingSourceContext(input.sourceType, input.sourceId);
  assertSourceContext(finding, context);
  await findingRepository.updateSource(finding.id, input.sourceType, input.sourceId);
  if (
    finding.sourceType !== input.sourceType || finding.sourceId !== input.sourceId
  ) {
    await recordSourceChange(
      finding,
      actorUserId,
      input.sourceType,
      input.sourceId,
    );
  }
  return {
    findingId: finding.id,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    context,
  };
}

async function recordSourceChange(
  finding: FindingRecord,
  actorUserId: string | undefined,
  sourceType: FindingSourceType | null,
  sourceId: string | null,
): Promise<void> {
  await recordFindingEvent({
    findingId: finding.id,
    clientId: finding.clientId,
    buildingId: finding.buildingId,
    eventType: 'FINDING_SOURCE_CHANGED',
    actorUserId,
    summary: 'Finding source changed',
    metadata: {
      fromSourceType: finding.sourceType,
      fromSourceId: finding.sourceId,
      toSourceType: sourceType,
      toSourceId: sourceId,
    },
  });
}

function assertSourceContext(
  finding: FindingRecord,
  context: ResolvedFindingSourceContext,
): void {
  if (context.clientId !== finding.clientId) {
    throw findingSourceClientMismatchError();
  }
  if (context.buildingId !== null && context.buildingId !== finding.buildingId) {
    throw findingSourceBuildingMismatchError();
  }
}

export const findingSourceService = {
  getFindingSource,
  resolveFindingSourceContext,
  updateFindingSource,
};
