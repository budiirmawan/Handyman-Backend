/**
 * R08 PART 03B — Operational Detail Finding Rework child projection.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint). Execution-keyed HISTORICAL finding
 * rework lineage child of the closed R07 operational-detail family: ONE row per
 * `finding_rework_cycles.id`, parent lineage engine → executionId → findingId →
 * reworkCycleId traversed by persisted keys only, ALL historical cycles visible by default,
 * client consistency enforced structurally in SQL, and BOTH authoritative building facts
 * exposed distinctly (parent-resolved and finding-stored) with no derived mismatch
 * interpretation.
 *
 * The engine vocabulary is REUSED from R07. The finding-rework domain module exports the
 * cycle status TYPE but no runtime guard, so this module supplies the smallest local runtime
 * validator over exactly the two stored literals (REQUESTED, RESUBMITTED) — pinned by test
 * against both the domain type and the migration 0096 CHECK, with no third status and no
 * modification to the domain module.
 *
 * No export dataset, no reporting registry entry, no OpenAPI change, no route, no controller,
 * no migration, no new permission, no new index, no materialized view. R02 FINDING_REGISTER,
 * R04, R07, R08 PART 01B and R08 PART 02B are unchanged. No review join, no evidence join,
 * no assignment join, no operational-events join, no vendor rework, no display-name join, and
 * no duplication of any current finding-level fact.
 */
export {
  operationalDetailFindingReworkRepository,
  getOperationalDetailFindingReworkRows,
} from './operational-detail-finding-rework.repository';
export {
  operationalDetailFindingReworkService,
  getOperationalDetailFindingRework,
  parseOperationalDetailFindingReworkQuery,
  operationalDetailFindingReworkRange,
} from './operational-detail-finding-rework.service';
export {
  FINDING_REWORK_CHILD_STATUSES,
  isFindingReworkChildStatus,
} from './operational-detail-finding-rework.types';
export type {
  OperationalDetailFindingReworkFilters,
  OperationalDetailFindingReworkPagination,
  OperationalDetailFindingReworkQuery,
  PublicOperationalDetailFindingRework,
  PublicOperationalDetailFindingReworkRow,
} from './operational-detail-finding-rework.types';
