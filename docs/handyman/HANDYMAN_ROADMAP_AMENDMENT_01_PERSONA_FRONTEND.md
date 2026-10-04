# HANDYMAN ROADMAP AMENDMENT 01 — Persona & Frontend

**Status: FROZEN — GOVERNANCE / DOCUMENTATION ONLY.** This additive amendment registers `CR-HM-17-A01` and new top-level `CR-HM-23..25` without renumbering, replacing, or rewriting the frozen `CR-HM-01..22` roadmap entries. It makes no runtime, API, schema, permission-catalogue, or database change.

Authoritative roadmap base: `HANDYMAN_CR_CODING_ROADMAP_v1.0.md`. The same registration is appended to that roadmap. The frozen CR-HM-00 ownership matrix remains unchanged; detailed runtime ownership/contracts for the new CRs are to be established by their own governance.

## PERSONAS

| Persona | Primary surface | Frozen boundary |
|---|---|---|
| **Tenant** | None — no Handyman surface/login | Tenant has no Handyman login and does not sign into Handyman-Frontend, Handyman-Operations, or Mob-Handyman as a Handyman actor. |
| **Customer Care** | BM Super App → Handyman-Frontend | Customer Care uses the existing BM Super App hand-off and the Customer Care journey in Handyman-Frontend. Customer Care is not Dispatcher, Admin, or field Lead. |
| **Dispatcher** | Handyman-Operations | Uses an explicitly granted dispatch capability for dispatch work. Dispatcher capability does not imply Admin authority. |
| **Admin — Operations / Configuration / Finance / Access** | Handyman-Operations | These are distinct capabilities in the same Operations Portal, not one implicit all-powerful Admin grant. A user may be explicitly granted one or more. |
| **Lead / Worker** | Mob-Handyman | Field identities are resolved and authorized by Backend. Lead receives only current Backend-assigned scopes. Helper/Worker membership does not confer Lead authority. |
| **Platform Admin** | Asentra-SaaS | Platform administration stays in the SaaS control plane and does not imply Handyman Operations or field authority. |

A surface, navigation item, persona label, or client-side role check is not Backend authorization. The canonical authority chain is:

```text
Persona → Surface → Role → Capability → Backend
```

Every step narrows the next. Backend authentication, capability checks, object binding, assignment state, and tenant/context isolation remain final. A frontend cannot mint or elevate a role or capability.

## ADMIN / DISPATCHER SEPARATION

- Admin and Dispatcher are separate capabilities on the same Handyman-Operations portal. One user may hold both by explicit assignment.
- Holding Dispatcher does not implicitly grant Admin Operations, Configuration, Finance, or Access capabilities. Holding an Admin capability does not implicitly grant Dispatcher capability. Co-assignment is allowed; inheritance is not.
- Backend authorization is checked for the requested operation; a shared portal session does not collapse capabilities into a universal role.
- Dispatcher coordinates dispatch through the portal; the existing CR-HM-04 provider-authored assignment/reassignment authority remains unchanged. A Dispatcher label alone grants no assignment write or claim authority. Any Dispatcher-direct assignment write requires separate governance and an explicit Backend capability.
- CR-HM-23 governs the Backend integration/authority contract. CR-HM-24 consumes it for Operations Portal presentation. Neither frontend navigation nor this amendment adds assignment/reassignment authority.

## LEAD / HELPER BOUNDARY

- Mob-Handyman presents field work to the authenticated current Lead/Worker identity.
- Lead assigned-scope discovery/read is limited to the current Backend assignment and current authoritative Lead binding, with the existing Backend Client-access boundary. No unassigned browse or claim authority is assigned to Lead Mobile.
- A Helper is not a Lead by virtue of crew membership. Helper status alone grants no Lead-only scope discovery, assignment, or command authority. Any Helper-specific UX or authority requires its own Backend contract; Amendment 01 does not define it.
- The existing CR-HM-18 / BE02 Lead-read contract remains unchanged: authenticated Lead plus current assignment chain plus `canAccessClient`; never `tenant_company.read`; no commercial or sensitive fields; a preferred window is not a confirmed schedule. No unassigned browse or claim authority is introduced.

