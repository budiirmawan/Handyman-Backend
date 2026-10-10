# W02 PART 01 — Assisted Request Intake: Runtime Reconciliation

Baseline: Handyman Journey v1.3 FROZEN. Branch `arena/c6fc25e1-handyman-backend`.
Scope: assisted intake only (Customer Care creates a request on behalf of a represented tenant). No new endpoint.

## 1. Reuse map (existing, unchanged)

| Step | Endpoint / module | Authority |
|---|---|---|
| Workspace admission | `POST /api/v1/handyman/care/session`, `DELETE` (logout) | BM signed assertion, integration CUSTOMER_CARE capability, ACTIVE care actor |
| Context selection | `GET /handyman/care/properties`, `/properties/:id/tenant-companies`, `/spaces`, `/occupancies` | ACTIVE property grant of the care actor, workspace session |
| Create exchange | `POST /handyman/care/properties/:propertyId/create-exchanges` | live session, property grant, exact current occupancy (`resolveHandoffContext` + `isCurrentCareRepresentation`), active physical hierarchy and tenant–Client binding |
| Create request | `POST /handyman/requests/care` (exchange token only) | single-use exchange, re-check of session/grant/occupancy at consumption |
| Read back | `GET /handyman/care/requests`, `GET /handyman/care/requests/:requestId` | live session, property grant, C6 read projection for the selected tenant/building/space |

Body of create-exchange accepts only `tenantCompanyId`, `buildingId`, `spaceId`. Property is in the path. Any authority field (`tenantPicId`, `clientId`, `careActorId`, `originChannel`, etc.) is refused with 400.

## 2. Contract facts verified at runtime

- Customer Care creates a request with `status: INTAKE`, `clientId`, `tenantCompanyId`, `buildingId`, `spaceId` taken from the server-resolved occupancy.
- `createdByUserId: null`, `tenantPicId: null` for workspace-created requests (no PIC is invented).
- Attribution: `actor_type = CUSTOMER_CARE`, `care_actor_id`, `actor_reference`, `origin_channel = BM_SUPER_APP`, `origin_reference = bm-handoff:<integration>:workspace-create:<session>:<uuid>`.
- Exchange is single-use; reuse returns 401.
- Request is readable through the workspace list and detail with the same selectors.

## 3. Negative coverage

| Case | Test | Expected |
|---|---|---|
| Unknown tenant | `negative: invalid tenant, cross-building ...` | 404, no write |
| Cross-building (space of building A with building B) | same | 404, no write |
| Missing occupancy (tenant has no context for building) | same | 404, no write |
| PIC in body | same | 400, no write |
| Duplicate submission of one exchange | `negative: duplicate submission ...` | first 201, second 401, exactly one request/attribution added |
| Revoked workspace session (issue, create, read back) | `negative: a revoked workspace session ...` | 401 on all |
| Property grant revoked after creation | `read-back is bounded by the property grant ...` | no new exchange (404); detail and list no longer show the request (403/404) |

Pre-existing coverage kept: occupancy turnover after acceptance, legacy exchange rejection on the care route, concurrent single consumption, wrong property/client, invalid selectors and query parameters, C6 wall for generic reads.

## 4. Test evidence

- Typecheck: `npx tsc --noEmit -p .` PASS.
- `tests/handyman-care-workspace-create-exchange.test.ts` 20/20 PASS (16 existing + 5 W02 PART 01 cases, DB reset before run).
- `tests/handyman-care-request-create.test.ts`, `tests/handyman-care-workspace-admission.test.ts` (ran in the same session before the W02 additions, no source change since): 40/40 across the three files PASS.

## 5. Decisions and residual gaps for W02 PART 02

1. **PIC selection is not an intake input (decision needed).** W02 says "atas nama Tenant/PIC yang sah". The existing contract, asserted by tests, deliberately refuses `tenantPicId` in the workspace create body and leaves `tenantPicId` null. Only the BM-attested assertion path carries a PIC. Adding PIC selection would be a new authority input and was not implemented in this part. Current "valid representative" = valid tenant company + exact current occupancy.
2. Read-back after occupancy turnover is not asserted. The request remains a historical record; the policy for its visibility after turnover belongs to PART 02.
3. No UI or BM-side flow is exercised here. This is backend runtime proof only, not an E2E claim.
4. Duplicate *business* requests (same customer, same description, two exchanges) are not deduplicated; each issued exchange is a separate intake. Whether assisted intake needs a dedupe rule is a PART 02 question.
