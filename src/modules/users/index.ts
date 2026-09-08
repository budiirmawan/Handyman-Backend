export {
  invalidAccountStateError,
  userEmailAlreadyExistsError,
  userNotFoundError,
  userWhatsAppPhoneAlreadyExistsError,
} from './user.errors';

export {
  deactivateUser,
  reactivateUser,
  suspendUser,
  userLifecycleService,
} from './user-lifecycle.service';

export { toPublicUser } from './user.mapper';

export { userRepository } from './user.repository';

export {
  createUser,
  getUserById,
  normalizeDisplayName,
  normalizeEmail,
  updateUserWhatsAppContact,
  userService,
} from './user.service';

export {
  USER_STATUSES,
  USER_WHATSAPP_CONSENT_ACTIONS,
  isUserStatus,
  isUserWhatsAppConsentAction,
  isUserWhatsAppConsentActive,
  userStatusCanLogin,
} from './user.types';

export {
  isValidEmail,
  isValidUuid,
  parseCreateUserBody,
  parseUpdateUserWhatsAppContactBody,
  parseUserIdParam,
} from './user.validation';

export type {
  CreateUserInput,
  NewUser,
  PublicUser,
  UpdateUserWhatsAppContactInput,
  UserRecord,
  UserStatus,
  UserWhatsAppConsentAction,
} from './user.types';

export type { ValidationDetail } from './user.validation';
