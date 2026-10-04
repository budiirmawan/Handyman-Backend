/**
 * CR-HM-17 P1 FIX02 — B5 BAST availableActions read projection.
 *
 * Derives Customer Care actions from the frozen CR-HM-11 lifecycle
 * and tenant_company.manage authority. Zero new lifecycle rules.
 * Commands remain in existing authority.
 *
 * Customer Care (BM Super App) can ACCEPT or REJECT a BAST when
 * its status is ISSUED. No actions in any other status.
 */

import type { HandymanBastStatus } from './handyman-bast.types';

/**
 * BAST customer sign-off actions available to Customer Care.
 * Derived solely from status; authorization (canAccessClient,
 * tenant_company.manage) is the caller's wall.
 */
export type HandymanBastAvailableAction = 'ACCEPT' | 'REJECT';

export function computeBastAvailableActions(
  status: HandymanBastStatus,
): readonly HandymanBastAvailableAction[] {
  if (status === 'ISSUED') {
    return ['ACCEPT', 'REJECT'] as const;
  }
  return [] as const;
}
