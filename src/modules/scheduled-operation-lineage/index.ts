/**
 * R10 PART 10 — Scheduled Operation Lineage read contract.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint). Consumed by the Reporting track;
 * never by operational write flows and never by the scheduler.
 *
 * The public surface is the service entry point plus the public types, matching the sibling
 * register modules. The repository is deliberately NOT re-exported: it is the service's own
 * bounded read implementation, and callers — including the later Reporting registry wiring —
 * go through `getScheduledOperationLineage`, which owns query parsing, fail-closed Building
 * scope resolution, the date-window normalization and the envelope. Exporting the row reader
 * directly would invite a call that bypasses the authorized `buildingIds` scope, which is the
 * only thing standing between this dataset and another client's or building's generated tasks.
 *
 * `AssigneeType` is likewise NOT re-exported: it is owned and published by
 * `cleaning-assignments`, and this module only consumes that authority.
 *
 * No route, controller, permission, Reporting dataset enum entry, registry adapter,
 * projection, OpenAPI surface or migration is added by this module.
 */
export {
  getScheduledOperationLineage,
  parseScheduledOperationLineageQuery,
  scheduledOperationLineageRange,
  scheduledOperationLineageService,
} from './scheduled-operation-lineage.service';
export type {
  GeneratedTaskStatus,
  PublicScheduledOperationLineage,
  PublicScheduledOperationLineageRow,
  RecurrenceFrequency,
  RecurrenceStatus,
  ScheduleDefinitionStatus,
  ScheduledOperationLineageFilters,
} from './scheduled-operation-lineage.types';
