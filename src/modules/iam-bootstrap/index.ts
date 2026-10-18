/**
 * CR-HM-IAM-BOOTSTRAP-01 — operator-only IAM bootstrap.
 *
 * DELIBERATELY NOT EXPORTED THROUGH THE HTTP APP. The only runtime entrypoint
 * is `src/database/cli.ts` (`bootstrap-owner` / `bootstrap-status`).
 */
export {
  CANONICAL_ROLE_DEFINITIONS,
  CANONICAL_ROLE_PERMISSION_CODES,
  CUSTOMER_CARE_ROLE,
  MANAGER_ROLE,
  MOBILE_STAFF_ROLE,
  OPERATIONS_ROLE,
  OWNER_ROLE_CODE,
  SYSTEM_ADMIN_ROLE,
} from './iam-canonical-roles';

export type { CanonicalRoleDefinition } from './iam-canonical-roles';

export {
  BootstrapError,
  bootstrapOwner,
  getOwnerBootstrapStatus,
} from './owner-bootstrap.service';

export type {
  BootstrapErrorCode,
  BootstrapOwnerInput,
  BootstrapOwnerResult,
  OwnerBootstrapStatus,
} from './owner-bootstrap.service';

export {
  InteractivePasswordError,
  promptForNewPassword,
  readSecretFromTerminal,
} from './password-prompt';

export {
  BOOTSTRAP_OWNER_USAGE,
  parseBootstrapOwnerArgs,
} from './owner-bootstrap.cli';

export type { BootstrapOwnerArgs } from './owner-bootstrap.cli';
