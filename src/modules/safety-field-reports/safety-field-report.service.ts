import { getPool, withTransaction } from '../../database';
import { buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import {
  incidentRepository,
  isIncidentNumberUniqueViolation,
  resolveBuildingContext,
  resolveLocation,
} from '../incidents';
import {
  operationalIncidentNotFoundError,
  operationalIncidentOccurrenceInvalidError,
  operationalIncidentRepository,
} from '../operational-incidents';
import { recordOperationalEvent } from '../operational-events';
import { workforceRepository } from '../workforce/workforce.repository';
import {
  safetyFieldReportNotFoundError,
  safetyReportActiveShiftRequiredError,
  safetyReportBuildingMismatchError,
  safetyReportShiftAmbiguousError,
} from './safety-field-report.errors';
import type {
  CreateSafetyFieldReportInput,
  PublicSafetyFieldReport,
  SafetyReportType,
} from './safety-field-report.types';
import { isSafetyReportType } from './safety-field-report.types';

function assertOccurrence(occurredAt: Date): void {
  if (occurredAt.getTime() > Date.now()) {
    throw operationalIncidentOccurrenceInvalidError();
  }
}

type ReportingRow = {
  assignment_id: string;
  shift_id: string;
  building_id: string;
  building_timezone: string | null;
  start_time: string;
  end_time: string;
  effective_from: Date | null;
  effective_until: Date | null;
  security_post_id: string | null;
};

const REPORTING_SHIFT_SELECT = `
  SELECT
    wsa.id           AS assignment_id,
    wsa.shift_id     AS shift_id,
    s.building_id    AS building_id,
    b.timezone       AS building_timezone,
    s.start_time,
    s.end_time,
    wsa.effective_from,
    wsa.effective_until,
    wsa.security_post_id
  FROM workforce_shift_assignments wsa
  JOIN shifts s        ON s.id = wsa.shift_id
  JOIN buildings b     ON b.id = s.building_id
  WHERE wsa.workforce_profile_id = $1
    AND wsa.status = 'ACTIVE'
    AND s.status = 'ACTIVE'
    AND s.building_id = ANY($2::uuid[])
    AND (wsa.effective_from IS NULL OR wsa.effective_from <= $3)
    AND (wsa.effective_until IS NULL OR wsa.effective_until >= $3)
`;

function localTimeOfDay(now: Date, timeZone: string | null): string | null {
  if (!timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === type)?.value ?? '00';
    return `${get('hour')}:${get('minute')}:${get('second')}`;
  } catch {
    return null;
  }
}

function secondsOfDay(value: string): number {
  const [h, m, s] = value.split(':').map((p) => Number(p) || 0);
  return h * 3600 + m * 60 + s;
}

function isWithinWindow(local: string, start: string, end: string): boolean {
  const now = secondsOfDay(local);
  const from = secondsOfDay(start);
  const to = secondsOfDay(end);
  if (from === to) return false;
  if (from < to) return now >= from && now < to;
  return now >= from || now < to;
}

async function resolveReportingShiftContext(
  actorUserId: string,
  requestedBuildingId: string,
  now: Date,
): Promise<{ assignmentId: string; buildingId: string }> {
  const profile = await workforceRepository.findByUserId(actorUserId);
  if (!profile || profile.status !== 'ACTIVE') {
    throw safetyReportActiveShiftRequiredError();
  }

  const buildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
  if (buildingIds.length === 0) {
    throw safetyReportActiveShiftRequiredError();
  }

  const result = await getPool().query<ReportingRow>(REPORTING_SHIFT_SELECT, [
    profile.id,
    buildingIds,
    now,
  ]);

  const currentRows: ReportingRow[] = [];
  for (const row of result.rows) {
    const local = localTimeOfDay(now, row.building_timezone);
    if (local === null) continue;
    if (!isWithinWindow(local, row.start_time, row.end_time)) continue;
    currentRows.push(row);
  }

  const matchingInBuilding = currentRows.filter((r) => r.building_id === requestedBuildingId);

  if (matchingInBuilding.length === 0) {
    if (currentRows.length === 0) {
      throw safetyReportActiveShiftRequiredError();
    }
    throw safetyReportBuildingMismatchError();
  }

  if (matchingInBuilding.length > 1) {
    throw safetyReportShiftAmbiguousError();
  }

  const canonical = matchingInBuilding[0];
  return {
    assignmentId: canonical.assignment_id,
    buildingId: canonical.building_id,
  };
}

function resolveLocationId(record: {
  location_type: string | null;
  floor_id: string | null;
  area_id: string | null;
  room_id: string | null;
  space_id: string | null;
  functional_location_id: string | null;
}): string | null {
  switch (record.location_type) {
    case 'FLOOR':
      return record.floor_id;
    case 'AREA':
      return record.area_id;
    case 'ROOM':
      return record.room_id;
    case 'SPACE':
      return record.space_id;
    case 'FUNCTIONAL_LOCATION':
      return record.functional_location_id;
    default:
      return null;
  }
}

