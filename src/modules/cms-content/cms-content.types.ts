export const CMS_CONTENT_TYPES = [
  'ANNOUNCEMENT',
  'HELP',
  'FAQ',
  'KNOWLEDGE',
  'PORTAL_CONTENT',
  'RELEASE_INFORMATION',
] as const;
export type CmsContentType = (typeof CMS_CONTENT_TYPES)[number];

export const CMS_CONTENT_STATUSES = ['DRAFT', 'PUBLISHED', 'INACTIVE'] as const;
export type CmsContentStatus = (typeof CMS_CONTENT_STATUSES)[number];
export type CmsContentScope = 'CLIENT' | 'BUILDING';

export type CmsContentRecord = {
  id: string;
  clientId: string;
  buildingId: string | null;
  scopeType: CmsContentScope;
  contentType: CmsContentType;
  slug: string;
  title: string;
  body: string;
  status: CmsContentStatus;
  createdByUserId: string;
  publishedAt: Date | null;
  publishedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicCmsContent = Omit<
  CmsContentRecord,
  'publishedAt' | 'createdAt' | 'updatedAt'
> & {
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateCmsContentInput = {
  contentType: CmsContentType;
  slug: string;
  title: string;
  body: string;
  status: CmsContentStatus;
};

export type NewCmsContent = CreateCmsContentInput & {
  scopeType: CmsContentScope;
  clientId: string | null;
  buildingId: string | null;
  createdByUserId: string;
  publishedAt: Date | null;
  publishedByUserId: string | null;
};

export type UpdateCmsContentInput = {
  title?: string;
  body?: string;
  status?: CmsContentStatus;
};

export type CmsContentFilters = {
  contentType?: CmsContentType;
  status?: CmsContentStatus;
};

export type EffectiveCmsContent = {
  clientId: string;
  buildingId: string | null;
  content: PublicCmsContent[];
};
