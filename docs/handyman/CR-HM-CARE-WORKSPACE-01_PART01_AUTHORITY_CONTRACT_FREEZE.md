# CR-HM-CARE-WORKSPACE-01 — PART 01 AUTHORITY & CONTRACT FREEZE

**Status: FROZEN — governance only. Date: 2026-10-08.**

Verified baseline HEAD: `12c939ac931e1c677e9acdc31d5036d449d8cef0`
(current main after PR #13). Tracked and untracked working tree clean before
this document. Assigned branch: `arena/b27c49bb-handyman-backend`.

This PART adds this document only. It does not create routes, schemas,
migrations, credentials, sessions, runtime behavior, or OpenAPI implementation.
All new contracts below are implementation requirements for later PARTs, not
claims of available APIs. PART 00 was a read-only API gap mapping.

## 1. AUTHORITY — identities and authoritative sources

The workspace principal is the integration-attested BM `CUSTOMER_CARE` actor
resolved through the existing care-actor registry. It is never a local User,
Tenant PIC, or represented customer. Never provision a local User/session,
borrow `tenant_pics.userId`, or treat a caller-supplied careActorId as proof.
The administrative User who provisions a grant remains a separate identity.

Reuse these sources without parallel masters:

| Dimension | Authority |
| --- | --- |
| Acting operator | Existing BM integration capability and care-actor registry |
| Property scope | Existing ACTIVE care-actor/property grants |
| Property/building | Existing properties and `buildings.propertyId` |
| Unit | Existing `spaceId`, through room → area → floor → building |
| Represented customer | Existing tenant company and optional tenant PIC |
| Effective occupancy | Existing tenant-building contexts and tenant-space relationships |
| Request provenance | Existing immutable attribution and request context |
| Catalogue | Existing catalogue/service-variant/material-profile authorities |

Client membership, actor identity, property grant, occupancy, provenance, and
representation are distinct. None substitutes for another. A grant bounds
discovery and permits selection of a currently valid represented context; it
is not blanket permission for bulk requests, private history, or every
customer in a Client. No new Property, Unit, Occupancy, or lease authority.

## 2. SESSION — independent reusable workspace admission

Workspace admission is a NEW purpose-specific, integration-signed contract,
separate from represented-context handoff. Reuse the existing integration
signature verification convention (`x-hub-signature-256`) and trusted registry
resolution, not local bearer authentication. Admission payload is exactly:

- `purpose`: literal `HANDYMAN_CARE_WORKSPACE`;
- `integrationCode`, `assertionId`, `issuedAt`, `expiresAt`;
- `actor`: the existing signed Customer Care actor-claim shape.

Unknown fields are rejected; tenant, PIC, property, building, space, and User
claims are not admission inputs. The purpose and all fields must be covered
by canonical signing. An existing represented-context assertion must never
validate as workspace admission or vice versa. Keep integration secrets on
the BM server, never in browser code.

Admission assertions have a maximum five-minute lifetime; reject future-issued,
expired, malformed, invalid-signature, unsupported-capability, or replayed
assertions. Assertion replay protection is purpose-bound and single-use.
A replay must not mint a second session.

Successful admission returns HTTP 201 with an opaque `workspaceToken` and
absolute `expiresAt`. The token is returned once, stored only as a secure hash,
and must never appear in logs, URLs, cursors, or response projections.
Subsequent care workspace calls use `Authorization: Bearer <workspaceToken>`
on the dedicated care routes only. Identical header syntax does not make it
a local User bearer token: credential stores, validation, principal types,
and route middleware must be distinct; no fallback between token kinds.

Session lifetime is at most 15 minutes from issuance, with no sliding expiry,
refresh, or silent renewal. A fresh signed admission is required afterwards.
Sessions are reusable within that bound, explicitly revocable, and scoped to
one integration and one care actor. They do not freeze property grants or
occupancy into enduring authority.

Every authenticated call checks absolute expiry, revocation, current actor
and integration ACTIVE status, and current CUSTOMER_CARE capability. Every
scoped call additionally evaluates current grants and hierarchy. Revocation
must take effect at the next authorization decision; do not use an unexpired
cached grant as authority. Actor/integration deactivation or capability loss
invalidates issued sessions permanently; reactivation requires fresh admission.
Revoking a property grant removes only that property from an otherwise valid
session. Regrant does not revive a revoked session. Later implementation must
support these invalidation semantics without a local User session.

`DELETE /handyman/care/session` revokes the presented workspace session and
returns 204. Repeating logout with the same unexpired, otherwise valid revoked
token returns 204 without restoring authority; all non-logout uses return 401.
No cross-actor session administration or refresh endpoint is introduced.

## 3. DISCOVERY — current effective context only

Discovery derives the actor from the session. Property reads intersect ACTIVE
grants with ACTIVE actor/integration/capability/property/Client authority;
building results additionally require ACTIVE buildings. Derive property and
Client through the authoritative hierarchy, never trust a query's property
claim. An empty grant set produces an empty property list, not Client-wide
fallback.

Tenant discovery returns only ACTIVE tenant companies with currently effective
ACTIVE tenant-building contexts in the granted property. Space discovery
returns only spaces linked to current effective tenant-space relationships
and matching effective tenant-building contexts, with the physical hierarchy
verified. It is not a vacant-unit or historical-occupancy inventory API.

A selected space requires its exact tenant/space/building relationship. For
building-only representation, effective tenant-building context is sufficient:
**no artificial spaceId or requirement for some space occupancy**. Effective
windows are inclusive; null bounds are unbounded. Evaluate ACTIVE status and
effective windows at the current server/database authorization time. Do not
infer effective occupancy from status alone or from request snapshots.

The occupancy response is a read-time projection, not a persisted master or
a credential. It identifies Client/property/building, tenantCompanyId,
nullable spaceId, tenantBuildingContextId, nullable tenantSpaceRelationshipId,
effective windows, and `evaluatedAt`. Building-only rows are explicitly typed
as `BUILDING`; unit rows as `SPACE`. Do not invent a relationship ID for null
space. Return only authoritative current rows; fail closed on inconsistent or
ambiguous context rather than guess an occupant.

Optional PIC discovery is limited to ACTIVE PICs of an explicitly selected,
currently represented tenant/building context. PIC selection never authenticates
the operator; no linked User IDs or private contact details are exposed.
Selections are revalidated at reads and create, not accepted as lasting rights.

## 4. READS — selected representation, not property-wide history

Care request list requires an explicit `propertyId`, `tenantCompanyId`, and
`buildingId`; optional `spaceId` narrows that selected representation. A
session is actor authority, not represented-customer authority by itself.
The server authorizes representation by resolving the selected current tenant
context within the actor's granted property. Never infer a tenant from a space
alone or permit an unqualified all-property/all-tenant request list.

Detail requires the same explicit property/tenant/building context; if spaceId
is supplied it must match the request. Resolve the stored request context and
require it to match the selected represented tenant/building/property. Check
current effective occupancy for each returned request: exact space occupancy
for a space-bound request; effective tenant-building context for a building-only
request. Omitting a space filter must not bypass per-request unit validation.

Both list and detail check current session, grant, hierarchy, tenant and
applicable occupancy. Filtering and projection must share a consistent
authorization decision; filter before pagination and counts. No post-pagination
redaction that leaks inaccessible rows. Turnover denies former-tenant history;
new occupants cannot inherit prior occupants' requests by matching a building
or space. Historical attribution remains immutable. Care has no admin historical
exception, including for requests previously created by the same care actor.

Reuse the bounded request projection: governed status, immutable represented
context, attribution/care-actor provenance and nullable executionScopeId.
These are provenance fields, not access grants. A pointer never authorizes
intake evidence, files, operational actions, or downstream private resources.
Do not expose financial, evidence, PIC contact, or unrelated lifecycle detail
through this PART's list/detail contract.

## 5. CREATE — preserve fresh represented-context exchange

Workspace discovery does not change request-create authority. The BM server
must obtain a fresh signed represented-context handoff for the selection:

`POST /handoff/assertions` → fresh single-use exchange →
`POST /handyman/requests/care`.

The existing care create atomically consumes the exchange, binds immutable
attribution, validates current representation/property scope, and creates the
request. Preserve actor attribution, null acting local User, one request per
attribution, replay denial, transaction rollback and legacy no-actor behavior.
The exchange is create-only in the workspace journey, never reusable admission
or a read credential. A workspace token cannot substitute for it. Do not first
consume it through `/handoff/channel-attributions` then attempt care create.
That existing standalone binding endpoint is unchanged for existing consumers.
No new create endpoint, direct workspace-token create, or context override.

## 6. CATALOGUE — read-only and property-scoped

Care catalogue reads require an explicit currently granted property. Derive
Client through that property and reuse existing ACTIVE catalogue, variant,
material-profile and reference-price authorities. Property scope bounds access;
it does not invent property-specific catalogue ownership where masters are
Client-scoped. Return only entries applicable under existing catalogue rules.

Any optional building or variant/pricing context must belong to the selected
property and existing catalogue relationships. Unresolvable reference prices
remain null, never fabricated. Catalogue access confers no mutation, inventory,
quotation, pricing override, financial entitlement, or create permission.

## 7. ROUTES — exact new families

All paths have prefix `/api/v1`. These are future routes, not implemented here.

| Method/path | Required scope / purpose |
| --- | --- |
| `POST /handyman/care/session` | Signed purpose-specific workspace admission |
| `DELETE /handyman/care/session` | Revoke presented session |
| `GET /handyman/care/properties` | Current actor's effective granted properties |
| `GET /handyman/care/properties/:propertyId/buildings` | Buildings within granted property |
| `GET /handyman/care/properties/:propertyId/tenant-companies` | Current tenant search; optional buildingId, q |
| `GET /handyman/care/properties/:propertyId/spaces` | Current occupied unit search; optional buildingId, tenantCompanyId, q |
| `GET /handyman/care/properties/:propertyId/occupancies` | Current context projection; require tenantCompanyId or spaceId; optional buildingId; conjunctive filters |
| `GET /handyman/care/properties/:propertyId/tenant-companies/:tenantCompanyId/pics` | Require buildingId, optional spaceId; bounded optional-PIC selection |
| `GET /handyman/care/requests` | Require propertyId, tenantCompanyId, buildingId; optional spaceId, governed status |
| `GET /handyman/care/requests/:handymanRequestId` | Require propertyId, tenantCompanyId, buildingId; optional spaceId |
| `GET /handyman/care/properties/:propertyId/catalogue/services` | Read-only active services with active variants |
| `GET /handyman/care/properties/:propertyId/catalogue/material-profiles` | Read-only active profiles; optional serviceCatalogId, serviceVariantId |
| `GET /handyman/care/properties/:propertyId/catalogue/material-profiles/:profileId` | Applicable profile and composed reference price; optional buildingId, serviceVariantId |

All GETs and DELETE require the distinct workspace credential. No care actor
ID input, caller-selected Client scope, grant CRUD, workspace request mutation,
`/webhooks` exposure, or additional care route family is authorized here.
All filters are narrowing, never independent sources of permission.

### Pagination and minimization

Every collection uses `limit` (default 25, integer 1–100) and optional opaque
`cursor`; no offset, unbounded export, or total count. Use the existing success
envelope with data `{ items, nextCursor, evaluatedAt }`. Detail responses use
the existing success envelope. Search `q`, where allowed, is trimmed, 1–100
characters when present, literal case-insensitive name/code search, not regex.
Unknown query/body fields are rejected rather than silently broadening scope.

Use deterministic keyset ordering: master/discovery lists by canonical ID;
requests by createdAt descending then ID descending. Cursors are integrity
protected, expire no later than the session, and bind actor/session, endpoint,
selected scope, filters and ordering. Cursors grant no authority: reauthorize
on every page and omit no-longer-authorized rows. Results are current reads,
not a promise of a stable historical snapshot. Tampered or mismatched cursors
are invalid input, not an alternate route to another scope.

Master search rows expose only canonical IDs, existing display names/codes and
minimal parent IDs needed for selection. Property results omit grantor/revoker
User IDs and administrative grant history. PIC rows expose ID and display name
only. Occupancy fields are limited to section 3 plus necessary display labels.
Do not expose private contacts, linked local User IDs, secrets, credential or
token hashes, raw signed assertions, raw storage keys, or unrelated tenant
records. Catalogue and request fields follow sections 4 and 6.

### Expiry, revocation and errors

Use the existing error envelope; the following symbolic error codes are new
contract requirements, not implemented constants:

| Status/code | Semantics |
| --- | --- |
| 400 / existing validation convention | Invalid UUID, fields, bounds, filters or cursor; no sensitive existence detail |
| 401 / `HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED` | Uniform missing/wrong-kind/expired/revoked credential or failed/replayed admission; no actor/integration enumeration |
| 404 / `HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND` | Uniform absent or inaccessible property/building/tenant/space/PIC/profile/request, revoked property scope, or no longer valid selected representation |
| 403 | No special bypass or role escalation; this contract uses the uniform 404 for scoped resource denial, not distinguishable authorization diagnostics |
| 429 / existing transport convention | Admission/read rate limits when enforced; include Retry-After, never disable authorization |
| 5xx / existing server-error convention | Infrastructure/authority lookup failure fails closed; no fallback to stale grants or broader reads |

A valid authorized collection with no matching current records returns 200 and
an empty items array. An explicitly selected invalid/inaccessible context returns
404, not a distinguishable former-tenant response. Session expiry is checked
before scoped data access and returns 401. Return no partial private results
on authorization failure. No browser caching of private session/discovery/read
responses (`Cache-Control: no-store`). Existing create/handoff and bearer error
contracts are unchanged. Exact rate-limit sizing is an implementation deployment
control, not permission to leave admission unprotected against abuse.

## 8. COMPATIBILITY and implementation boundaries

This freeze extends the prior customer-context decisions only to authorize
bounded reusable care-workspace admission and current-context discovery/read
contracts. The earlier grant-only freeze did not itself authorize bulk access;
this document still does not authorize bulk private customer history.

Preserve all existing bearer/RBAC routes, context-access behavior, and credential
semantics. In particular, existing `/handyman/requests` list/detail retain their
local User/PIC SQL read wall and assigned `PLATFORM_ADMIN` historical exception.
Do not inject care grants into that predicate, remove the exception, or relax
it for general operations Users. Other operational/admin and downstream reads
remain unchanged. The new care building-only rule does not alter the existing
bearer rule requiring some effective space occupancy for its non-admin branch.

No legacy handoff downgrade on actor/scope failure; no changes to FM/SaaS,
request lifecycle, grant provisioning, existing catalogue mutation, or master
ownership. Shared projection code may be reused; incompatible authentication
or authorization predicates must not be shared by substitution of IDs.

Later PARTs: admission/session; grant/property/building projection; tenant/unit/
occupancy discovery; existing-create integration and property-scoped catalogue;
care list/detail; OpenAPI/handoff and compatibility certification. Later tests
must cover replay, expiry, revocation/deactivation/reactivation, cross-property
and cross-tenant denial, turnover, building-only representation, cursor scope,
credential-kind separation and unchanged bearer/admin historical access.
No tests or schema/API/runtime implementation belong to this PART.

## References

- `CR-HM-CUSTOMER-CONTEXT-01_PART01_DECISION_FREEZE.md`
- `CR-HM-01_AMENDMENT_01_CUSTOMER_CARE_ACTOR_HANDOFF.md`
- `src/modules/handyman-care-actors/handyman-care-property-scope.service.ts`
- `src/modules/handyman-handoff/care-representation.service.ts`
- `src/modules/handyman-handoff/handoff-context.service.ts`
- `src/modules/handyman-api/handyman-api.routes.ts`
- `src/modules/handyman-requests/handyman-service-request.repository.ts`
