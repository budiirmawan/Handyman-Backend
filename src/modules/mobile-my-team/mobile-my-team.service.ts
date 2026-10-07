import { clientRepository } from '../clients';
import { contextAccessService } from '../context-access';
import { departmentRepository } from '../departments/department.repository';
import { organizationRepository } from '../organizations/organization.repository';
import { teamRepository } from '../teams/team.repository';
import { workforceRepository } from '../workforce/workforce.repository';
import type {
  MobileMyTeam,
  MobileMyTeamContext,
  MobileTeamMember,
} from './mobile-my-team.types';

/**
 * BE-25N — Mobile My Team service.
 *
 * Derives the authenticated user's own team and its ACTIVE members from the
 * existing authorities only:
 *
 *   authenticated user  → `workforce_profiles.user_id` (BE-03C, unique)
 *   team membership     → `workforce_profiles.team_id` (BE-03C)
 *   team hierarchy      → `teams` → `departments` → `organizations` → `clients`
 *   building assignment → not used for membership (a Team is a Client-scoped
 *                         org construct, not a Building construct); the
 *                         caller's accessible Client set is still asserted so
 *                         no cross-Client org data is ever exposed
 *
 * Identity is never accepted from the caller — `userId` comes from the
 * authenticated session. Only the caller's own team is returned (the team
 * their linked profile belongs to); Team CRUD stays on the BE-03B
 * administration surface and is deliberately not exposed here.
 */

export async function resolveMyTeamContext(
  userId: string,
): Promise<MobileMyTeamContext> {
  const profile = await workforceRepository.findByUserId(userId);
  if (!profile || profile.status !== 'ACTIVE') {
    return { workforceProfile: null, team: null, members: [] };
  }

  const workforceProfile = {
    id: profile.id,
    employeeCode: profile.employeeCode,
    fullName: profile.fullName,
  };

  // The team hierarchy is exposed only when its Client is inside the caller's
  // accessible scope (same authority `/auth/me` uses for workforce identity).
  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  const accessibleClientIds =
    await contextAccessService.getAccessibleClientIds(userId);
  if (
    !organization ||
    !accessibleClientIds.includes(organization.clientId)
  ) {
    return { workforceProfile, team: null, members: [] };
  }

  if (!profile.teamId) {
    return { workforceProfile, team: null, members: [] };
  }

  const team = await teamRepository.findById(profile.teamId);
  if (!team) {
    return { workforceProfile, team: null, members: [] };
  }

  const [department, client, roster] = await Promise.all([
    departmentRepository.findById(team.departmentId),
    clientRepository.findById(organization.clientId),
    workforceRepository.listByTeamId(team.id),
  ]);

  // The full authoritative hierarchy must resolve before the team is exposed
  // (no partial fabrication). Missing rows here are data-integrity faults the
  // FKs should prevent; the safe answer is an empty context.
  if (!department || !client) {
    return { workforceProfile, team: null, members: [] };
  }

  const teamNode: MobileMyTeam = {
    id: team.id,
    code: team.code,
    name: team.name,
    description: team.description,
    status: team.status,
    department: {
      id: department.id,
      code: department.code,
      name: department.name,
    },
    organization: {
      id: organization.id,
      code: organization.code,
      name: organization.name,
    },
    client: {
      id: client.id,
      code: client.code,
      name: client.name,
    },
  };

  const members: MobileTeamMember[] = roster
    .filter((member) => member.status === 'ACTIVE')
    .map((member) => ({
      id: member.id,
      employeeCode: member.employeeCode,
      fullName: member.fullName,
      workforceType: member.workforceType,
      status: member.status,
      positionId: member.positionId,
      userId: member.userId,
    }));

  return { workforceProfile, team: teamNode, members };
}

export const mobileMyTeamService = { resolveMyTeamContext };
