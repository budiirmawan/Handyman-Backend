import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { clientNotFoundError, clientRepository } from '../clients';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import {
  findingActionService,
  findingNotFoundError,
  findingService,
  type FindingAction,
  type PublicFinding,
} from '../findings';
import { recordOperationalEvent } from '../operational-events';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import { utilityMeterConsumptionRepository } from '../utility-meter-consumptions/utility-meter-consumption.repository';
import type { UtilityMeterConsumptionRecord } from '../utility-meter-consumptions/utility-meter-consumption.types';
import { utilityMeterNotFoundError } from '../utility-meters/utility-meter.errors';
import { utilityMeterRepository } from '../utility-meters/utility-meter.repository';
import type { UtilityMeterRecord } from '../utility-meters/utility-meter.types';
import { utilityUsageHistoryRepository } from '../utility-usage-history/utility-usage-history.repository';
import {
  utilityAbnormalConsumptionAlreadyOpenError,
  utilityAbnormalConsumptionFindingConflictError,
  utilityAbnormalConsumptionInvalidError,
  utilityAbnormalConsumptionNotFoundError,
  utilityAbnormalConsumptionNotOpenError,
  utilityAbnormalityRuleAlreadyExistsError,
  utilityAbnormalityThresholdInvalidError,
} from './utility-abnormal-consumption.errors';
import { utilityAbnormalConsumptionRepository } from './utility-abnormal-consumption.repository';
import type {
  AbnormalityConsumptionSummary,
  AbnormalityMeterSummary,
  AbnormalityUomSummary,
  CreateUtilityAbnormalityRuleInput,
  EvaluateConsumptionInput,
  LinkAbnormalConsumptionFindingInput,
  NewUtilityAbnormalConsumption,
  NewUtilityAbnormalityRule,
  PublicUtilityAbnormalConsumption,
  PublicUtilityAbnormalityRule,
  ResolveUtilityAbnormalConsumptionInput,
  UtilityAbnormalConsumptionAction,
  UtilityAbnormalConsumptionFilters,
  UtilityAbnormalConsumptionRecord,
  UtilityAbnormalityEvaluation,
  UtilityAbnormalityRuleFilters,
  UtilityAbnormalityRuleRecord,
} from './utility-abnormal-consumption.types';

/**
 * BE-18J — Abnormal Consumption service.
 *
 * Detection observes; it never edits. Every rule reads an authoritative
 * BE-18G consumption and, where a baseline is needed, the BE-18H
 * chronological history of the same Meter. No code path here writes to
 * `utility_meter_readings`, `utility_meter_consumptions` or
 * `utility_calculations` — a suspicious figure is flagged, never corrected,
 * because correcting it silently would destroy the evidence that something
 * was wrong.
 *
 * Rules stay lightweight and configurable: each is a single arithmetic
 * comparison whose threshold, mode and baseline window live in
 * `utility_abnormality_rules` reference data. There is no model, no scoring,
 * no seasonality — deliberately not a generic anomaly engine.
 *
 * Authorities reused, never re-derived:
 *   - consumption value, period, tenant snapshot → BE-18G
 *   - chronological baseline                     → BE-18H projection
 *   - Meter identity, Client / Building, UOM     → BE-18A
 *   - operational follow-up                      → BE-09 Finding / Workflow
 *   - Building access                            → BE-02G
 *
 * Status and `availableActions` are backend-owned on both sides: this module
 * owns the abnormality's own OPEN → RESOLVED / DISMISSED lifecycle, and BE-09
 * remains the sole authority for the linked Finding's state and actions.
 *
 * Out of scope, deliberately: Verification (BE-18K), tariffs and billing.
 */

function meterSummary(record: UtilityMeterRecord): AbnormalityMeterSummary {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    utilityType: record.utilityType,
    uomId: record.uomId,
    buildingId: record.buildingId,
    status: record.status,
  };
}

function consumptionSummary(
  record: UtilityMeterConsumptionRecord,
): AbnormalityConsumptionSummary {
  return {
    id: record.id,
    consumptionValue: Number(record.consumptionValue),
    uomId: record.uomId,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    meterId: record.meterId,
    tenantCompanyId: record.tenantCompanyId,
  };
}

