/**
 * R07 PART 01A + 01B — Checklist Detail Read Projection Core + Service
 *
 * Backend-owned, read-only, internal (no HTTP endpoint).
 * Distinct from R04 summary (different grain).
 * PART 01B adds authorized scope service reusing R04 access authority.
 */
export { checklistExecutionDetailRepository, getChecklistExecutionDetailRows } from './checklist-execution-detail.repository';
export {
  checklistExecutionDetailService,
  getChecklistExecutionDetail,
  parseChecklistExecutionDetailQuery,
  checklistExecutionDetailRange,
} from './checklist-execution-detail.service';
export type {
  ChecklistDetailItemType,
  ChecklistExecutionDetailFilters,
  ChecklistExecutionDetailPagination,
  ChecklistExecutionDetailQuery,
  PublicChecklistExecutionDetail,
  PublicChecklistExecutionDetailRow,
} from './checklist-execution-detail.types';
