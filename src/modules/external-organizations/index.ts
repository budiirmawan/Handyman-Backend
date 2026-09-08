/**
 * BE-03H — External Organization reference domain.
 *
 * Minimum external organization reference for the external workforce
 * affiliation. Deliberately NOT a Vendor module: no controller, no routes, no
 * service workflows, no validation surface — only the record shape and the
 * read repository the affiliation slice needs.
 */

export { externalOrganizationRepository } from './external-organization.repository';

export {
  EXTERNAL_ORGANIZATION_STATUSES,
  isExternalOrganizationStatus,
} from './external-organization.types';

export type {
  ExternalOrganizationRecord,
  ExternalOrganizationStatus,
} from './external-organization.types';
