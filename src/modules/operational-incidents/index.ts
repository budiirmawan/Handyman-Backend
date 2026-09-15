export {
  operationalIncidentInvalidTransitionError,
  operationalIncidentNotFoundError,
  operationalIncidentOccurrenceInvalidError,
  operationalIncidentReporterInvalidError,
  operationalIncidentTypeMismatchError,
  operationalIncidentUpdateNotAllowedError,
} from './operational-incident.errors';

export { operationalIncidentRepository } from './operational-incident.repository';

export { createOperationalIncidentRouter } from './operational-incident.routes';

export {
  createOperationalIncident,
  getOperationalIncident,
  listOperationalIncidents,
  operationalIncidentService,
  toPublicOperationalIncident,
  updateOperationalIncident,
} from './operational-incident.service';

export {
  OPERATIONAL_INCIDENT_ACTIONS,
  OPERATIONAL_INCIDENT_CATEGORIES,
  OPERATIONAL_INCIDENT_STATUSES,
  OPERATIONAL_INCIDENT_TRANSITIONS,
  canTransitionOperationalIncidentStatus,
  isOperationalIncidentCategory,
  isOperationalIncidentStatus,
} from './operational-incident.types';

export type {
  CreateOperationalIncidentInput,
  NewOperationalIncident,
  OperationalIncidentAction,
  OperationalIncidentCategory,
  OperationalIncidentCompositeRecord,
  OperationalIncidentFilters,
  OperationalIncidentRecord,
  OperationalIncidentStatus,
  PublicOperationalIncident,
  UpdateOperationalIncidentInput,
} from './operational-incident.types';

export {
  parseCreateOperationalIncidentBody,
  parseOperationalIncidentFilters,
  parseOperationalIncidentIdParam,
  parseUpdateOperationalIncidentBody,
} from './operational-incident.validation';

export type { ValidationDetail } from './operational-incident.validation';
