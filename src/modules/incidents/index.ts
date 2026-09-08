export {
  incidentBuildingInactiveError,
  incidentCancelNotAllowedError,
  incidentLocationInactiveError,
  incidentLocationMismatchError,
  incidentNotFoundError,
  incidentNumberAlreadyExistsError,
  incidentUpdateNotAllowedError,
} from './incident.errors';

export { incidentRepository } from './incident.repository';

export { createIncidentRouter } from './incident.routes';

export {
  cancelIncident,
  createIncident,
  getIncident,
  incidentService,
  isIncidentNumberUniqueViolation,
  listIncidents,
  resolveBuildingContext,
  resolveLocation,
  toPublicIncident,
  updateIncident,
} from './incident.service';

export type { ResolvedLocation } from './incident.service';

export {
  INCIDENT_LOCATION_TYPES,
  INCIDENT_PRIORITIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  isIncidentLocationType,
  isIncidentPriority,
  isIncidentSeverity,
  isIncidentStatus,
  isIncidentType,
} from './incident.types';

export type {
  CreateIncidentInput,
  IncidentFilters,
  IncidentLocationType,
  IncidentPriority,
  IncidentRecord,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  NewIncident,
  PublicIncident,
  UpdateIncidentInput,
} from './incident.types';

export {
  ISO_TIMESTAMP_WITH_ZONE,
  failValidation,
  isRecord,
  readEnum,
  readIncidentPriorityField,
  readIncidentSeverityField,
  readNullableText,
  readNullableUuid,
  readText,
  readTimestamp,
  readUuid,
  rejectForbiddenFields,
} from './incident-field.validation';

export {
  isValidIncidentNumber,
  normalizeIncidentNumber,
  parseCreateIncidentBody,
  parseIncidentFilters,
  parseIncidentIdParam,
  parseUpdateIncidentBody,
} from './incident.validation';

export type { ValidationDetail } from './incident.validation';
