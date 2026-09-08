import { vendorWorkforceRepository } from '../vendor-workforce';
import { workforceRepository } from '../workforce';
import { findingAssignmentRepository } from './finding-assignment.repository';

/**
 * Resolves whether a User is represented by the Finding's current responsible
 * party. This is assignment identity only; BE-09J owns final action/permission
 * policy binding.
 */
export async function isUserActiveFindingAssignee(
  findingId: string,
  userId: string,
): Promise<boolean> {
  const assignment = await findingAssignmentRepository.findActiveByFindingId(
    findingId,
  );
  if (!assignment) return false;

  const profile = await workforceRepository.findByUserId(userId);
  if (!profile || profile.status !== 'ACTIVE') return false;

  switch (assignment.assigneeType) {
    case 'WORKFORCE':
      return profile.id === assignment.workforceProfileId;
    case 'TEAM':
      return profile.teamId !== null && profile.teamId === assignment.teamId;
    case 'VENDOR':
      return assignment.vendorId !== null &&
        (await vendorWorkforceRepository.findActiveByVendorAndWorkforce(
          assignment.vendorId,
          profile.id,
        )) !== null;
    case 'VENDOR_WORKFORCE':
      return profile.id === assignment.workforceProfileId;
  }
}
