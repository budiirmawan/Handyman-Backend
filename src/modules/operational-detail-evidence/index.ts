/**
 * R08 PART 01B — Operational Detail Evidence child projection.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint). Execution-keyed evidence
 * lineage child of the closed R07 operational-detail family: ONE row per
 * `evidence_submissions.id`, parent key (engine, executionId), no detail
 * attribution, all historical lifecycle rows visible by default, client
 * consistency enforced structurally in SQL.
 *
 * No export dataset, no reporting registry entry, no OpenAPI change, no route,
 * no migration, no new permission, no new index. R04 and R07 are unchanged.
 */
export {
  operationalDetailEvidenceRepository,
  getOperationalDetailEvidenceRows,
} from './operational-detail-evidence.repository';
export {
  operationalDetailEvidenceService,
  getOperationalDetailEvidence,
  parseOperationalDetailEvidenceQuery,
  operationalDetailEvidenceRange,
} from './operational-detail-evidence.service';
export {
  EVIDENCE_CHILD_STATUSES,
  EVIDENCE_CHILD_RETENTION_STATES,
  isEvidenceChildStatus,
  isEvidenceChildRetentionState,
} from './operational-detail-evidence.types';
export type {
  EvidenceChildStatus,
  EvidenceChildRetentionState,
  EvidenceChildIntegrityStatus,
  OperationalDetailEvidenceFilters,
  OperationalDetailEvidencePagination,
  OperationalDetailEvidenceQuery,
  PublicOperationalDetailEvidence,
  PublicOperationalDetailEvidenceRow,
} from './operational-detail-evidence.types';
