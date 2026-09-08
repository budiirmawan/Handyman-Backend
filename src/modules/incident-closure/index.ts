export {
  incidentAlreadyClosedError,
  incidentClosureNotAllowedError,
} from './incident-closure.errors';

export { incidentClosureRepository } from './incident-closure.repository';

export { createIncidentClosureRouter } from './incident-closure.routes';

export {
  evaluateClosureBlockers,
  isCloseable,
} from './incident-closure.rules';

export {
  closeIncident,
  getClosureStatus,
  incidentClosureService,
  listClosureStatuses,
  toClosureStatus,
} from './incident-closure.service';

export type {
  CloseIncidentInput,
  ClosureBlocker,
  ClosureBlockerCode,
  IncidentClosureFacts,
  IncidentClosureFilters,
  IncidentClosureStatus,
} from './incident-closure.types';

export {
  parseCloseIncidentBody,
  parseClosureFilters,
  parseIncidentIdParam,
} from './incident-closure.validation';
