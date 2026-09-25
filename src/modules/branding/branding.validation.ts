import { AppError } from '../../shared/errors';
import {
  CLIENT_CONFIGURATION_STATUSES,
  isClientConfigurationStatus,
} from '../client-configurations';
import { isValidUuid } from '../clients';
import {
  BRANDING_BORDER_RADII,
  BRANDING_FONT_FAMILIES,
  type BrandingBorderRadius,
  type BrandingFontFamily,
  type BrandingStatus,
  type BrandingThemeTokens,
  type CreateBrandingInput,
  type LoginBranding,
  type PortalBranding,
  type ReportBranding,
  type UpdateBrandingInput,
} from './branding.types';

type Detail = { field: string; message: string };
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const STORAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const DEFAULT_THEME: BrandingThemeTokens = {
  primaryColor: '#1F6FEB',
  secondaryColor: '#475569',
  accentColor: '#0EA5E9',
  backgroundColor: '#FFFFFF',
  surfaceColor: '#F8FAFC',
  textColor: '#0F172A',
  fontFamily: 'SYSTEM',
  borderRadius: 'MEDIUM',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseUuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return normalized;
}
export const parseBrandingClientId = (value: string): string =>
  parseUuid(value, 'clientId');
export const parseBrandingBuildingId = (value: string): string =>
  parseUuid(value, 'buildingId');
export const parseBrandingId = (value: string): string =>
  parseUuid(value, 'brandingConfigurationId');

function safeText(
  value: unknown,
  field: string,
  max: number,
  details: Detail[],
  nullable: boolean,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string${nullable ? ' or null' : ''}.` });
    return undefined;
  }
  const text = value.trim();
  if (
    text.length < 1 ||
    text.length > max ||
    /[<>]/.test(text) ||
    UNSAFE_CONTROL.test(text)
  ) {
    details.push({
      field,
      message: `${field} must contain 1 to ${max} safe plain-text characters${nullable ? ', or be null' : ''}.`,
    });
    return undefined;
  }
  return text;
}

function logoReference(
  value: unknown,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field: 'logoReference', message: 'logoReference must be an opaque storage reference or null.' });
    return undefined;
  }
  const reference = value.trim();
  if (
    reference.length < 1 ||
    reference.length > 512 ||
    !STORAGE_REFERENCE.test(reference) ||
    reference.includes('..') ||
    reference.includes('//') ||
    reference.includes('\\')
  ) {
    details.push({
      field: 'logoReference',
      message:
        'logoReference must be an opaque backend-managed storage reference without a URL scheme or path traversal.',
    });
    return undefined;
  }
  return reference;
}

function booleanToken(
  value: unknown,
  field: string,
  details: Detail[],
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    details.push({ field, message: `${field} must be boolean.` });
    return undefined;
  }
  return value;
}

function objectFields(
  value: unknown,
  field: string,
  allowed: readonly string[],
  details: Detail[],
  partial: boolean,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    details.push({ field, message: `${field} must be a JSON object.` });
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      details.push({ field: `${field}.${key}`, message: `${key} is not allowed.` });
    }
  }
  if (partial && Object.keys(value).length === 0) {
    details.push({ field, message: `${field} must include at least one token.` });
  }
  return value;
}

function loginBranding(
  value: unknown,
  details: Detail[],
  partial: boolean,
): LoginBranding | Partial<LoginBranding> | undefined {
  const input = objectFields(
    value,
    'login',
    ['title', 'subtitle', 'showLogo'],
    details,
    partial,
  );
  if (!input) {
    return partial ? undefined : { title: null, subtitle: null, showLogo: true };
  }
  const result: Partial<LoginBranding> = {};
  const title = safeText(input.title, 'login.title', 160, details, true);
  const subtitle = safeText(input.subtitle, 'login.subtitle', 240, details, true);
  const showLogo = booleanToken(input.showLogo, 'login.showLogo', details);
  if (title !== undefined) result.title = title;
  if (subtitle !== undefined) result.subtitle = subtitle;
  if (showLogo !== undefined) result.showLogo = showLogo;
  if (partial) return result;
  return {
    title: result.title ?? null,
    subtitle: result.subtitle ?? null,
    showLogo: result.showLogo ?? true,
  };
}

function portalBranding(
  value: unknown,
  details: Detail[],
  partial: boolean,
): PortalBranding | Partial<PortalBranding> | undefined {
  const input = objectFields(
    value,
    'portal',
    ['headerTitle', 'showLogo'],
    details,
    partial,
  );
  if (!input) return partial ? undefined : { headerTitle: null, showLogo: true };
  const result: Partial<PortalBranding> = {};
  const headerTitle = safeText(
    input.headerTitle,
    'portal.headerTitle',
    160,
    details,
    true,
  );
  const showLogo = booleanToken(input.showLogo, 'portal.showLogo', details);
  if (headerTitle !== undefined) result.headerTitle = headerTitle;
  if (showLogo !== undefined) result.showLogo = showLogo;
  if (partial) return result;
  return {
    headerTitle: result.headerTitle ?? null,
    showLogo: result.showLogo ?? true,
  };
}

function reportBranding(
  value: unknown,
  details: Detail[],
  partial: boolean,
): ReportBranding | Partial<ReportBranding> | undefined {
  const input = objectFields(
    value,
    'report',
    ['headerText', 'footerText', 'showLogo'],
    details,
    partial,
  );
  if (!input) {
    return partial
      ? undefined
      : { headerText: null, footerText: null, showLogo: true };
  }
  const result: Partial<ReportBranding> = {};
  const headerText = safeText(
    input.headerText,
    'report.headerText',
    240,
    details,
    true,
  );
  const footerText = safeText(
    input.footerText,
    'report.footerText',
    500,
    details,
    true,
  );
  const showLogo = booleanToken(input.showLogo, 'report.showLogo', details);
  if (headerText !== undefined) result.headerText = headerText;
  if (footerText !== undefined) result.footerText = footerText;
  if (showLogo !== undefined) result.showLogo = showLogo;
  if (partial) return result;
  return {
    headerText: result.headerText ?? null,
    footerText: result.footerText ?? null,
    showLogo: result.showLogo ?? true,
  };
}

function colorToken(
  value: unknown,
  field: string,
  details: Detail[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !COLOR.test(value.trim())) {
    details.push({ field, message: `${field} must be a #RRGGBB color token.` });
    return undefined;
  }
  return value.trim().toUpperCase();
}