export function toPublicUtilityAbnormalityRule(
  record: UtilityAbnormalityRuleRecord,
): PublicUtilityAbnormalityRule {
  return {
    id: record.id,
    clientId: record.clientId,
    utilityType: record.utilityType,
    abnormalityType: record.abnormalityType,
    name: record.name,
    description: record.description,
    thresholdValue:
      record.thresholdValue === null ? null : Number(record.thresholdValue),
    comparisonMode: record.comparisonMode,
    baselineWindow: record.baselineWindow,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Backend-authoritative actions. A closed flag offers none — its decision is
 * already recorded — and `LINK_FINDING` disappears once a Finding exists.
 */
function resolveAvailableActions(
  record: UtilityAbnormalConsumptionRecord,
): UtilityAbnormalConsumptionAction[] {
  if (record.status !== 'OPEN') {
    return [];
  }
  const actions: UtilityAbnormalConsumptionAction[] = ['RESOLVE', 'DISMISS'];
  if (!record.findingId) {
    actions.push('LINK_FINDING');
  }
  return actions;
}

export function toPublicUtilityAbnormalConsumption(
  record: UtilityAbnormalConsumptionRecord,
  context: {
    meter?: UtilityMeterRecord | null;
    uom?: AbnormalityUomSummary | null;
    consumption?: UtilityMeterConsumptionRecord | null;
    rule?: UtilityAbnormalityRuleRecord | null;
    finding?: PublicFinding | null;
    findingAvailableActions?: FindingAction[];
  } = {},
): PublicUtilityAbnormalConsumption {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    meterId: record.meterId,
    utilityType: record.utilityType,
    consumptionId: record.consumptionId,
    ruleId: record.ruleId,
    abnormalityType: record.abnormalityType,
    comparisonMode: record.comparisonMode,
    detectedValue: Number(record.detectedValue),
    referenceValue:
      record.referenceValue === null ? null : Number(record.referenceValue),
    thresholdValue:
      record.thresholdValue === null ? null : Number(record.thresholdValue),
    uomId: record.uomId,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    detectedAt: record.detectedAt.toISOString(),
    detectedByUserId: record.detectedByUserId,
    status: record.status,
    resolvedAt: record.resolvedAt ? record.resolvedAt.toISOString() : null,
    resolvedByUserId: record.resolvedByUserId,
    resolutionNotes: record.resolutionNotes,
    findingId: record.findingId,
    tenantAssignmentId: record.tenantAssignmentId,
    tenantCompanyId: record.tenantCompanyId,
    notes: record.notes,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    availableActions: resolveAvailableActions(record),
    ...(context.meter === undefined
      ? {}
      : { meter: context.meter ? meterSummary(context.meter) : null }),
    ...(context.uom === undefined ? {} : { uom: context.uom }),
    ...(context.consumption === undefined
      ? {}
      : {
          consumption: context.consumption
            ? consumptionSummary(context.consumption)
            : null,
        }),
    ...(context.rule === undefined
      ? {}
      : {
          rule: context.rule
            ? toPublicUtilityAbnormalityRule(context.rule)
            : null,
        }),
    ...(context.finding === undefined ? {} : { finding: context.finding }),
    ...(context.findingAvailableActions === undefined
      ? {}
      : { findingAvailableActions: context.findingAvailableActions }),
  };
}

/** BE-02G — an actor may only operate inside an explicitly assigned Building. */
async function assertBuildingAccess(
  actorUserId: string | undefined,
  buildingId: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (!(await contextAccessService.canAccessBuilding(actorUserId, buildingId))) {
    throw buildingAccessDeniedError();
  }
}

async function assertClientAccess(
  actorUserId: string | undefined,
  clientId: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function loadMeter(id: string): Promise<UtilityMeterRecord> {
  const meter = await utilityMeterRepository.findById(id);
  if (!meter) {
    throw utilityMeterNotFoundError();
  }
  return meter;
}

async function loadUom(uomId: string): Promise<AbnormalityUomSummary | null> {
  const result = await getPool().query<AbnormalityUomSummary>(
    'SELECT id, code, name, symbol FROM units_of_measure WHERE id = $1',
    [uomId],
  );
  return result.rows[0] ?? null;
}

async function loadConsumption(
  consumptionId: string,
): Promise<UtilityMeterConsumptionRecord> {
  const consumption =
    await utilityMeterConsumptionRepository.findById(consumptionId);
  if (!consumption) {
    throw utilityAbnormalConsumptionInvalidError(
      'The referenced consumption does not exist.',
    );
  }
  return consumption;
}

/* -------------------------------------------------------------------------
 * Detection rules
 * ---------------------------------------------------------------------- */

/**
 * A threshold is meaningful for some rule types and meaningless for others.
 * ZERO_USAGE and NEGATIVE_OR_INVALID are structural checks — the condition is
 * the definition, so no number is needed. The other three cannot work without
 * one, and refusing at configuration time is better than silently never
 * firing.
 */
function assertThresholdValid(
  abnormalityType: string,
  thresholdValue: number | null | undefined,
  comparisonMode: string,
): void {
  const structural =
    abnormalityType === 'ZERO_USAGE' ||
    abnormalityType === 'NEGATIVE_OR_INVALID';

  if (structural) {
    return;
  }

  if (thresholdValue === null || thresholdValue === undefined) {
    throw utilityAbnormalityThresholdInvalidError(
      `A threshold value is required for ${abnormalityType}.`,
    );
  }
  if (!Number.isFinite(thresholdValue) || thresholdValue < 0) {
    throw utilityAbnormalityThresholdInvalidError(
      'The threshold value must be a non-negative finite number.',
    );
  }
  // A LOW_USAGE rule at 100%+ of baseline would flag every normal period.
  if (
    comparisonMode === 'PERCENT_OF_BASELINE' &&
    abnormalityType === 'LOW_USAGE' &&
    thresholdValue >= 100
  ) {
    throw utilityAbnormalityThresholdInvalidError(
      'A LOW_USAGE percentage threshold must be below 100% of the baseline.',
    );
  }
}

export async function createUtilityAbnormalityRule(
  input: CreateUtilityAbnormalityRuleInput,
  actorUserId?: string,
): Promise<PublicUtilityAbnormalityRule> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  await assertClientAccess(actorUserId, input.clientId);

  const comparisonMode = input.comparisonMode ?? 'ABSOLUTE';
  assertThresholdValid(
    input.abnormalityType,
    input.thresholdValue,
    comparisonMode,
  );

  const newRule: NewUtilityAbnormalityRule = {
    clientId: input.clientId,
    utilityType: input.utilityType,
    abnormalityType: input.abnormalityType,
    name: input.name,
    description: input.description ?? null,
    thresholdValue: input.thresholdValue ?? null,
    comparisonMode,
    baselineWindow: input.baselineWindow ?? 3,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await utilityAbnormalConsumptionRepository.createRule(
      newRule,
    );
    return toPublicUtilityAbnormalityRule(record);
  } catch (error) {
    if (isUniqueViolation(error, 'utility_abnormality_rules_unique')) {
      throw utilityAbnormalityRuleAlreadyExistsError();
    }
    throw error;
  }
}

export async function listUtilityAbnormalityRules(
  clientId: string,
  filters: UtilityAbnormalityRuleFilters,
  actorUserId?: string,
): Promise<PublicUtilityAbnormalityRule[]> {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  await assertClientAccess(actorUserId, clientId);

  const records = await utilityAbnormalConsumptionRepository.listRulesByClient(
    clientId,
    filters,
  );
  return records.map(toPublicUtilityAbnormalityRule);
}

/* -------------------------------------------------------------------------
 * Detection
 * ---------------------------------------------------------------------- */

type RuleOutcome = {
  triggered: boolean;
  referenceValue: number | null;
};

/**
 * The whole of BE-18J's detection logic — five explicit comparisons, chosen
 * so each is auditable on sight.
 *
 * `baseline` is the mean of the prior periods from BE-18H, or null when the
 * meter has no history yet. Rules that need a baseline simply do not fire
 * without one: flagging the very first reading of a new meter as a "sudden
 * change" would be noise, not signal.
 */
function evaluateRule(
  rule: UtilityAbnormalityRuleRecord,
  value: number,
  baseline: number | null,
): RuleOutcome {
  const threshold =
    rule.thresholdValue === null ? null : Number(rule.thresholdValue);
  const percentMode = rule.comparisonMode === 'PERCENT_OF_BASELINE';

  switch (rule.abnormalityType) {
    case 'ZERO_USAGE':
      // A live meter reporting nothing usually means a fault, not thrift.
      return { triggered: value === 0, referenceValue: null };

    case 'NEGATIVE_OR_INVALID':
      // BE-18G refuses to store a negative delta, so this is a safety net for
      // data that arrived by another route.
      return {
        triggered: !Number.isFinite(value) || value < 0,
        referenceValue: null,
      };

    case 'HIGH_USAGE':
      if (threshold === null) {
        return { triggered: false, referenceValue: null };
      }
      if (percentMode) {
        if (baseline === null || baseline <= 0) {
          return { triggered: false, referenceValue: baseline };
        }
        return {
          triggered: value > baseline * (threshold / 100),
          referenceValue: baseline,
        };
      }
      return { triggered: value > threshold, referenceValue: threshold };

    case 'LOW_USAGE':
      if (threshold === null) {
        return { triggered: false, referenceValue: null };
      }
      if (percentMode) {
        if (baseline === null || baseline <= 0) {
          return { triggered: false, referenceValue: baseline };
        }
        return {
          triggered: value < baseline * (threshold / 100),
          referenceValue: baseline,
        };
      }
      // Zero is covered by ZERO_USAGE; LOW_USAGE is about a live but weak
      // meter, so a flat zero is left to the more specific rule.
      return {
        triggered: value > 0 && value < threshold,
        referenceValue: threshold,
      };

    case 'SUDDEN_CHANGE': {
      // A swing in either direction, measured against the baseline.
      if (threshold === null || baseline === null || baseline <= 0) {
        return { triggered: false, referenceValue: baseline };
      }
      const deltaPercent = (Math.abs(value - baseline) / baseline) * 100;
      return { triggered: deltaPercent > threshold, referenceValue: baseline };
    }

    default:
      return { triggered: false, referenceValue: null };
  }
}

/**
 * Mean consumption of the periods preceding this one on the same Meter,
 * read from the BE-18H projection so the chronology is BE-18H's, not
 * re-derived here.
 */
async function resolveBaseline(
  consumption: UtilityMeterConsumptionRecord,
  window: number,
): Promise<{ baseline: number | null; periods: number }> {
  const history = await utilityUsageHistoryRepository.listByScope(
    { column: 'meter_id', value: consumption.meterId },
    { order: 'DESC', to: consumption.periodStart, limit: window },
  );

  const priors = history.filter((entry) => entry.id !== consumption.id);
  if (priors.length === 0) {
    return { baseline: null, periods: 0 };
  }

  const total = priors.reduce(
    (sum, entry) => sum + Number(entry.consumptionValue),
    0,
  );
  return {
    baseline: Math.round((total / priors.length) * 1e6) / 1e6,
    periods: priors.length,
  };
}

/**
 * Evaluates one authoritative consumption against every ACTIVE rule for its
 * Client and utility type, persisting a record for each rule that fires.
 *
 * Idempotent by design: an abnormality already OPEN for the same
 * (consumption, type) is returned as-is rather than duplicated, so
 * re-evaluating a period is safe.
 */
export async function evaluateConsumption(
  input: EvaluateConsumptionInput,
  actorUserId?: string,
): Promise<UtilityAbnormalityEvaluation> {
  const consumption = await loadConsumption(input.consumptionId);
  await assertBuildingAccess(actorUserId, consumption.buildingId);

  const meter = await loadMeter(consumption.meterId);
  const rules = await utilityAbnormalConsumptionRepository.listActiveRules(
    consumption.clientId,
    meter.utilityType,
  );

  const value = Number(consumption.consumptionValue);
  const widestWindow = rules.reduce(
    (max, rule) => Math.max(max, rule.baselineWindow),
    0,
  );
  const { baseline, periods } =
    widestWindow > 0
      ? await resolveBaseline(consumption, widestWindow)
      : { baseline: null, periods: 0 };

  const detections: PublicUtilityAbnormalConsumption[] = [];

  for (const rule of rules) {
    // Each rule sees only as much history as it was configured to use.
    const ruleBaseline =
      rule.baselineWindow >= periods || baseline === null
        ? baseline
        : (await resolveBaseline(consumption, rule.baselineWindow)).baseline;

    const outcome = evaluateRule(rule, value, ruleBaseline);
    if (!outcome.triggered) {
      continue;
    }

    const existing =
      await utilityAbnormalConsumptionRepository.findOpenByConsumptionAndType(
        consumption.id,
        rule.abnormalityType,
      );
    if (existing) {
      // Already flagged and still open — re-detection must not pile up.
      detections.push(
        toPublicUtilityAbnormalConsumption(existing, { meter, rule }),
      );
      continue;
    }

    const newRecord: NewUtilityAbnormalConsumption = {
      clientId: consumption.clientId,
      buildingId: consumption.buildingId,
      meterId: consumption.meterId,
      utilityType: meter.utilityType,
      consumptionId: consumption.id,
      ruleId: rule.id,
      abnormalityType: rule.abnormalityType,
      comparisonMode: rule.comparisonMode,
      detectedValue: value,
      referenceValue: outcome.referenceValue,
      thresholdValue:
        rule.thresholdValue === null ? null : Number(rule.thresholdValue),
      uomId: consumption.uomId,
      periodStart: consumption.periodStart,
      periodEnd: consumption.periodEnd,
      detectedByUserId: input.detectedByUserId ?? null,
      // Tenant context comes from the consumption (BE-18D snapshot), so it
      // reflects who the meter served across the period.
      tenantAssignmentId: consumption.tenantAssignmentId,
      tenantCompanyId: consumption.tenantCompanyId,
      notes: input.notes ?? null,
    };

    let record: UtilityAbnormalConsumptionRecord;
    try {
      record = await utilityAbnormalConsumptionRepository.create(newRecord);
    } catch (error) {
      if (
        isUniqueViolation(
          error,
          'utility_abnormal_consumptions_open_unique',
        )
      ) {
        // Lost a concurrent race; the winner's record is the right answer.
        const winner =
          await utilityAbnormalConsumptionRepository.findOpenByConsumptionAndType(
            consumption.id,
            rule.abnormalityType,
          );
        if (winner) {
          detections.push(
            toPublicUtilityAbnormalConsumption(winner, { meter, rule }),
          );
          continue;
        }
        throw utilityAbnormalConsumptionAlreadyOpenError();
      }
      throw error;
    }

    await recordOperationalEvent({
      clientId: record.clientId,
      eventType: 'UTILITY_ABNORMAL_CONSUMPTION_DETECTED',
      entityType: 'UTILITY_ABNORMAL_CONSUMPTION',
      entityId: record.id,
      ...(input.detectedByUserId
        ? { actorUserId: input.detectedByUserId }
        : {}),
      buildingId: record.buildingId,
      summary: `${rule.abnormalityType} detected on meter ${meter.code}`,
      metadata: {
        meterId: meter.id,
        utilityType: record.utilityType,
        consumptionId: record.consumptionId,
        abnormalityType: record.abnormalityType,
        detectedValue: Number(record.detectedValue),
        referenceValue:
          record.referenceValue === null ? null : Number(record.referenceValue),
        thresholdValue:
          record.thresholdValue === null ? null : Number(record.thresholdValue),
        periodStart: record.periodStart.toISOString(),
        periodEnd: record.periodEnd.toISOString(),
        tenantCompanyId: record.tenantCompanyId,
      },
    });

    detections.push(
      toPublicUtilityAbnormalConsumption(record, { meter, rule }),
    );
  }

  return {
    consumptionId: consumption.id,
    meterId: consumption.meterId,
    evaluatedValue: value,
    baselineValue: baseline,
    baselinePeriods: periods,
    normal: detections.length === 0,
    rulesEvaluated: rules.length,
    detections,
  };
}

/** Closes a flag: RESOLVED (acted on) or DISMISSED (judged not a problem). */
export async function resolveUtilityAbnormalConsumption(
  input: ResolveUtilityAbnormalConsumptionInput,
  actorUserId?: string,
): Promise<PublicUtilityAbnormalConsumption> {
  const existing = await utilityAbnormalConsumptionRepository.findById(
    input.abnormalConsumptionId,
  );
  if (!existing) {
    throw utilityAbnormalConsumptionNotFoundError();
  }
  await assertBuildingAccess(actorUserId, existing.buildingId);

  if (existing.status !== 'OPEN') {
    throw utilityAbnormalConsumptionNotOpenError();
  }

  const record = await utilityAbnormalConsumptionRepository.markClosed(
    existing.id,
    input.status,
    actorUserId ?? null,
    input.resolutionNotes ?? null,
  );
  if (!record) {
    throw utilityAbnormalConsumptionNotOpenError(
      'This abnormal consumption record was closed concurrently.',
    );
  }

  await recordOperationalEvent({
    clientId: record.clientId,
    eventType: 'UTILITY_ABNORMAL_CONSUMPTION_CLOSED',
    entityType: 'UTILITY_ABNORMAL_CONSUMPTION',
    entityId: record.id,
    ...(actorUserId ? { actorUserId } : {}),
    buildingId: record.buildingId,
    summary: `Abnormal consumption ${record.status.toLowerCase()}`,
    metadata: {
      meterId: record.meterId,
      consumptionId: record.consumptionId,
      abnormalityType: record.abnormalityType,
      status: record.status,
      findingId: record.findingId,
    },
  });

  return enrichOne(record);
}

/**
 * Binds operational follow-up to BE-09.
 *
 * Either links an existing Finding or asks BE-09 to create one. Everything
 * about that Finding — its number, workflow, assignment, status and available
 * actions — stays BE-09's; this module only records the reference. A Finding
 * from another Client or Building is refused, so the link cannot be used to
 * cross an isolation boundary.
 */
export async function linkAbnormalConsumptionFinding(
  input: LinkAbnormalConsumptionFindingInput,
  actorUserId: string,
): Promise<PublicUtilityAbnormalConsumption> {
  const existing = await utilityAbnormalConsumptionRepository.findById(
    input.abnormalConsumptionId,
  );
  if (!existing) {
    throw utilityAbnormalConsumptionNotFoundError();
  }
  await assertBuildingAccess(actorUserId, existing.buildingId);

  if (existing.status !== 'OPEN') {
    throw utilityAbnormalConsumptionNotOpenError(
      'A closed abnormal consumption record cannot take new follow-up.',
    );
  }
  if (existing.findingId) {
    throw utilityAbnormalConsumptionFindingConflictError();
  }

  let finding: PublicFinding;
  if (input.findingId) {
    finding = await findingService.getFindingById(input.findingId);
    if (!finding) {
      throw findingNotFoundError();
    }
    // A Finding elsewhere cannot be adopted as this abnormality's follow-up.
    if (
      finding.clientId !== existing.clientId ||
      finding.buildingId !== existing.buildingId
    ) {
      throw utilityAbnormalConsumptionFindingConflictError(
        'The finding belongs to a different client or building.',
      );
    }
  } else {
    const meter = await loadMeter(existing.meterId);
    // BE-09 creates and owns the Finding; BE-18J supplies context only.
    finding = await findingService.createFinding({
      clientId: existing.clientId,
      buildingId: existing.buildingId,
      findingNumber: `UTL_${randomUUID().slice(0, 8).toUpperCase()}`,
      title:
        input.title ??
        `${existing.abnormalityType} on meter ${meter.code}`,
      ...(input.description === undefined || input.description === null
        ? {}
        : { description: input.description }),
      reportedByUserId: actorUserId,
    });
  }

  const record = await utilityAbnormalConsumptionRepository.attachFinding(
    existing.id,
    finding.id,
  );
  if (!record) {
    throw utilityAbnormalConsumptionFindingConflictError(
      'A finding was linked concurrently.',
    );
  }

  await recordOperationalEvent({
    clientId: record.clientId,
    eventType: 'UTILITY_ABNORMAL_CONSUMPTION_FINDING_LINKED',
    entityType: 'UTILITY_ABNORMAL_CONSUMPTION',
    entityId: record.id,
    actorUserId,
    buildingId: record.buildingId,
    summary: 'Finding linked to abnormal consumption',
    metadata: {
      meterId: record.meterId,
      consumptionId: record.consumptionId,
      abnormalityType: record.abnormalityType,
      findingId: finding.id,
      findingNumber: finding.findingNumber,
    },
  });

  return enrichOne(record, actorUserId);
}

async function enrichOne(
  record: UtilityAbnormalConsumptionRecord,
  actorUserId?: string,
): Promise<PublicUtilityAbnormalConsumption> {
  const [meter, uom, consumption, rule] = await Promise.all([
    utilityMeterRepository.findById(record.meterId),
    loadUom(record.uomId),
    utilityMeterConsumptionRepository.findById(record.consumptionId),
    record.ruleId
      ? utilityAbnormalConsumptionRepository.findRuleById(record.ruleId)
      : Promise.resolve(null),
  ]);

  // BE-09 stays the authority for the Finding and its available actions.
  let finding: PublicFinding | null = null;
  let findingAvailableActions: FindingAction[] | undefined;
  if (record.findingId) {
    finding = await findingService.getFindingById(record.findingId);
    if (actorUserId) {
      const actions = await findingActionService.resolveAvailableActions(
        record.findingId,
        { userId: actorUserId },
      );
      findingAvailableActions = actions.availableActions;
    }
  }

  return toPublicUtilityAbnormalConsumption(record, {
    meter,
    uom,
    consumption,
    rule,
    finding,
    ...(findingAvailableActions === undefined ? {} : { findingAvailableActions }),
  });
}

async function enrich(
  records: readonly UtilityAbnormalConsumptionRecord[],
): Promise<PublicUtilityAbnormalConsumption[]> {
  const meters = new Map<string, UtilityMeterRecord | null>();
  const uoms = new Map<string, AbnormalityUomSummary | null>();

  for (const id of new Set(records.map((record) => record.meterId))) {
    meters.set(id, await utilityMeterRepository.findById(id));
  }
  for (const id of new Set(records.map((record) => record.uomId))) {
    uoms.set(id, await loadUom(id));
  }

  return records.map((record) =>
    toPublicUtilityAbnormalConsumption(record, {
      meter: meters.get(record.meterId) ?? null,
      uom: uoms.get(record.uomId) ?? null,
    }),
  );
}

export async function getUtilityAbnormalConsumptionById(
  id: string,
  actorUserId?: string,
): Promise<PublicUtilityAbnormalConsumption> {
  const record = await utilityAbnormalConsumptionRepository.findById(id);
  if (!record) {
    throw utilityAbnormalConsumptionNotFoundError();
  }
  await assertBuildingAccess(actorUserId, record.buildingId);
  return enrichOne(record, actorUserId);
}

/** Every abnormality raised against one consumption, newest first. */
export async function listAbnormalConsumptionsByConsumption(
  consumptionId: string,
  actorUserId?: string,
): Promise<PublicUtilityAbnormalConsumption[]> {
  const consumption = await loadConsumption(consumptionId);
  await assertBuildingAccess(actorUserId, consumption.buildingId);

  const records =
    await utilityAbnormalConsumptionRepository.listByConsumption(consumptionId);
  return enrich(records);
}

export async function listAbnormalConsumptionsByMeter(
  meterId: string,
  filters: UtilityAbnormalConsumptionFilters,
  actorUserId?: string,
): Promise<PublicUtilityAbnormalConsumption[]> {
  const meter = await loadMeter(meterId);
  await assertBuildingAccess(actorUserId, meter.buildingId);

  const records = await utilityAbnormalConsumptionRepository.listByScope(
    { column: 'meter_id', value: meter.id },
    filters,
  );
  return enrich(records);
}

export async function listAbnormalConsumptionsByBuilding(
  buildingId: string,
  filters: UtilityAbnormalConsumptionFilters,
  actorUserId?: string,
): Promise<PublicUtilityAbnormalConsumption[]> {
  await assertBuildingAccess(actorUserId, buildingId);

  const records = await utilityAbnormalConsumptionRepository.listByScope(
    { column: 'building_id', value: buildingId },
    filters,
  );
  return enrich(records);
}

/**
 * Tenant-scoped abnormalities, restricted at the database level to the
 * Buildings the actor can access.
 */
export async function listAbnormalConsumptionsByTenantCompany(
  tenantCompanyId: string,
  filters: UtilityAbnormalConsumptionFilters,
  actorUserId?: string,
): Promise<PublicUtilityAbnormalConsumption[]> {
  const tenantCompany = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!tenantCompany) {
    throw tenantCompanyNotFoundError();
  }
  if (
    actorUserId &&
    !(await contextAccessService.canAccessClient(
      actorUserId,
      tenantCompany.clientId,
    ))
  ) {
    throw buildingAccessDeniedError();
  }

  const buildingIds = actorUserId
    ? await contextAccessService.getAccessibleBuildingIds(actorUserId)
    : null;

  const records = await utilityAbnormalConsumptionRepository.listByScope(
    { column: 'tenant_company_id', value: tenantCompanyId },
    filters,
    buildingIds,
  );
  return enrich(records);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

export const utilityAbnormalConsumptionService = {
  createUtilityAbnormalityRule,
  evaluateConsumption,
  getUtilityAbnormalConsumptionById,
  linkAbnormalConsumptionFinding,
  listAbnormalConsumptionsByBuilding,
  listAbnormalConsumptionsByConsumption,
  listAbnormalConsumptionsByMeter,
  listAbnormalConsumptionsByTenantCompany,
  listUtilityAbnormalityRules,
  resolveUtilityAbnormalConsumption,
  toPublicUtilityAbnormalConsumption,
  toPublicUtilityAbnormalityRule,
};
