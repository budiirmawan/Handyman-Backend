export {
  clientCodeAlreadyExistsError,
  clientInactiveError,
  clientNotFoundError,
} from './client.errors';

export { clientRepository } from './client.repository';

export {
  clientService,
  createClient,
  getClientById,
  listClients,
  toPublicClient,
  updateClient,
} from './client.service';

export {
  CLIENT_STATUSES,
  isClientStatus,
} from './client.types';

export {
  isValidClientCode,
  isValidUuid,
  normalizeClientCode,
  parseClientIdParam,
  parseCreateClientBody,
  parseUpdateClientBody,
} from './client.validation';

export type {
  ClientRecord,
  ClientStatus,
  CreateClientInput,
  NewClient,
  PublicClient,
  UpdateClientInput,
} from './client.types';

export type { ValidationDetail } from './client.validation';
