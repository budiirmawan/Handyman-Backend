/**
 * CR-BE-REPORT-READ-04 PART 01 — Checklist Execution Summary read contract.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint). Consumed by the
 * Reporting track; never by operational write flows.
 */
export { checklistExecutionSummaryRepository } from './checklist-execution-summary.repository';
export {
  checklistExecutionSummaryService,
  getChecklistExecutionSummary,
  parseChecklistExecutionSummaryQuery,
  checklistExecutionSummaryRange,
} from './checklist-execution-summary.service';
export type {
  ChecklistExecutionEngine,
  ChecklistExecutionSummaryFilters,
  PublicChecklistExecutionSummary,
  PublicChecklistExecutionSummaryRow,
} from './checklist-execution-summary.types';
