/**
 * R07 PART 02C — Shared Neutral Detail Adapter + Shared Access
 *
 * Backend-owned, read-only, internal (no HTTP endpoint).
 * Composes checklist and form detail repositories into one neutral contract.
 * Physical repositories remain separate.
 */
export { operationalDetailReportingService, getOperationalDetail, parseOperationalDetailQuery, operationalDetailRange } from './operational-detail-reporting.service';
export type {
  OperationalDetailEngine,
  DefinitionMetadataAuthority,
  MeasurementMetadataAuthority,
  PublicOperationalDetailRow,
  OperationalDetailFilters,
  OperationalDetailPagination,
  OperationalDetailQuery,
  PublicOperationalDetail,
} from './operational-detail-reporting.types';