function themeTokens(
  value: unknown,
  details: Detail[],
  partial: boolean,
): BrandingThemeTokens | Partial<BrandingThemeTokens> | undefined {
  const colorKeys = [
    'primaryColor',
    'secondaryColor',
    'accentColor',
    'backgroundColor',
    'surfaceColor',
    'textColor',
  ] as const;
  const keys = [...colorKeys, 'fontFamily', 'borderRadius'] as const;
  const input = objectFields(value, 'theme', keys, details, partial);
  if (!input) return partial ? undefined : { ...DEFAULT_THEME };
  const result: Partial<BrandingThemeTokens> = {};
  for (const key of colorKeys) {
    const color = colorToken(input[key], `theme.${key}`, details);
    if (color !== undefined) result[key] = color;
  }
  if (input.fontFamily !== undefined) {
    const font =
      typeof input.fontFamily === 'string'
        ? input.fontFamily.trim().toUpperCase()
        : input.fontFamily;
    if (!(BRANDING_FONT_FAMILIES as readonly unknown[]).includes(font)) {
      details.push({
        field: 'theme.fontFamily',
        message: `fontFamily must be one of: ${BRANDING_FONT_FAMILIES.join(', ')}.`,
      });
    } else {
      result.fontFamily = font as BrandingFontFamily;
    }
  }
  if (input.borderRadius !== undefined) {
    const radius =
      typeof input.borderRadius === 'string'
        ? input.borderRadius.trim().toUpperCase()
        : input.borderRadius;
    if (!(BRANDING_BORDER_RADII as readonly unknown[]).includes(radius)) {
      details.push({
        field: 'theme.borderRadius',
        message: `borderRadius must be one of: ${BRANDING_BORDER_RADII.join(', ')}.`,
      });
    } else {
      result.borderRadius = radius as BrandingBorderRadius;
    }
  }
  if (partial) return result;
  return { ...DEFAULT_THEME, ...result };
}

