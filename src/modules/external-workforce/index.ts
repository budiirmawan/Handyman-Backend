/**
 * BE-03H — External / Vendor Workforce affiliation domain.
 *
 * Links an EXTERNAL Workforce Profile (BE-03C) to an External Organization
 * reference (BE-03H) — the vendor context of externally supplied personnel.
 * No credentials, Role, Permission, or Building access are ever created by
 * this slice.
 */

export {
  externalOrganizationInactiveError,
  externalOrganizationNotFoundError,
  externalPersonnelCodeAlreadyExistsError,
  externalWorkforceAlreadyAffiliatedError,
  externalWorkforceClientMismatchError,
  externalWorkforceLinkNotFoundError,
  workforceNotExternalError,
} from './external-workforce.errors';

export { externalWorkforceRepository } from './external-workforce.repository';

export {
  createExternalWorkforceLink,
  deactivateExternalWorkforceLink,
  externalWorkforceService,
  getExternalWorkforceLink,
  listExternalOrganizationWorkforce,
  listWorkforceAffiliations,
  toPublicExternalWorkforceLink,
  updateExternalWorkforceLink,
} from './external-workforce.service';

export {
  EXTERNAL_WORKFORCE_LINK_STATUSES,
  isExternalWorkforceLinkStatus,
} from './external-workforce.types';

export {
  isValidExternalPersonnelCode,
  normalizeExternalPersonnelCode,
  parseCreateExternalWorkforceLinkBody,
  parseExternalOrganizationIdParam,
  parseUpdateExternalWorkforceLinkBody,
  parseWorkforceProfileIdParam,
} from './external-workforce.validation';

export { createExternalWorkforceRouter } from './external-workforce.routes';

export type {
  CreateExternalWorkforceLinkBody,
  UpdateExternalWorkforceLinkBody,
  ValidationDetail,
} from './external-workforce.validation';

export type {
  CreateExternalWorkforceLinkInput,
  ExternalWorkforceLinkRecord,
  ExternalWorkforceLinkStatus,
  NewExternalWorkforceLink,
  PublicExternalWorkforceLink,
  UpdateExternalWorkforceLinkInput,
} from './external-workforce.types';
