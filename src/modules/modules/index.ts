export {
  moduleCodeAlreadyExistsError,
  moduleInactiveError,
  moduleNotFoundError,
} from './module.errors';

export { moduleRepository } from './module.repository';

export {
  createModule,
  getModuleById,
  listModules,
  moduleService,
  toPublicModule,
  updateModuleStatus,
} from './module.service';

export {
  MODULE_STATUSES,
  isModuleStatus,
} from './module.types';

export {
  isValidModuleCode,
  normalizeModuleCode,
  parseCreateModuleBody,
  parseModuleIdParam,
  parseUpdateModuleStatusBody,
} from './module.validation';

export type {
  CreateModuleInput,
  ModuleRecord,
  ModuleStatus,
  NewModule,
  PublicModule,
  UpdateModuleStatusInput,
} from './module.types';

export type { ValidationDetail } from './module.validation';