function statusToken(
  value: unknown,
  details: Detail[],
): BrandingStatus | undefined {
  if (value === undefined) return undefined;
  if (!isClientConfigurationStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${CLIENT_CONFIGURATION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

export function parseCreateBrandingBody(body: unknown): CreateBrandingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: Detail[] = [];
  for (const field of Object.keys(body)) {
    if (
      ![
        'brandName',
        'logoReference',
        // PART 12A additive extension (frozen §5 row "Branding"):
        'supportName',
        'supportContact',
        'login',
        'portal',
        'report',
        'theme',
        'status',
      ].includes(field)
    ) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
  const brandName = safeText(body.brandName, 'brandName', 160, details, false);
  const logo = logoReference(body.logoReference, details) ?? null;
  // PART 12A additive extension. safeText with `nullable=true` accepts
  // explicit null; missing keys become null when stored (no-op for
  // pre-PART-12 profiles).
  const supportName = safeText(
    body.supportName,
    'supportName',
    160,
    details,
    true,
  );
  const supportContact = safeText(
    body.supportContact,
    'supportContact',
    160,
    details,
    true,
  );
  const login = loginBranding(body.login, details, false);
  const portal = portalBranding(body.portal, details, false);
  const report = reportBranding(body.report, details, false);
  const theme = themeTokens(body.theme, details, false);
  const status = statusToken(body.status, details) ?? 'ACTIVE';
  if (details.length > 0 || !brandName || !login || !portal || !report || !theme) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    brandName,
    logoReference: logo,
    supportName: supportName ?? null,
    supportContact: supportContact ?? null,
    login: login as LoginBranding,
    portal: portal as PortalBranding,
    report: report as ReportBranding,
    theme: theme as BrandingThemeTokens,
    status,
  };
}

export function parseUpdateBrandingBody(body: unknown): UpdateBrandingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: Detail[] = [];
  for (const field of Object.keys(body)) {
    if (
      ![
        'brandName',
        'logoReference',
        // PART 12A additive extension (frozen §5 row "Branding"):
        'supportName',
        'supportContact',
        'login',
        'portal',
        'report',
        'theme',
        'status',
      ].includes(field)
    ) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
  const brandName = safeText(body.brandName, 'brandName', 160, details, false);
  const logo = hasOwn(body, 'logoReference')
    ? logoReference(body.logoReference, details)
    : undefined;
  const supportName = hasOwn(body, 'supportName')
    ? safeText(body.supportName, 'supportName', 160, details, true)
    : undefined;
  const supportContact = hasOwn(body, 'supportContact')
    ? safeText(body.supportContact, 'supportContact', 160, details, true)
    : undefined;
  const login = loginBranding(body.login, details, true);
  const portal = portalBranding(body.portal, details, true);
  const report = reportBranding(body.report, details, true);
  const theme = themeTokens(body.theme, details, true);
  const status = statusToken(body.status, details);
  if (Object.keys(body).length === 0) {
    details.push({ field: 'body', message: 'At least one field is required.' });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    ...(typeof brandName === 'string' ? { brandName } : {}),
    ...(logo === undefined ? {} : { logoReference: logo }),
    ...(supportName === undefined ? {} : { supportName }),
    ...(supportContact === undefined ? {} : { supportContact }),
    ...(login === undefined ? {} : { login }),
    ...(portal === undefined ? {} : { portal }),
    ...(report === undefined ? {} : { report }),
    ...(theme === undefined ? {} : { theme }),
    ...(status === undefined ? {} : { status }),
  };
}
