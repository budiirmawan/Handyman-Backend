export {
  authRateLimitedError,
  authenticationRequiredError,
  invalidCredentialsError,
  permissionDeniedError,
} from './auth.errors';

export {
  clearLoginRateLimits,
  isLoginRateLimited,
  recordLoginFailure,
  recordLoginSuccess,
} from './login-rate-limit';

export {
  effectiveContextService,
  getEffectiveUserContext,
} from './effective-context.service';

export type {
  EffectiveAccess,
  EffectiveBuildingContext,
  EffectiveClientContext,
  EffectiveEntitlement,
  EffectivePropertyContext,
  EffectiveRole,
  EffectiveUserContext,
} from './effective-context.types';

export { requirePermission } from './rbac.middleware';

export {
  authService,
  changePassword,
  getPasswordStatus,
  login,
} from './auth.service';
export type {
  ChangePasswordInput,
  LoginInput,
  PasswordStatus,
} from './auth.service';
export {
  PASSWORD_CHANGE_ALLOWED_OPERATIONS,
  enforcePasswordChange,
  isPasswordChangeAllowed,
} from './password-change.middleware';

export {
  parseChangePasswordBody,
  parseLoginBody,
} from './auth.validation';
export type {
  ChangePasswordBody,
  LoginBody,
} from './auth.validation';

export {
  credentialAlreadyExistsError,
  credentialNotFoundError,
  invalidPasswordError,
  passwordPolicyViolationError,
} from './credential.errors';

export { credentialRepository } from './credential.repository';

export {
  changeOwnPassword,
  createInitialCredential,
  credentialService,
  getCredentialByUserId,
  resetPassword,
  updatePassword,
  verifyPasswordForUser,
} from './credential.service';

export {
  PASSWORD_BCRYPT_ROUNDS,
  PASSWORD_POLICY,
  hashPassword,
  passwordService,
  validatePassword,
  verifyPassword,
} from './password.service';

export {
  invalidSessionError,
  sessionExpiredError,
} from './session.errors';

export { sessionRepository } from './session.repository';

export {
  createSessionForUser,
  resolveSessionContext,
  revokeActiveSessionsForUser,
  revokeOtherSessionsForUser,
  revokeSessionById,
  sessionService,
} from './session.service';

export { generateSessionToken, hashSessionToken } from './session.token';

export { SESSION_STATUSES } from './session.types';

export type {
  CredentialRecord,
  CreateCredentialInput,
  UpdatePasswordInput,
} from './credential.types';

export type { PasswordPolicyDetail } from './password.service';

export type {
  AuthContext,
  CreateSessionInput,
  SessionRecord,
  SessionResult,
  SessionStatus,
} from './session.types';
