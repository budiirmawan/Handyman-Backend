/**
 * R08 PART 02B — Operational Detail Finding child projection.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint). Execution-keyed finding
 * lineage child of the closed R07 operational-detail family: ONE row per
 * `findings.id`, parent key (engine, executionId), no detail attribution, all ten
 * stored statuses visible by default, client consistency enforced structurally in
 * SQL, and BOTH authoritative building facts exposed distinctly (parent-resolved
 * and finding-stored) with no derived mismatch interpretation.
 *
 * The engine vocabulary is REUSED from R07 and the finding status vocabulary is
 * REUSED from the findings module — neither is redeclared here, so this module has
 * no runtime vocabulary export of its own.
 *
 * No export dataset, no reporting registry entry, no OpenAPI change, no route, no
 * controller, no migration, no new permission, no new index, no materialized view.
 * R02 FINDING_REGISTER, R04, R07 and R08 PART 01B are unchanged. No rework, no
 * review, no history, no evidence.
 */
export {
  operationalDetailFindingRepository,
  getOperationalDetailFindingRows,
} from './operational-detail-finding.repository';
export {
  operationalDetailFindingService,
  getOperationalDetailFinding,
  parseOperationalDetailFindingQuery,
  operationalDetailFindingRange,
} from './operational-detail-finding.service';
export type {
  OperationalDetailFindingFilters,
  OperationalDetailFindingPagination,
  OperationalDetailFindingQuery,
  PublicOperationalDetailFinding,
  PublicOperationalDetailFindingRow,
} from './operational-detail-finding.types';
