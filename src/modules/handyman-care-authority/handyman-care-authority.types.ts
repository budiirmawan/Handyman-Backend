/**
 * CR-HM-BM-CARE-AUTH-01 — Building Customer Care authority types.
 *
 * Business baseline: TENANT/PIC ↔ CUSTOMER CARE BUILDING ↔ HANDYMAN.
 *
 * Two authorities are deliberately separated and must never be conflated:
 *
 *   Authority A — WHO the Care actor is, and WHICH exact Building they may
 *                 mediate. Implemented here.
 *   Authority B — WHETHER a Tenant approved a Quotation, a Variation or a
 *                 BAST. NOT implemented. Blocked. See
 *                 docs/handyman/CR-HM-BM-CARE-AUTH-01_BUILDING_CARE_AUTHORITY.md.
 *
 * This type module expresses that boundary in the shape of the data itself:
 * an `BuildingCareAuthority` can never carry a Tenant/PIC identity and can
 * never carry a commercial grant.
 */

/**
 * The dedicated Building Customer Care capability.
 *
 * Registered by migration 0450 and granted to NO role by that migration or by
 * the foundation seed (`UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`): enabling a
 * Care persona is a deliberate, audited administrative grant. The permission
 * alone still authorizes nothing out of scope — the runtime additionally
 * requires an ACTIVE assignment to the EXACT Building.
 */
export const HANDYMAN_CARE_BUILDING_PERMISSION = 'handyman.care.building';

/** The single role label this authority can assert. */
export const CARE_AUTHORITY_ROLE = 'BUILDING_CUSTOMER_CARE' as const;

export type CareAuthorityRole = typeof CARE_AUTHORITY_ROLE;

/**
 * Where the Care identity came from.
 *
 * `BACKEND_SESSION` is the only value that can currently be produced. The BM
 * Super App Care actor registry (`handyman_handoff_care_actors`, migrations
 * 0425-0430) is a real, integration-signed Care identity source, but it is
 * NOT connected to Backend session authentication: those rows carry no local
 * user, no session and no Building assignment. Until that boundary is wired,
 * `bmCareActorId` stays null and no fake Care identity is minted.
 */
export const CARE_IDENTITY_SOURCES = ['BACKEND_SESSION'] as const;

export type CareIdentitySource = (typeof CARE_IDENTITY_SOURCES)[number];

export type CareBuildingScope = {
  clientId: string;
  clientCode: string | null;
  propertyId: string | null;
  buildingId: string;
  buildingCode: string;
  buildingName: string;
  /** Server-derived from the actor's own ACTIVE assignment. Never caller-supplied. */
  assignmentId: string;
};

/**
 * Capability surface returned to the caller.
 *
 * `mayMediateBuildingCare` is the ONLY true grant, and it is exactly
 * Authority A. Every commercial capability is a compile-time `false` literal:
 * the Care bridge never approves a Quotation, never approves a Variation and
 * never ACCEPTs a BAST. Care decisions are a separate, still-disabled
 * authority (SD-17: neutral recording, no automatic commercial mutations).
 */
export type CareAuthorityCapabilities = {
  /** Authority A — identity + exact Building mediation reach. */
  mayMediateBuildingCare: true;
  /** Authority B — recording a Care decision. Disabled: contract insufficient. */
  mayRecordCareDecision: false;
  mayApproveQuotation: false;
  mayApproveVariation: false;
  mayAcceptBast: false;
  /** The bridge may never present itself as, or act as, the Tenant/PIC. */
  mayActAsTenantPic: false;
};

export type BuildingCareAuthority = {
  role: CareAuthorityRole;
  actor: {
    /** Session-derived Backend user id. The ONLY accepted actor identity. */
    userId: string;
    displayName: string;
    email: string;
  };
  /** The permission code that actually authorized this resolution. */
  grantedByPermission: string;
  scope: CareBuildingScope;
  capabilities: CareAuthorityCapabilities;
  identitySource: CareIdentitySource;
  /**
   * BM Care actor binding — always null today. Non-null only once the BM Care
   * authentication boundary is genuinely connected to the Backend; this field
   * exists so the limitation is explicit and machine-readable rather than
   * silently assumed away.
   */
  bmCareActorBinding: null;
  /**
   * Why Authority B remains blocked, surfaced to the frontend so it can
   * render the correct disabled state instead of inventing one.
   */
  decisionAuthority: {
    status: 'BLOCKED';
    reason: string;
    endpoint: '/handyman/care-decisions';
    method: 'POST';
  };
};

export type ResolveBuildingCareAuthorityInput = {
  /** Must come from `req.auth.userId`. Never from a request body. */
  actorUserId: string | null | undefined;
  buildingId: string;
  /**
   * Optional Client/Company assertion. When supplied it MUST equal the
   * Client the Backend derives from the actor's own ACTIVE Building
   * assignment; otherwise the resolution fails closed. It can never widen
   * or redirect the derived scope.
   */
  assertedClientId?: string | null;
};

/** Safe public projection returned over HTTP. */
export type PublicBuildingCareAuthority = BuildingCareAuthority;
