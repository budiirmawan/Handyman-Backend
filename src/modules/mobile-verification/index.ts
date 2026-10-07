export { mobileVerificationService } from './mobile-verification.service';
export type { SubmitVerificationInput } from './mobile-verification.service';
export {
  getMobileVerificationHandler,
  submitMobileVerificationHandler,
} from './mobile-verification.controller';
export { createMobileVerificationRouter } from './mobile-verification.routes';
export { MOBILE_VERIFICATION_TARGET_TYPES } from './mobile-verification.types';
export type {
  MobileVerificationContract,
  MobileVerificationResourceReference,
  MobileVerificationReviewer,
  MobileVerificationState,
  MobileVerificationTargetType,
} from './mobile-verification.types';
