import { getPool } from '../../database';
import { recordFindingEvent } from '../finding-history/finding-history.service';
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

  const result = await getPool().query<{
    id: string;
    clientId: string;
    checklistTemplateId: string;
    status: string;
  }>(
    `SELECT id, client_id AS "clientId",
            checklist_template_id AS "checklistTemplateId", status
     FROM checklist_executions WHERE id = $1`,
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
