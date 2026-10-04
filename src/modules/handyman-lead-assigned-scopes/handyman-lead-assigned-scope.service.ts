import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations';
import { handymanLeadAssignedScopeRepository }
  from './handyman-lead-assigned-scope.repository';
import type {
  HandymanLeadAssignedScopeCard,
  HandymanLeadAssignedScopeDetail,
  HandymanLeadAssignedScopePage,
  HandymanLeadCurrentReadiness,
  HandymanLeadLocationSource,
  HandymanLeadPermitReadiness,
  HandymanLeadPreferredWindow,
  HandymanLeadSchedulingReadiness,
  HandymanLeadScopeLocation,
  HandymanLeadUnitAccessReadiness,
  HandymanLeadWorkItem,
  HandymanLeadWorkItemRecord,
} from './handyman-lead-assigned-scope.types';

const STRUCTURED_CODE_PATTERN = /^[A-Z][A-Z0-9_-]{0,63}$/;

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function fieldText(value: string | null | undefined, maxLength: number): string {
  return (value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

/** Emit identifiers from validated master-code fields, never display names. */
function structuredCodeLabel(
  prefix: 'Building' | 'Area' | 'Room' | 'Space',
  value: string | null,
): string | null {
  const code = value?.trim() ?? '';
  if (!STRUCTURED_CODE_PATTERN.test(code)) return null;
  return `${prefix} ${code}`;
}

function floorLevelLabel(levelNumber: number | null): string | null {
  if (
    levelNumber === null ||
    !Number.isInteger(levelNumber) ||
    levelNumber < -100 ||
    levelNumber > 500
  ) {
    return null;
  }
  return `Floor ${levelNumber}`;
}

function fieldLocation(
  source: HandymanLeadLocationSource,
): HandymanLeadScopeLocation {
  return {
    buildingLabel: structuredCodeLabel('Building', source.buildingCode)
      || 'Building',
    floorLabel: floorLevelLabel(source.floorLevelNumber),
    areaLabel: structuredCodeLabel('Area', source.areaCode),
    roomLabel: structuredCodeLabel('Room', source.roomCode),
    spaceLabel: structuredCodeLabel('Space', source.spaceCode),
  };
}

function preferredWindow(source: {
  preferredWindowStart: Date | null;
  preferredWindowEnd: Date | null;
  preferredWindowTimezone: string | null;
}): HandymanLeadPreferredWindow | null {
  if (
    !source.preferredWindowStart ||
    !source.preferredWindowEnd ||
    !source.preferredWindowTimezone
  ) {
    return null;
  }
  return {
    preferredWindowStart: iso(source.preferredWindowStart),
    preferredWindowEnd: iso(source.preferredWindowEnd),
    timezone: source.preferredWindowTimezone,
  };
}

function toCard(row: {
  executionScopeId: string;
  assignmentId: string;
  assignedAt: Date;
  serviceLabel: string;
  location: HandymanLeadLocationSource;
  preferredWindowStart: Date | null;
  preferredWindowEnd: Date | null;
  preferredWindowTimezone: string | null;
}): HandymanLeadAssignedScopeCard {
  return {
    executionScopeId: row.executionScopeId,
    assignmentId: row.assignmentId,
    assignmentStatus: 'ACTIVE',
    scopeStatus: 'AUTHORIZED',
    assignedAt: iso(row.assignedAt),
    serviceLabel: fieldText(row.serviceLabel, 200) || 'Handyman Service',
    location: fieldLocation(row.location),
    preferredWindow: preferredWindow(row),
  };
}

/**
 * A fixed field label is derived only from the approved line-type enum. The
 * free-text quotation description is intentionally not read or projected.
 */
function toWorkItem(row: HandymanLeadWorkItemRecord): HandymanLeadWorkItem {
  return {
    lineType: row.lineType,
    description: row.lineType === 'LABOR'
      ? 'Labor work item'
      : 'Material work item',
    quantity: Number(row.quantity),
    unitLabel: fieldText(row.unitLabel, 80) || 'unit',
  };
}

function currentReadiness(source: {
  scheduling: {
    status: 'ACTIVE';
    preferredWindowStart: Date;
    preferredWindowEnd: Date;
    timezone: string;
  } | null;
  unitAccess: {
    status: 'ACTIVE';
    accessWindowStart: Date;
    accessWindowEnd: Date;
  } | null;
  permits: Array<{
    permitType: 'UNIT' | 'BUILDING_COMMON_AREA';
    status: 'ACTIVE';
    validFrom: Date;
    validUntil: Date;
  }>;
}): HandymanLeadCurrentReadiness {
  const scheduling: HandymanLeadSchedulingReadiness | null =
    source.scheduling
      ? {
        status: 'ACTIVE',
        preferredWindowStart: iso(source.scheduling.preferredWindowStart),
        preferredWindowEnd: iso(source.scheduling.preferredWindowEnd),
        timezone: source.scheduling.timezone,
      }
      : null;
  const unitAccess: HandymanLeadUnitAccessReadiness | null =
    source.unitAccess
      ? {
        status: 'ACTIVE',
        accessWindowStart: iso(source.unitAccess.accessWindowStart),
        accessWindowEnd: iso(source.unitAccess.accessWindowEnd),
      }
      : null;
  const permitReadiness: HandymanLeadPermitReadiness[] =
    source.permits.map((permit) => ({
      permitType: permit.permitType,
      status: 'ACTIVE',
      validFrom: iso(permit.validFrom),
      validUntil: iso(permit.validUntil),
    }));
  return { scheduling, unitAccess, permitReadiness };
}

export async function listHandymanLeadAssignedScopes(
  actorUserId: string,
  pagination: { page: number; pageSize: number },
): Promise<HandymanLeadAssignedScopePage> {
  // Candidate Clients come only from current ACTIVE assignment → crew →
  // current Lead → ACTIVE membership/worker-context resolution. Client access
  // is independently checked for every Client before it can enter the page.
  const candidateClientIds = await handymanLeadAssignedScopeRepository
    .listCurrentLeadClientIds(actorUserId);
  const access = await Promise.all(candidateClientIds.map(async (clientId) => ({
    clientId,
    allowed: await contextAccessService.canAccessClient(actorUserId, clientId),
  })));
  const accessibleClientIds = access
    .filter((item) => item.allowed)
    .map((item) => item.clientId);
  const offset = (pagination.page - 1) * pagination.pageSize;
  const result = await handymanLeadAssignedScopeRepository
    .listCurrentLeadAssignedScopeCards(
      actorUserId,
      accessibleClientIds,
      pagination.pageSize,
      offset,
    );

  return {
    data: result.rows.map(toCard),
    meta: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: result.total,
      totalPages: result.total === 0
        ? 0
        : Math.ceil(result.total / pagination.pageSize),
    },
  };
}

export async function getHandymanLeadAssignedScope(
  actorUserId: string,
  executionScopeId: string,
): Promise<HandymanLeadAssignedScopeDetail> {
  // Matching the current Lead chain before checking Client access preserves
  // the frozen missing/not-assigned 404 shape without disclosing another
  // Lead's assignment. The access check is over the server-resolved Client.
  const scope = await handymanLeadAssignedScopeRepository
    .findCurrentLeadAssignedScope(actorUserId, executionScopeId);
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (!(await contextAccessService.canAccessClient(
    actorUserId,
    scope.clientId,
  ))) {
    throw buildingAccessDeniedError();
  }

  const [workItems, scheduling, unitAccess, permits] = await Promise.all([
    handymanLeadAssignedScopeRepository
      .listApprovedWorkItems(scope.executionScopeId),
    handymanLeadAssignedScopeRepository
      .findCurrentSchedulingReadiness(scope.executionScopeId),
    handymanLeadAssignedScopeRepository
      .findCurrentUnitAccessReadiness(scope.executionScopeId),
    handymanLeadAssignedScopeRepository
      .listCurrentPermitReadiness(scope.executionScopeId),
  ]);

  return {
    executionScopeId: scope.executionScopeId,
    assignmentId: scope.assignmentId,
    assignmentStatus: 'ACTIVE',
    scopeStatus: 'AUTHORIZED',
    assignedAt: iso(scope.assignedAt),
    serviceLabel: fieldText(scope.serviceLabel, 200) || 'Handyman Service',
    location: fieldLocation(scope.location),
    workItems: workItems.map(toWorkItem),
    readiness: currentReadiness({ scheduling, unitAccess, permits }),
  };
}
