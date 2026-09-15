import {
  dailyCleaningNotFoundError,
  dailyCleaningRepository,
  operationalDateWindow,
  toPublicDailyCleaning,
  type DailyCleaningFilter,
  type PublicDailyCleaning,
} from '../daily-cleaning';
import { teamNotFoundError } from '../teams';
import { workforceBuildingAssignmentRepository } from '../workforce-building-assignments';
import { workforceProfileNotFoundError } from '../workforce';
import {
  cleaningAssignmentAssigneeInactiveError,
  cleaningAssignmentBuildingMismatchError,
  cleaningAssignmentClientMismatchError,
  cleaningAssignmentTaskTerminalError,
} from './cleaning-assignment.errors';
import {
  cleaningAssignmentRepository,
  type TeamLookupRow,
  type WorkforceLookupRow,
} from './cleaning-assignment.repository';
import type {
  CleaningAssignmentRecord,
  CreateCleaningAssignmentInput,
  PublicCleaningAssignment,
} from './cleaning-assignment.types';

export async function toPublicCleaningAssignment(
  record: CleaningAssignmentRecord,
): Promise<PublicCleaningAssignment> {
  let assignee: {
    type: 'WORKFORCE' | 'TEAM';
    id: string;
    code: string;
    name: string;
  } | null = null;

  if (record.assigneeType === 'WORKFORCE' && record.workforceProfileId) {
    const wf = await cleaningAssignmentRepository.findWorkforce(
      record.workforceProfileId,
    );
    if (wf) {
      assignee = {
        type: 'WORKFORCE',
        id: wf.id,
        code: wf.employee_code,
        name: wf.full_name,
      };
    }
  } else if (record.assigneeType === 'TEAM' && record.teamId) {
    const tm = await cleaningAssignmentRepository.findTeam(record.teamId);
    if (tm) {
      assignee = {
        type: 'TEAM',
        id: tm.id,
        code: tm.code,
        name: tm.name,
      };
    }
  }

  return {
    id: record.id,
    taskId: record.taskId,
    assigneeType: record.assigneeType,
    workforceProfileId: record.workforceProfileId,
    teamId: record.teamId,
    assignedByUserId: record.assignedByUserId,
    assignedAt: record.assignedAt.toISOString(),
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    assignee,
  };
}

export async function assignDailyCleaning(
  input: CreateCleaningAssignmentInput,
): Promise<PublicCleaningAssignment> {
  const task = await dailyCleaningRepository.findById(input.taskId);
  if (!task) {
    throw dailyCleaningNotFoundError();
  }

  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
    throw cleaningAssignmentTaskTerminalError();
  }

  if (input.assigneeType === 'WORKFORCE') {
    const wf = await cleaningAssignmentRepository.findWorkforce(
      input.workforceProfileId!,
    );
    if (!wf) {
      throw workforceProfileNotFoundError();
    }
    if (wf.status !== 'ACTIVE') {
      throw cleaningAssignmentAssigneeInactiveError();
    }
    if (wf.client_id !== task.client_id) {
      throw cleaningAssignmentClientMismatchError();
    }
    // STRAND-ADJ-01 FIX-02 — a WORKFORCE assignee must hold an ACTIVE BE-03G
    // placement at the task's own Building. Client membership alone never grants
    // a Building, which is what `workforceBuildingAssignmentRepository` exists to
    // decide; the same shared authority gates BE-08 work-order and finding
    // assignment, so this is the module's missing third step, not a new rule.
    // Runs BEFORE any deactivation/insert, so a refused assignment mutates
    // nothing. TEAM stays exempt: teams are organization groupings with no
    // Building binding, exactly as in those comparable flows.
    const placement =
      await workforceBuildingAssignmentRepository.findActiveByProfileAndBuilding(
        input.workforceProfileId!,
        task.building_id,
      );
    if (!placement) {
      throw cleaningAssignmentBuildingMismatchError();
    }
  } else if (input.assigneeType === 'TEAM') {
    const tm = await cleaningAssignmentRepository.findTeam(input.teamId!);
    if (!tm) {
      throw teamNotFoundError();
    }
    if (tm.status !== 'ACTIVE') {
      throw cleaningAssignmentAssigneeInactiveError();
    }
    if (tm.client_id !== task.client_id) {
      throw cleaningAssignmentClientMismatchError();
    }
  }

  await cleaningAssignmentRepository.deactivateActiveAssignments(input.taskId);

  const record = await cleaningAssignmentRepository.create({
    taskId: input.taskId,
    assigneeType: input.assigneeType,
    workforceProfileId: input.workforceProfileId ?? null,
    teamId: input.teamId ?? null,
    assignedByUserId: input.assignedByUserId,
  });

  if (task.status === 'OPEN') {
    await cleaningAssignmentRepository.updateTaskStatus(
      input.taskId,
      'ASSIGNED',
    );
  }

  return toPublicCleaningAssignment(record);
}

export async function listAssignmentsByTaskId(
  taskId: string,
): Promise<PublicCleaningAssignment[]> {
  const task = await dailyCleaningRepository.findById(taskId);
  if (!task) {
    throw dailyCleaningNotFoundError();
  }

  const records = await cleaningAssignmentRepository.listByTaskId(taskId);
  return Promise.all(records.map(toPublicCleaningAssignment));
}

export async function listDailyCleaningByWorkforce(
  workforceProfileId: string,
  filter: DailyCleaningFilter = {},
): Promise<PublicDailyCleaning[]> {
  const wf = await cleaningAssignmentRepository.findWorkforce(
    workforceProfileId,
  );
  if (!wf) {
    throw workforceProfileNotFoundError();
  }
  if (wf.status !== 'ACTIVE') {
    throw cleaningAssignmentAssigneeInactiveError();
  }

  const dateWindow = filter.date
    ? operationalDateWindow(filter.date)
    : undefined;

  const rows = await cleaningAssignmentRepository.listTasksByWorkforce(
    workforceProfileId,
    filter,
    dateWindow,
  );
  return rows.map(toPublicDailyCleaning);
}

export async function listDailyCleaningByTeam(
  teamId: string,
  filter: DailyCleaningFilter = {},
): Promise<PublicDailyCleaning[]> {
  const tm = await cleaningAssignmentRepository.findTeam(teamId);
  if (!tm) {
    throw teamNotFoundError();
  }
  if (tm.status !== 'ACTIVE') {
    throw cleaningAssignmentAssigneeInactiveError();
  }

  const dateWindow = filter.date
    ? operationalDateWindow(filter.date)
    : undefined;

  const rows = await cleaningAssignmentRepository.listTasksByTeam(
    teamId,
    filter,
    dateWindow,
  );
  return rows.map(toPublicDailyCleaning);
}

export const cleaningAssignmentService = {
  assignDailyCleaning,
  listAssignmentsByTaskId,
  listDailyCleaningByTeam,
  listDailyCleaningByWorkforce,
  toPublicCleaningAssignment,
};
