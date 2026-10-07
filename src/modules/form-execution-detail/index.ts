/**
 * R07 PART 02B — Form Detail Repository Core
 *
 * Backend-owned, read-only, internal (no HTTP endpoint).
 * Dedicated form engine adapter, separate from checklist detail.
 */
export { formExecutionDetailRepository, getFormExecutionDetailRows } from './form-execution-detail.repository';
export type {
  FormDetailFieldType,
  FormExecutionDetailFilters,
  FormExecutionDetailPagination,
  PublicFormExecutionDetail,
  PublicFormExecutionDetailRow,
} from './form-execution-detail.types';