## FRONTEND PRODUCTION / MIRROR MODEL

| Production surface | Frozen stack label | Mirror rule | Authority |
|---|---|---|---|
| **Handyman-Frontend** | React / TypeScript + HTML / CSS / JavaScript | The Customer Care Browser Visual Mirror is registered as CR-HM-17-A01. Every UX PART updates its production Customer Care surface and mirror together. | Handyman-Backend is authoritative; the frontend and mirror are presentation/orchestration only. |
| **Handyman-Operations** | React / TypeScript + HTML / CSS / JavaScript | Each Operations Portal UX PART updates its production surface and mirror together. | Handyman-Backend is authoritative for identities, capabilities, assignments, and business state; portal and mirror are presentation only. |
| **Mob-Handyman** | React Native + HTML / CSS / JavaScript | Each Mobile UX PART updates its production field surface and mirror together. | Handyman-Backend is authoritative; the mobile client and mirror do not own business, commercial, or assignment state. |

**All mirrors are non-authoritative.** A visual mirror may illustrate layout and interaction, but it cannot authenticate users, grant roles/capabilities, store authoritative workflow state, decide assignments, or replace production UX acceptance. A UX PART does not close until its production surface and corresponding mirror are updated in the same PART and reviewed together.

## CR-HM-25 CONVERSATION BOUNDARY

**Job Conversation != Notification/System Event.** CR-HM-25 registers a job/scope-bound human conversation/operational communication authority, to be defined by that CR. CR-HM-16 remains the authority for notification, event delivery, audit, and reliability semantics. A notification may signal conversation activity, but a notification or system event is not a conversation message; conversation content is not a system event. This amendment does not define endpoints, message schemas, attachments, retention, or delivery behavior.

## ADDITIVE REGISTRATION

The CR-HM-01..22 identifiers, titles, order, and existing definitions remain unchanged. CR-HM-17-A01 is a subordinate amendment to CR-HM-17; CR-HM-23..25 are new top-level registrations appended after CR-HM-22.

| Registration | Name | Primary repository / authority | Depends on | Produces contract for | Frozen exit boundary |
|---|---|---|---|---|---|
| **CR-HM-17-A01** | Customer Care Browser Visual Mirror | Handyman-Frontend; Handyman-Backend remains business/auth authority | CR-HM-17 | CR-HM-22 | Production Customer Care journey and browser visual mirror evolve together; mirror remains non-authoritative and does not change BM Super App hand-off or Customer Care authorization. |
| **CR-HM-23** | Operations Portal Authority & Integration | Handyman-Backend authority + Handyman-Operations consumer | CR-HM-04, CR-HM-18 | CR-HM-24, CR-HM-25 | Persona-to-surface-to-role-to-capability integration is explicit; Admin and Dispatcher are distinct; Backend remains final authorization authority; no capability inheritance is inferred. |
| **CR-HM-24** | Admin/Dispatcher Operations Frontend | Handyman-Operations | CR-HM-23 and applicable published Backend contracts | CR-HM-22, CR-HM-25 | Same portal presents distinct Admin/Dispatcher capabilities; production UX and mirror are updated in the same UX PART; no business/assignment authority is duplicated client-side. |
| **CR-HM-25** | Job Conversation & Operational Communication | Handyman-Backend authority; Handyman-Frontend, Handyman-Operations, and Mob-Handyman consumers | CR-HM-04, CR-HM-06, CR-HM-16, CR-HM-23 | CR-HM-17, CR-HM-18, CR-HM-24 | Job/scope conversation is separately governed from Notification/System Event; Backend is authoritative; each consuming surface is presentation only. |

These registrations do not renumber the original 22 CRs or retroactively alter the frozen 34-row CR-HM-00 matrix. Any additional authority, dependency, or runtime contract is owned by the registered CR and must preserve the persona, capability, mirror, and authority boundaries above.

**Amendment 01 exit: PERSONA / SURFACE / AUTHORITY / MIRROR RULES REGISTERED; documentation only.**
