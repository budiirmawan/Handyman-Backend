export { appVersionService } from './app-version.service';
export { getAppVersionMetadataHandler } from './app-version.controller';
export { createAppVersionRouter } from './app-version.routes';
export { APP_VERSION_PLATFORMS } from './app-version.types';
export type {
  AppVersionPlatform,
  AppVersionRecord,
  MobileAppVersionMetadata,
} from './app-version.types';
