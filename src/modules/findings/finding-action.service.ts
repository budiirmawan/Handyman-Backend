import { resolveFindingActionAuthority } from './finding-action.authority';
import {
  FINDING_ACTIONS,
  type FindingAvailableActions,
} from './finding-action.types';

/** Backend-authoritative deterministic available-action resolution. */
export async function resolveAvailableActions(
  findingId: string,
  userContext: { userId: string },
): Promise<FindingAvailableActions> {
  const authority = await resolveFindingActionAuthority(
    findingId,
    userContext.userId,
  );
  return {
    findingId: authority.findingId,
    state: authority.state,
    availableActions: FINDING_ACTIONS.filter(authority.isAllowed),
  };
}

export const findingActionService = { resolveAvailableActions };
