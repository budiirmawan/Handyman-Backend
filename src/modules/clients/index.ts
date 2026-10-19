export {
  clientAccessDeniedError,
  clientCodeAlreadyExistsError,
  clientInactiveError,
  clientNotFoundError,
} from './client.errors';

export { clientRepository } from './client.repository';
export type { ClientListQuery } from './client.repository';

export {
  clientService,
  countClients,
  createClient,
  getClientById,
  listClients,
  toPublicClient,
  updateClient,
} from './client.service';
export type { ListClientsOptions } from './client.service';

export {
  CLIENT_STATUSES,
  isClientInScope,
  isClientStatus,
  scopeToClientIds,
} from './client.types';

export {
  isValidClientCode,
  isValidUuid,
  normalizeClientCode,
  parseClientIdParam,
  parseClientListQuery,
  parseCreateClientBody,
  parseUpdateClientBody,
} from './client.validation';

export type { ParsedClientListQuery } from './client.validation';

export type {
  ClientListFilters,
  ClientReadScope,
  ClientRecord,
  ClientStatus,
  CreateClientInput,
  NewClient,
  PublicClient,
  UpdateClientInput,
} from './client.types';

export type { ValidationDetail } from './client.validation';
