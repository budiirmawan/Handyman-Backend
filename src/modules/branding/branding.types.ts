import type { ClientConfigurationStatus } from '../client-configurations';

export const BRANDING_FONT_FAMILIES = [
  'SYSTEM',
  'INTER',
  'ROBOTO',
  'OPEN_SANS',
  'LATO',
] as const;
export type BrandingFontFamily = (typeof BRANDING_FONT_FAMILIES)[number];

export const BRANDING_BORDER_RADII = ['NONE', 'SMALL', 'MEDIUM', 'LARGE'] as const;
export type BrandingBorderRadius = (typeof BRANDING_BORDER_RADII)[number];
export type BrandingScope = 'CLIENT' | 'BUILDING';
export type BrandingStatus = ClientConfigurationStatus;

export type LoginBranding = {
  title: string | null;
  subtitle: string | null;
  showLogo: boolean;
};

export type PortalBranding = {
  headerTitle: string | null;
  showLogo: boolean;
};

export type ReportBranding = {
  headerText: string | null;
  footerText: string | null;
  showLogo: boolean;
};

export type BrandingThemeTokens = {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  backgroundColor: string;
  surfaceColor: string;
  textColor: string;
  fontFamily: BrandingFontFamily;
  borderRadius: BrandingBorderRadius;
};

export type BrandingProfile = {
  brandName: string;
  logoReference: string | null;
  login: LoginBranding;
  portal: PortalBranding;
  report: ReportBranding;
  theme: BrandingThemeTokens;
};

export type PublicBrandingConfiguration = BrandingProfile & {
  id: string;
  clientId: string;
  buildingId: string | null;
  scopeType: BrandingScope;
  status: BrandingStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateBrandingInput = BrandingProfile & {
  status: BrandingStatus;
};

export type UpdateBrandingInput = {
  brandName?: string;
  logoReference?: string | null;
  login?: Partial<LoginBranding>;
  portal?: Partial<PortalBranding>;
  report?: Partial<ReportBranding>;
  theme?: Partial<BrandingThemeTokens>;
  status?: BrandingStatus;
};

export type EffectiveBranding = {
  clientId: string;
  buildingId: string | null;
  branding: BrandingProfile | null;
};
