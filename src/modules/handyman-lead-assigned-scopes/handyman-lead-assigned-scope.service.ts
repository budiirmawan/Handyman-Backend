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
  HandymanLeadPermitReadiness,
  HandymanLeadPreferredWindow,
  HandymanLeadSchedulingReadiness,
  HandymanLeadUnitAccessReadiness,
  HandymanLeadWorkItem,
} from './handyman-lead-assigned-scope.types';

const MAX_LABEL_LENGTH = 160;

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

function locationLabel(
  value: string | null | undefined,
): string | null {
  const safe = fieldText(value, MAX_LABEL_LENGTH)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
    .replace(
      /(?<![\w])(?:\+?62|0)[\s().-]*(?:\d[\s().-]*){8,12}(?!\d)/g,
      '[redacted]',
    )
    .replace(/\b\d{4,}(?:[.,]\d+)?\b/g, '[redacted]')
    .replace(
      /\b(?:customer|tenant|client|pic|contact(?: person)?|resident|homeowner|requester)\s*[:=-]\s*[^;,.]+/gi,
      '[redacted]',
    )
    .replace(
      /\b(?:mr|mrs|ms|miss|dr)\.?\s+\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?/gu,
      '[redacted]',
    )
    .trim();
  return safe || null;
}

function fieldLocation(source: {
  buildingLabel: string;
  floorLabel: string | null;
  areaLabel: string | null;
  roomLabel: string | null;
  spaceLabel: string | null;
}) {
  return {
    buildingLabel: locationLabel(source.buildingLabel) || 'Building',
    floorLabel: locationLabel(source.floorLabel),
    areaLabel: locationLabel(source.areaLabel),
    roomLabel: locationLabel(source.roomLabel),
    spaceLabel: locationLabel(source.spaceLabel),
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
  location: {
    buildingLabel: string;
    floorLabel: string | null;
    areaLabel: string | null;
    roomLabel: string | null;
    spaceLabel: string | null;
  };
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
 * The source is an approved, operator-authored quotation work item. The
 * field projection never reads the customer request description or identity
 * lineage; obvious contact details and labeled customer/contact fragments in
 * the work description are also removed before they reach the field client.
 */
function sanitizeOperationalDescription(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // If an approved line has become a commercial note rather than a field
  // instruction, fail closed instead of forwarding an amount or quote text.
  if (
    /\b(price|cost|amount|total|discount|quote|quoted|invoice|payment|currency|budget|tax|vat)\b/i
      .test(normalized)
  ) {
    return 'Approved work item';
  }
  const sanitized = normalized
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
    .replace(
      /(?<![\w])(?:\+?62|0)[\s().-]*(?:\d[\s().-]*){8,12}(?!\d)/g,
      '[redacted]',
    )
    .replace(
      /(?:\b(?:IDR|RUPIAH|USD|EUR|SGD)\b|Rp\.?|[$€£])\s*\d[\d.,]*/gi,
      '[redacted]',
    )
    .replace(/\b\d{4,}(?:[.,]\d+)?\b/g, '[redacted]')
    .replace(
      /\b(customer|tenant|client|pic|contact(?: person)?|resident|homeowner|requester|phone|email|mobile|whatsapp)\s*[:=-]\s*[^;,.]+/gi,
      '$1: [redacted]',
    )
    .slice(0, 500)
    .trim();
  return sanitized || 'Approved work item';
}

function toWorkItem(row: {
  lineType: 'LABOR' | 'MATERIAL';
  description: string;
  quantity: number;
  unitLabel: string;
}): HandymanLeadWorkItem {
  return {
    lineType: row.lineType,
    description: sanitizeOperationalDescription(row.description),
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
