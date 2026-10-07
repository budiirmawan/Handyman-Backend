import { departmentRepository } from '../departments';
import { findingNotFoundError, findingNotOpenError, findingRepository } from '../findings';
import { recordFindingEvent } from '../finding-history/finding-history.service';
import { organizationRepository } from '../organizations';
import { teamInactiveError, teamNotFoundError, teamRepository } from '../teams';
import { vendorBuildingRepository } from '../vendor-buildings';
import { vendorWorkforceRepository } from '../vendor-workforce';
import { vendorInactiveError, vendorNotFoundError, vendorRepository } from '../vendors';
import { workforceBuildingAssignmentRepository } from '../workforce-building-assignments';
import { workforceProfileInactiveError, workforceProfileNotFoundError, workforceRepository } from '../workforce';
import {
  findingAssignmentAlreadyAssignedError,
  findingAssignmentBuildingMismatchError,
  findingAssignmentClientMismatchError,
  findingAssignmentNotFoundError,
  findingAssignmentVendorWorkforceMismatchError,
} from './finding-assignment.errors';
import { findingAssignmentRepository } from './finding-assignment.repository';
import type {
  AssignFindingInput,
  FindingAssignmentRecord,
  NewFindingAssignment,
  PublicFindingAssignment,
} from './finding-assignment.types';

type FindingContext = { id: string; clientId: string; buildingId: string };

export function toPublicFindingAssignment(row: FindingAssignmentRecord): PublicFindingAssignment {
  return {
    ...row,
    assignedAt: row.assignedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadFinding(findingId: string): Promise<FindingContext> {
  const finding = await findingRepository.findById(findingId);
  if (!finding) throw findingNotFoundError();
  return { id: finding.id, clientId: finding.clientId, buildingId: finding.buildingId };
}
async function loadOpenFinding(findingId: string): Promise<FindingContext> {
  const finding = await findingRepository.findById(findingId);
  if (!finding) throw findingNotFoundError();
  if (finding.status !== 'OPEN') throw findingNotOpenError();
  return { id: finding.id, clientId: finding.clientId, buildingId: finding.buildingId };
}
async function workforceClient(workforceProfileId: string): Promise<string> {
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile) throw workforceProfileNotFoundError();
  const organization = await organizationRepository.findById(profile.organizationId);
  if (!organization) throw workforceProfileNotFoundError();
  return organization.clientId;
}
async function teamClient(teamId: string): Promise<string> {
  const team = await teamRepository.findById(teamId);
  if (!team) throw teamNotFoundError();
  const department = await departmentRepository.findById(team.departmentId);
  if (!department) throw teamNotFoundError();
  const organization = await organizationRepository.findById(department.organizationId);
  if (!organization) throw teamNotFoundError();
  return organization.clientId;
}

async function validateWorkforce(context: FindingContext, id: string): Promise<void> {
  const profile = await workforceRepository.findById(id);
  if (!profile) throw workforceProfileNotFoundError();
  if (profile.status !== 'ACTIVE') throw workforceProfileInactiveError();
  if (await workforceClient(id) !== context.clientId) throw findingAssignmentClientMismatchError();
  if (!(await workforceBuildingAssignmentRepository.findActiveByProfileAndBuilding(id, context.buildingId))) {
    throw findingAssignmentBuildingMismatchError();
  }
}
async function validateTeam(context: FindingContext, id: string): Promise<void> {
  const team = await teamRepository.findById(id);
  if (!team) throw teamNotFoundError();
  if (team.status !== 'ACTIVE') throw teamInactiveError();
  if (await teamClient(id) !== context.clientId) throw findingAssignmentClientMismatchError();
}
async function validateVendor(context: FindingContext, id: string): Promise<void> {
  const vendor = await vendorRepository.findById(id);
  if (!vendor) throw vendorNotFoundError();
  if (vendor.status !== 'ACTIVE') throw vendorInactiveError();
  if (vendor.clientId !== context.clientId) throw findingAssignmentClientMismatchError();
  if (!(await vendorBuildingRepository.findActiveByVendorAndBuilding(id, context.buildingId))) {
    throw findingAssignmentBuildingMismatchError();
  }
}
async function validateVendorWorkforce(
  context: FindingContext,
  vendorId: string,
  workforceProfileId: string,
): Promise<void> {
  await validateVendor(context, vendorId);
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile) throw workforceProfileNotFoundError();
  if (profile.status !== 'ACTIVE') throw workforceProfileInactiveError();
  if (await workforceClient(workforceProfileId) !== context.clientId) {
    throw findingAssignmentClientMismatchError();
  }
  if (!(await vendorWorkforceRepository.findActiveByVendorAndWorkforce(vendorId, workforceProfileId))) {
    throw findingAssignmentVendorWorkforceMismatchError();
  }
}
function required(value: string | undefined): string {
  if (!value) throw findingAssignmentVendorWorkforceMismatchError();
  return value;
}
async function resolveAssignee(
  context: FindingContext,
  input: AssignFindingInput,
): Promise<NewFindingAssignment> {
  const base = { findingId: context.id, assignedByUserId: input.assignedByUserId };
  switch (input.assigneeType) {
    case 'WORKFORCE': {
      const id = required(input.workforceProfileId); await validateWorkforce(context, id);
      return { ...base, assigneeType: input.assigneeType, workforceProfileId: id, teamId: null, vendorId: null };
    }
    case 'TEAM': {
      const id = required(input.teamId); await validateTeam(context, id);
      return { ...base, assigneeType: input.assigneeType, workforceProfileId: null, teamId: id, vendorId: null };
    }
    case 'VENDOR': {
      const id = required(input.vendorId); await validateVendor(context, id);
      return { ...base, assigneeType: input.assigneeType, workforceProfileId: null, teamId: null, vendorId: id };
    }
    case 'VENDOR_WORKFORCE': {
      const vendorId = required(input.vendorId), workforceId = required(input.workforceProfileId);
      await validateVendorWorkforce(context, vendorId, workforceId);
      return { ...base, assigneeType: input.assigneeType, workforceProfileId: workforceId, teamId: null, vendorId };
    }
  }
}

