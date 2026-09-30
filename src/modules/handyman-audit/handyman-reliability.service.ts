import { AppError } from '../../shared/errors';
import {
  executeIdempotent,
  type ExecuteIdempotentInput,
  type ExecuteIdempotentResult,
} from '../request-idempotency';
import { HANDYMAN_OPERATION_KEY_PATTERN } from './handyman-audit-contract';

/**
 * CR-HM-16 PART 03 — idempotency binding for this CR's future mutations
 * (governance `docs/handyman/CR-HM-16_START_GOVERNANCE.md` §7 seam 5, §9
 * PART 03 row: "idempotency/claim-before-send law for this CR's future
 * mutations").
 *
 * WHAT THIS OWNS
 * --------------
 * The fail-closed operation-key namespace (`hm.*`) under which future
 * Handyman mutations bind to the EXISTING `request-idempotency` service. The
 * identity/equivalence law (actor + operationKey + SHA-256 key, stable-JSON
 * request fingerprint, 409 on conflict, single-transaction atomicity) is
 * inherited verbatim from `executeIdempotent` — never restated here.
 *
 * WHAT THIS NEVER OWNS
 * --------------------
 * No second idempotency service, no claim store, no retry substrate. The
 * claim-before-send law for DUE WORK is likewise inherited: the single
 * `due-job-dispatcher` drains every domain under the guarded
 * `PENDING → CLAIMED` pattern already implemented by the reused families.
 */
export async function executeHandymanIdempotent(
  input: ExecuteIdempotentInput,
): Promise<ExecuteIdempotentResult> {
  if (typeof input.operationKey !== 'string' || !HANDYMAN_OPERATION_KEY_PATTERN.test(input.operationKey)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'operationKey',
        message: 'operationKey must be a Handyman operation key (hm.* namespace).',
      },
    ]);
  }
  return executeIdempotent(input);
}