export async function createSafetyFieldReport(
  input: CreateSafetyFieldReportInput,
  actorUserId: string,
): Promise<PublicSafetyFieldReport> {
  const { clientId } = await resolveBuildingContext(
    input.buildingId,
    actorUserId,
  );
  const location = await resolveLocation(
    input.locationType,
    input.locationId,
    input.buildingId,
  );
  assertOccurrence(input.occurredAt);

  // Derive shift context
  const shiftCtx = await resolveReportingShiftContext(
    actorUserId,
    input.buildingId,
    new Date(),
  );

  if (shiftCtx.buildingId !== input.buildingId) {
    throw safetyReportBuildingMismatchError();
  }

  const reportedByUserId = actorUserId;
  const reportedShiftAssignmentId = shiftCtx.assignmentId;

  try {
    const incidentId = await withTransaction(async (client) => {
      const incident = await incidentRepository.create(
        {
          clientId,
          buildingId: input.buildingId,
          incidentNumber: input.incidentNumber,
          incidentType: 'OPERATIONAL',
          title: input.title,
          description: input.description ?? null,
          severity: input.severity ?? 'MEDIUM',
          priority: input.priority ?? 'MEDIUM',
          ...location,
          reportedByUserId,
          reportedAt: new Date(),
        },
        client,
      );

      await client.query(
        `INSERT INTO operational_incidents
           (id, incident_id, operational_category, occurred_at, notes,
            created_by_user_id, reported_shift_assignment_id, reported_security_post_id,
            safety_report_type)
         VALUES ($1, $2, 'SAFETY', $3, $4, $5, $6, NULL, $7)`,
        [
          (await import('node:crypto')).randomUUID(),
          incident.id,
          input.occurredAt,
          input.notes ?? null,
          actorUserId,
          reportedShiftAssignmentId,
          input.reportType,
        ],
      );

      return incident.id;
    });

    const created = await getSafetyFieldReport(incidentId, actorUserId);

    await recordOperationalEvent({
      clientId: created.clientId,
      buildingId: created.buildingId,
      entityType: 'INCIDENT',
      entityId: created.id,
      eventType: 'OPERATIONAL_INCIDENT_REPORTED',
      actorUserId,
      summary: `Safety Field Report ${created.incidentNumber} (${created.reportType}) reported`,
      metadata: {
        incidentNumber: created.incidentNumber,
        reportType: created.reportType,
        operationalCategory: 'SAFETY',
        severity: created.severity,
        priority: created.priority,
        occurredAt: created.occurredAt,
        reportedShiftAssignmentId: created.reportedShiftAssignmentId,
      },
    });

    return created;
  } catch (error) {
    if (isIncidentNumberUniqueViolation(error)) {
      throw (await import('../incidents')).incidentNumberAlreadyExistsError();
    }
    throw error;
  }
}

export async function getSafetyFieldReport(
  incidentId: string,
  actorUserId: string,
): Promise<PublicSafetyFieldReport> {
  const result = await getPool().query<{
    id: string;
    operational_incident_id: string;
    client_id: string;
    building_id: string;
    incident_number: string;
    incident_type: string;
    title: string;
    description: string | null;
    severity: string;
    priority: string;
    incident_status: string;
    operational_status: string;
    operational_category: string;
    safety_report_type: string | null;
    occurred_at: Date;
    reported_at: Date;
    location_type: string | null;
    floor_id: string | null;
    area_id: string | null;
    room_id: string | null;
    space_id: string | null;
    functional_location_id: string | null;
    notes: string | null;
    reported_by_user_id: string;
    reported_shift_assignment_id: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT
       i.id,
       oi.id AS operational_incident_id,
       i.client_id,
       i.building_id,
       i.incident_number,
       i.incident_type,
       i.title,
       i.description,
       i.severity,
       i.priority,
       i.status AS incident_status,
       oi.operational_status,
       oi.operational_category,
       oi.safety_report_type,
       oi.occurred_at,
       i.reported_at,
       i.location_type,
       i.floor_id,
       i.area_id,
       i.room_id,
       i.space_id,
       i.functional_location_id,
       oi.notes,
       i.reported_by_user_id,
       oi.reported_shift_assignment_id,
       oi.created_at,
       oi.updated_at
     FROM operational_incidents oi
     JOIN incidents i ON i.id = oi.incident_id
     WHERE oi.incident_id = $1`,
    [incidentId],
  );

  const row = result.rows[0];
  if (!row) {
    throw safetyFieldReportNotFoundError();
  }

  // Must have building access
  await contextAccessService.assertBuildingAccess(actorUserId, row.building_id);

  // Must be operationalCategory == 'SAFETY' and safety_report_type IN ('HAZARD', 'NEAR_MISS')
  if (
    row.operational_category !== 'SAFETY' ||
    !row.safety_report_type ||
    !isSafetyReportType(row.safety_report_type)
  ) {
    throw safetyFieldReportNotFoundError();
  }

  return {
    id: row.id,
    operationalIncidentId: row.operational_incident_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    incidentNumber: row.incident_number,
    reportType: row.safety_report_type as SafetyReportType,
    title: row.title,
    description: row.description,
    severity: row.severity as any,
    priority: row.priority as any,
    incidentStatus: row.incident_status as any,
    operationalStatus: row.operational_status as any,
    occurredAt: row.occurred_at.toISOString(),
    reportedAt: row.reported_at.toISOString(),
    locationType: row.location_type,
    locationId: resolveLocationId(row),
    notes: row.notes,
    reportedByUserId: row.reported_by_user_id,
    reportedShiftAssignmentId: row.reported_shift_assignment_id ?? '',
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const safetyFieldReportService = {
  createSafetyFieldReport,
  getSafetyFieldReport,
};
