/**
 * BE-25N — Mobile My Team Contract types.
 *
 * A self-service effective-context read: the authenticated user's own team
 * and its ACTIVE members, resolved authoritatively from the linked BE-03C
 * Workforce Profile (`workforce_profiles.team_id`) and the BE-03B Team
 * hierarchy (Team → Department → Organization → Client). No Team CRUD
 * surface and no caller-supplied identity — the caller's profile is resolved
 * from the authenticated session, never accepted from the request.
 */

/** Minimal authoritative reference to a hierarchy node. */
export type MobileTeamRef = {
  id: string;
  code: string;
  name: string;
};

/** The caller's team with its authoritative org hierarchy resolved. */
export type MobileMyTeam = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  department: MobileTeamRef;
  organization: MobileTeamRef;
  client: MobileTeamRef;
};

/** One ACTIVE workforce profile in the caller's team. */
export type MobileTeamMember = {
  /** `workforce_profiles.id` — the authoritative profile id. */
  id: string;
  employeeCode: string;
  fullName: string;
  workforceType: string;
  /** Always `ACTIVE` here — inactive profiles are filtered out. */
  status: string;
  /** `positions.id` — the authoritative position id. */
  positionId: string;
  /** `users.id` when a User account is linked; null otherwise. */
  userId: string | null;
};

export type MobileMyTeamContext = {
  /** The caller's linked, ACTIVE Workforce Profile (session-derived). */
  workforceProfile: {
    id: string;
    employeeCode: string;
    fullName: string;
  } | null;
  /** The caller's team; null when the caller has no linked profile or no team. */
  team: MobileMyTeam | null;
  /** ACTIVE workforce profiles in that team (includes the caller). */
  members: MobileTeamMember[];
};
