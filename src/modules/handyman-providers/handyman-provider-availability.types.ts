import type { PublicHandymanProviderContext } from './handyman-provider-context.types';
import type { PublicHandymanWorkCrew } from './handyman-work-crew.types';

/**
 * CR-HM-17 GAP PART 02 (B4) — Handyman Provider Availability read projection
 * types.
 *
 * Read-only projection over existing CR-HM-04 (`handyman_provider_contexts`,
 * `handyman_worker_contexts`, `handyman_work_crews`,
 * `handyman_crew_memberships`, `handyman_crew_leads`, `workforce_profiles`),
 * CR-HM-04A (`handyman_execution_scope_assignments`), and CR-HM-08
 * (`handyman_work_sessions`) authorities.
 *
 * Returns only:
 *   - ACTIVE provider contexts
 *   - assignable ACTIVE crews
 *   - valid current login-capable Lead
 *   - active assignment / session occupancy facts
 *
 * Does not create any availability or lifecycle authority; no assignment
 * commands; no FM/SaaS fallback.
 */

export type ListHandymanProviderAvailabilityInput = {
  clientId?: string;
  executionScopeId?: string;
  providerContextId?: string;
};

/**
 * Validated current login-capable Lead projection for an assignable ACTIVE
 * crew (CR-HM-04 F4 + CR-HM-04A §1).
 */
export type HandymanAssignableCrewLeadProjection = {
  id: string;
  leadSeq: number;
  membershipId: string;
  workerContextId: string;
  workforceProfileId: string;
  userId: string;
  designatedByUserId: string;
  designatedAt: string;
};

/**
 * Active assignment & work-session occupancy facts for an assignable ACTIVE
 * crew (CR-HM-04A ACTIVE assignments + CR-HM-08 non-CHECKED_OUT work
 * sessions).
 */
export type HandymanCrewOccupancyProjection = {
  activeAssignmentCount: number;
  activeAssignmentIds: string[];
  activeExecutionScopeIds: string[];
  activeWorkSessionCount: number;
  activeWorkSessionIds: string[];
  hasActiveAssignment: boolean;
  hasActiveWorkSession: boolean;
};

/**
 * Assignable ACTIVE crew with its valid current login-capable Lead and
 * active assignment/session occupancy facts.
 */
export type PublicHandymanAssignableCrewAvailability =
  PublicHandymanWorkCrew & {
    lead: HandymanAssignableCrewLeadProjection;
    occupancy: HandymanCrewOccupancyProjection;
    activeAssignmentCount: number;
    activeWorkSessionCount: number;
    hasActiveAssignment: boolean;
    hasActiveWorkSession: boolean;
  };

/**
 * ACTIVE provider context with its assignable ACTIVE crews.
 */
export type PublicHandymanProviderAvailabilityItem =
  PublicHandymanProviderContext & {
    providerContext: PublicHandymanProviderContext;
    crews: PublicHandymanAssignableCrewAvailability[];
  };
