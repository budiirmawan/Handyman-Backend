export {
  invalidAccountStateError,
  privilegedAccountResetDeniedError,
  userEmailAlreadyExistsError,
  userNotFoundError,
  userWhatsAppPhoneAlreadyExistsError,
} from './user.errors';

export {
  deactivateUser,
  reactivateUser,
  resetUserPassword,
  suspendUser,
  userLifecycleService,
} from './user-lifecycle.service';

export { toPublicUser } from './user.mapper';

export { userRepository } from './user.repository';

export {
  createUser,
  getUserById,
  listUsers,
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
  parseListUsersQuery,
  parsePasswordResetBody,
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
export type { UserPasswordResetResult } from './user-lifecycle.service';

export type {
  ListUsersQuery,
  ValidationDetail,
} from './user.validation';
