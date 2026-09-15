import type { FindingSourceType } from './finding.types';

export type UpdateFindingSourceInput = {
  sourceType: FindingSourceType | null;
  sourceId: string | null;
};

export type ResolvedFindingSourceContext = {
  sourceType: FindingSourceType;
  sourceId: string;
  clientId: string;
  buildingId: string | null;
  status: string;
  referenceType: 'FORM_TEMPLATE_VERSION' | 'CHECKLIST_TEMPLATE' | 'WORK_ORDER';
  referenceId: string;
  referenceCode: string | null;
  title: string | null;
};

export type FindingSourceState = {
  findingId: string;
  sourceType: FindingSourceType | null;
  sourceId: string | null;
  context: ResolvedFindingSourceContext | null;
};
