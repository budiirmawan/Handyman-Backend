import {
  clientCurrencyAllowanceRepository,
  clientFxPolicyRepository,
  currencyMasterRepository,
  fxRateRepository,
} from './fx-rate.repository';
import type { FxRateGateway } from './fx-conversion.service';

/**
 * CR-BE-FX-01 PART 03 — production binding for the conversion authority's data
 * boundary.
 *
 * This file is the only place the conversion service touches the database, and
 * it holds no policy and no arithmetic: it forwards to the PART 01 repositories.
 * Keeping it separate from `fx-conversion.service.ts` leaves the resolution
 * order, the direct/inverse decision, the decimal arithmetic and the provenance
 * contract exercisable without a database, without creating a second conversion
 * authority.
 *
 * All reads are exact-match lookups against the PART 01 rate authority. There is
 * no fallback query, no widening of the effective-window predicate and no
 * ordering preference here — a nearest, latest, previous or future rate is never
 * produced by this layer.
 */
export const databaseFxRateGateway: FxRateGateway = {
  findActiveCurrency: (code) => currencyMasterRepository.findActive(code),

  findClientFxPolicy: (clientId) => clientFxPolicyRepository.findByClientId(clientId),

  findNotAllowedCurrencies: (clientId, codes) =>
    clientCurrencyAllowanceRepository.findNotAllowed(clientId, codes),

  findActiveCovering: (base, quote, at) => fxRateRepository.findAllActiveCovering(base, quote, at),

  countPairCoverage: (base, quote, at) => fxRateRepository.countPairCoverage(base, quote, at),
};
