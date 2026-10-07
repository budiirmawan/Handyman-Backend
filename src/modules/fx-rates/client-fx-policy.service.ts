import { withTransaction } from '../../database';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { contextAccessService } from '../context-access';
import { clientInactiveError, clientNotFoundError, clientRepository } from '../clients';
import { recordOperationalEvent } from '../operational-events';
import {
  fxPolicyReportingCurrencyNotBaseError,
} from './fx-rate.errors';
import { clientFxPolicyRepository } from './fx-rate.repository';
import { validateClientFxPolicyInput } from './fx-rate.validation';
import type { ClientFxPolicy, FxRateSource } from './fx-rate.types';

/**
 * CR-BE-FX-01 PART 02 — Client FX Policy command / read authority.
 *
 * GOVERNANCE: docs/CR-BE-FX-01_START_GOVERNANCE.md §6, §14.2, §15, §18.
 *
 * FAIL CLOSED on every axis:
 *   - no policy row            -> FX is unavailable for the Client;
 *   - `fxEnabled = false`      -> FX is unavailable;
 *   - empty `permittedSources` -> no rate source may be used, even if a rate exists.
 *
 * Absence is never treated as permission, and `getClientFxPolicy` reports the
 * absence honestly (`policy: null`) rather than synthesizing a default.
 *
 * NO SILENT INJECTION. The reporting currency must be stated explicitly by the
 * caller. It is then validated against the Client's `base_currency_code`; it is
 * never copied from the base, the default transaction currency, or anything
 * else. FX-01 does not add a second reporting axis.
 *
 * NO Building override: the policy is keyed on `client_id` alone.
 *
 * AUDIT: a Client FX policy HAS a real Client owner, so it uses the existing
 * Client-scoped `operational_events` architecture (`recordOperationalEvent`),
 * exactly like `CLIENT_MONETARY_CONTEXT_SET`. No parallel audit system is
 * created. The platform-global `fx_rate_events` ledger is for rate lifecycle
 * only and is not used here.
 */

export type SetClientFxPolicyInput = {
  clientId: string;
  fxEnabled: boolean;
  reportingCurrencyCode: string;
  permittedSources: FxRateSource[];
  inversePermitted: boolean;
  maxStalenessDays?: number | null;
};

export type ClientFxPolicyReadModel = {
  clientId: string;
  /** Null when no policy exists. Null means FX is unavailable — never a default. */
  policy: ClientFxPolicy | null;
  /** Resolved availability, so a caller cannot mistake absence for permission. */
  fxAvailable: boolean;
  /** The Client base currency, for display only. Never injected into a write. */
  baseCurrencyCode: string | null;
};

async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

export const clientFxPolicyService = {
  /**
   * Read a Client's FX policy. Respects Client reachability; a caller who cannot
   * reach the Client learns nothing about its policy.
   */
  async getClientFxPolicy(clientId: string, actorUserId: string): Promise<ClientFxPolicyReadModel> {
    await assertClientAccess(actorUserId, clientId);

    const [policy, baseCurrencyCode] = await Promise.all([
      clientFxPolicyRepository.findByClientId(clientId),
      readBaseCurrency(clientId),
    ]);

    return {
      clientId,
      policy,
      // Fail closed: only an existing, explicitly enabled policy with at least
      // one permitted source can ever support a conversion.
      fxAvailable: policy !== null && policy.fxEnabled && policy.permittedSources.length > 0,
      baseCurrencyCode,
    };
  },

  /**
   * Sets or replaces a Client's FX policy. One governed audit event is written in
   * the SAME transaction as the policy row.
   */
  async setClientFxPolicy(
    input: SetClientFxPolicyInput,
    actorUserId: string,
  ): Promise<ClientFxPolicy> {
    const client = await clientRepository.findById(input.clientId);
    if (!client) throw clientNotFoundError();
    if (client.status !== 'ACTIVE') throw clientInactiveError();
    await assertClientAccess(actorUserId, input.clientId);

    // Shape validation first, so a malformed payload never reaches the database.
    const policy = validateClientFxPolicyInput({ ...input, actorUserId });

    const previous = await clientFxPolicyRepository.findByClientId(input.clientId);
    const baseCurrencyCode = await readBaseCurrency(input.clientId);

    // NO injection: the caller must have named the base currency themselves.
    if (baseCurrencyCode !== null && policy.reportingCurrencyCode !== baseCurrencyCode) {
      throw fxPolicyReportingCurrencyNotBaseError(policy.reportingCurrencyCode);
    }

    return withTransaction(async (tx) => {
      const saved = await clientFxPolicyRepository.upsertWith(tx, { ...policy, actorUserId });

      await recordOperationalEvent(
        {
          clientId: saved.clientId,
          eventType: previous === null ? 'CLIENT_FX_POLICY_SET' : 'CLIENT_FX_POLICY_CHANGED',
          entityType: 'CLIENT_FX_POLICY',
          entityId: saved.clientId,
          actorUserId,
          summary:
            previous === null
              ? 'Client FX policy set.'
              : 'Client FX policy changed.',
          metadata: {
            fxEnabled: saved.fxEnabled,
            reportingCurrencyCode: saved.reportingCurrencyCode,
            permittedSources: saved.permittedSources,
            inversePermitted: saved.inversePermitted,
            maxStalenessDays: saved.maxStalenessDays,
            ...(previous
              ? {
                  previous: {
                    fxEnabled: previous.fxEnabled,
                    reportingCurrencyCode: previous.reportingCurrencyCode,
                    permittedSources: previous.permittedSources,
                    inversePermitted: previous.inversePermitted,
                    maxStalenessDays: previous.maxStalenessDays,
                  },
                }
              : {}),
          },
        },
        tx,
      );

      return saved;
    });
  },
};

/**
 * Reads the Client base currency for validation and display only. It is never
 * written into a policy without the caller having stated it explicitly.
 */
async function readBaseCurrency(clientId: string): Promise<string | null> {
  return clientFxPolicyRepository.findBaseCurrency(clientId);
}
