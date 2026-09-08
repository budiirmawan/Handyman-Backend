export {
  parseRecipientRule,
  recipientResolutionService,
  resolveRecipients,
  resolveRecipientsDetailed,
} from './recipient-resolution.service';
export {
  RECIPIENT_KINDS,
  isRecipientKind,
} from './recipient-resolution.types';
export type {
  RecipientKind,
  RecipientRule,
  RecipientScope,
  RecipientSpec,
  ResolvedRecipient,
} from './recipient-resolution.types';
