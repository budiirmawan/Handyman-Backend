/**
 * CR-BE-SAAS-01 PART 11 — Support Access module index.
 *
 * PART 11A exposes the domain surface only.
 * PART 11B adds the HTTP controller, validation, routes, and the
 * canonical runtime enforcement seam.
 *
 * Re-exports are kept narrow to discourage accidental cross-module
 * coupling. Each PART surface is exported in its own block.
 */
export {
  openSupportSession,
  revokeSupportSession,
  checkSupportSessionEffectiveness,
  SAAS_SUPPORT_SESSION_MAX_MINUTES,
} from './platform-support-session.service';

export {
  SUPPORT_ACCESS_STARTED,
  SUPPORT_ACCESS_ENDED,
  SUPPORT_SESSION_ENTITY_TYPE,
  type OpenSupportSessionInput,
  type PlatformSupportSessionRecord,
  type SupportSessionStorageStatus,
  type SupportSessionEffectiveStatus,
  type SupportSessionEffectiveness,
} from './platform-support-session.types';

export { platformSupportSessionRepository } from './platform-support-session.repository';

// PART 11B — HTTP + runtime guard.
export {
  openSupportSessionHandler,
  listSupportSessionsHandler,
  revokeSupportSessionHandler,
  type PlatformSupportSessionPublic,
} from './platform-support-session.controller';
export {
  createPlatformSupportRouter,
} from './platform-support-session.routes';
export {
  assertSupportContextEffectiveness,
  readSupportContextEffectiveness,
  SAAS_SUPPORT_SESSION_EXPIRED,
  SAAS_SUPPORT_SESSION_NOT_FOUND,
  type SupportContextParams,
  type EffectiveSupportContext,
} from './runtime-guard';
