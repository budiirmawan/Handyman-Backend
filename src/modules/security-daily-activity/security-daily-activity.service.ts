import { buildingNotFoundError } from '../buildings';
import { contextAccessService } from '../context-access';
import { resolveAssetBuildingContext } from '../assets';
import { AppError } from '../../shared/errors';
import { findingActionService } from '../findings';
import { shiftRepository } from '../shifts';
import {
  securityDailyActivityRepository,
  operationalDateWindow,
} from './security-daily-activity.repository';
import type {
  PublicSecurityDailyActivity,
  SecurityDailyActivityChecklist,
  SecurityDailyActivityFinding,
  SecurityDailyActivityFilter,
  SecurityDailyActivityPatrol,
  SecurityDailyActivityPost,
  SecurityDailyActivityShift,
  SecurityDailyActivitySummary,
} from './security-daily-activity.types';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

function assertValidDate(date: string | undefined): string {
  if (!date) {
    throw AppError.validation('Request validation failed.', [
      { field: 'date', message: 'date is required (YYYY-MM-DD).' },
    ]);
  }
  if (!isValidIsoDate(date)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'date', message: 'date must be a valid ISO date (YYYY-MM-DD).' },
    ]);
  }
  return date;
}

export async function getSecurityDailyActivity(
  buildingId: string,
  filter: SecurityDailyActivityFilter,
  actorUserId: string,
): Promise<PublicSecurityDailyActivity> {
  const context = await resolveAssetBuildingContext(buildingId);
  if (!context) {
    throw buildingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);

  const date = assertValidDate(filter.date);
  const window = operationalDateWindow(date);

  let shift: SecurityDailyActivityShift | null = null;
  if (filter.shiftId) {
    const shiftRow = await shiftRepository.findById(filter.shiftId);
    if (
      !shiftRow ||
      shiftRow.clientId !== context.clientId ||
      shiftRow.buildingId !== buildingId
    ) {
      throw AppError.notFound('Shift not found in this building context.');
    }
    shift = {
      id: shiftRow.id,
      code: shiftRow.code,
      name: shiftRow.name,
      startTime: shiftRow.startTime,
      endTime: shiftRow.endTime,
      status: shiftRow.status,
    };
  }

  let securityPost: SecurityDailyActivityPost | null = null;
  if (filter.securityPostId) {
    // Resolve via a single targeted read on the security_posts table to
    // confirm the post belongs to the building.
    const { securityPostRepository } = await import('../security-posts');
    const post = await securityPostRepository.findById(
      filter.securityPostId,
    );
    if (!post || post.buildingId !== buildingId) {
      throw AppError.notFound(
        'Security post not found in this building context.',
      );
    }
    securityPost = {
      id: post.id,
      code: post.code,
      name: post.name,
      postType: post.postType,
      status: post.status,
    };
  }

  // Three parallel reads. Each one already filters by Building and
  // (where applicable) the operational date window. There is no N+1:
  // the patrols query JOINs to patrol_routes + security_posts in a
  // single SQL; the checklists query JOINs to
  // patrol_checklist_bindings + checklist_templates in a single SQL; the
  // findings query is a single filtered scan.
  const [patrols, checklists, findings] = await Promise.all([
    securityDailyActivityRepository.listPatrols(buildingId, window, {
      securityPostId: filter.securityPostId,
    }),
    securityDailyActivityRepository.listChecklists(buildingId, window, {
      securityPostId: filter.securityPostId,
    }),
    filter.securityPostId
      ? Promise.resolve([] as SecurityDailyActivityFinding[])
      : securityDailyActivityRepository.listOpenFindings(buildingId),
  ]);

  // Resolve the BE-09-authoritative available_actions for each open
  // finding in a single parallel pass.
  const findingsWithActions: SecurityDailyActivityFinding[] = await Promise.all(
    findings.map(async (finding: SecurityDailyActivityFinding) => {
      try {
        const authority = await findingActionService.resolveAvailableActions(
          finding.id,
          { userId: actorUserId },
        );
        return { ...finding, availableActions: authority.availableActions };
      } catch {
        // Defensive: a finding whose workflow context cannot be resolved
        // (e.g. evidence missing) still surfaces — the empty action list
        // is a safe default that does not leak the failure to the caller.
        return { ...finding, availableActions: [] };
      }
    }),
  );

  // If the caller asked for a single post, narrow the findings list
  // (findings are post-agnostic today; the repository's `securityPostId`
  // filter already narrowed patrols and checklists).
  const finalFindings = filter.securityPostId ? [] : findingsWithActions;

  return {
    buildingId,
    operationalDate: date,
    shift,
    securityPost,
    summary: summarize(patrols, checklists, finalFindings),
    patrols,
    checklists,
    findings: finalFindings,
  };
}

function summarize(
  patrols: SecurityDailyActivityPatrol[],
  checklists: SecurityDailyActivityChecklist[],
  findings: SecurityDailyActivityFinding[],
): SecurityDailyActivitySummary {
  const summary: SecurityDailyActivitySummary = {
    scheduledPatrols: 0,
    inProgressPatrols: 0,
    completedPatrols: 0,
    cancelledPatrols: 0,
    openChecklists: 0,
    completedChecklists: 0,
    openFindings: 0,
  };
  for (const p of patrols) {
    if (p.status === 'OPEN' || p.status === 'ASSIGNED') {
      summary.scheduledPatrols += 1;
    } else if (p.status === 'IN_PROGRESS') {
      summary.inProgressPatrols += 1;
    } else if (p.status === 'COMPLETED') {
      summary.completedPatrols += 1;
    } else if (p.status === 'CANCELLED') {
      summary.cancelledPatrols += 1;
    }
  }
  for (const c of checklists) {
    if (c.status === 'DRAFT' || c.status === 'IN_PROGRESS') {
      summary.openChecklists += 1;
    } else if (c.status === 'COMPLETED') {
      summary.completedChecklists += 1;
    }
  }
  summary.openFindings = findings.length;
  return summary;
}

export const securityDailyActivityService = {
  getSecurityDailyActivity,
  operationalDateWindow,
};
