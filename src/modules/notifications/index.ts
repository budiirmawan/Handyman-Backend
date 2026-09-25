export {
  notificationNotFoundError,
} from './notification.errors';
export { notificationRepository } from './notification.repository';
export {
  notificationService,
  recordNotification,
  toPublicNotification,
} from './notification.service';
export { createNotificationRouter } from './notification.routes';
export {
  getNotificationHandler,
  getNotificationNavigationTargetHandler,
  listNotificationsHandler,
  markNotificationReadHandler,
} from './notification.controller';
// CR-BE-RN21-NOTIFICATION-NAV-01 — backend-owned navigation target resolution.
export {
  NOTIFICATION_NAVIGATION_DESTINATIONS,
  notificationNavigationService,
  resolveNotificationNavigationTarget,
} from './notification-navigation.service';
export type {
  NotificationNavigationDestination,
  NotificationNavigationResolution,
  NotificationNavigationTargetResult,
} from './notification-navigation.service';
export {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_NAVIGATION_TARGET_TYPES,
  NOTIFICATION_STATUSES,
  isNotificationChannel,
  isNotificationNavigationTargetType,
  isNotificationStatus,
} from './notification.types';
export type {
  NewNotification,
  NotificationChannel,
  NotificationFilters,
  NotificationNavigationTargetType,
  NotificationRecord,
  NotificationStatus,
  PublicNotification,
  PublicNotificationNavigationTarget,
} from './notification.types';