export async function assignFinding(input: AssignFindingInput): Promise<PublicFindingAssignment> {
  const context = await loadOpenFinding(input.findingId);
  if (await findingAssignmentRepository.findActiveByFindingId(context.id)) {
    throw findingAssignmentAlreadyAssignedError();
  }
  const assignment = await resolveAssignee(context, input);
  try {
    const record = await findingAssignmentRepository.create(assignment);
    await recordFindingEvent({
      findingId: context.id,
      clientId: context.clientId,
      buildingId: context.buildingId,
      eventType: 'FINDING_ASSIGNED',
      actorUserId: input.assignedByUserId,
      summary: `Finding assigned to ${input.assigneeType}`,
      metadata: assignmentMetadata(record),
    });
    return toPublicFindingAssignment(record);
  } catch (error) {
    if (isUnique(error)) throw findingAssignmentAlreadyAssignedError();
    throw error;
  }
}
export async function getCurrentFindingAssignment(findingId: string): Promise<PublicFindingAssignment | null> {
  await loadFinding(findingId);
  const row = await findingAssignmentRepository.findActiveByFindingId(findingId);
  return row ? toPublicFindingAssignment(row) : null;
}
export async function listFindingAssignments(findingId: string): Promise<PublicFindingAssignment[]> {
  await loadFinding(findingId);
  return (await findingAssignmentRepository.listByFindingId(findingId)).map(toPublicFindingAssignment);
}
export async function deactivateFindingAssignment(
  findingId: string,
  assignmentId: string,
  actorUserId?: string,
): Promise<PublicFindingAssignment> {
  const context = await loadOpenFinding(findingId);
  const row = await findingAssignmentRepository.findById(assignmentId);
  if (!row || row.findingId !== findingId) throw findingAssignmentNotFoundError();
  const updated = await findingAssignmentRepository.updateStatus(assignmentId, 'INACTIVE');
  await recordFindingEvent({
    findingId: context.id,
    clientId: context.clientId,
    buildingId: context.buildingId,
    eventType: 'FINDING_ASSIGNMENT_DEACTIVATED',
    actorUserId,
    summary: 'Finding assignment deactivated',
    metadata: { assignmentId: row.id, assigneeType: row.assigneeType },
  });
  return toPublicFindingAssignment(updated as FindingAssignmentRecord);
}
export async function reassignFinding(
  findingId: string,
  assignmentId: string,
  input: AssignFindingInput,
): Promise<PublicFindingAssignment> {
  const context = await loadOpenFinding(findingId);
  const target = await findingAssignmentRepository.findById(assignmentId);
  if (!target || target.findingId !== findingId) throw findingAssignmentNotFoundError();
  const resolved = await resolveAssignee(context, { ...input, findingId });
  try {
    const record = await findingAssignmentRepository.replaceActive(resolved);
    await recordFindingEvent({
      findingId: context.id,
      clientId: context.clientId,
      buildingId: context.buildingId,
      eventType: 'FINDING_REASSIGNED',
      actorUserId: input.assignedByUserId,
      summary: `Finding reassigned to ${input.assigneeType}`,
      metadata: {
        previousAssignmentId: target.id,
        ...assignmentMetadata(record),
      },
    });
    return toPublicFindingAssignment(record);
  } catch (error) {
    if (isUnique(error)) throw findingAssignmentAlreadyAssignedError();
    throw error;
  }
}
function assignmentMetadata(record: FindingAssignmentRecord) {
  return {
    assignmentId: record.id,
    assigneeType: record.assigneeType,
    workforceProfileId: record.workforceProfileId,
    teamId: record.teamId,
    vendorId: record.vendorId,
  };
}
function isUnique(error: unknown): boolean {
  const value = error as { code?: string; constraint?: string } | null;
  return value?.code === '23505' && value.constraint === 'finding_active_assignment_unique';
}
export const findingAssignmentService = {
  assignFinding,
  deactivateFindingAssignment,
  getCurrentFindingAssignment,
  listFindingAssignments,
  reassignFinding,
  toPublicFindingAssignment,
};
