# CR-HM-14 PART 05 — HTTP/OpenAPI gate decision

**Decision: NOT_REQUIRED now.** Required surface: **NONE**.

Verified on assigned branch `arena/01a0efb2-handyman-backend` at
`96cc7df52c865c80d0d7bc8bc2017f347abfac33` (tracked tree clean).

The CR-HM-14 roadmap exit gate requires publication of entitlement
and settlement/reconciliation contracts, governed-input derivation,
and the SaaS-entitlement firewall; it does **not** require HTTP. PART 04
has published the backend-internal, read-only entitlement, settlement,
and reconciliation contract (`CR-HM-14_READ_CONTRACT.md`). START governance
§14 makes PART 05 **optional**, triggered only if CR-HM-17/CR-HM-22
consumption requires transport.

The roadmap describes CR-HM-17 as binding the frontend journey to
backend contracts *as applicable* and CR-HM-18 as binding the mobile
field journey *as applicable*. Neither specifies a current entitlement
or settlement UI/field interaction. The frozen ownership matrix rows
22–23 designate both financial domains **backend-internal at freeze**:
no frontend presentation role and no mobile business/commercial
authority. Its API/OpenAPI dependency applies **where future
presentation exists**; it does not by itself create a current client
surface. CR-HM-14 START Handoff names CR-HM-17/CR-HM-22 as potential
read-family consumers, not an already-approved external transport
requirement. No client-side calculation or client-asserted settlement
state is authorized.

If a downstream consumer later specifies an actual cross-process
financial read need, reopen this conditional gate before wiring that
client: define only the bounded, actor/client-scoped transport over the
PART 04 published read family, with OpenAPI parity. Any command exposure
would require its own explicit authority/actor review and could only
wrap existing PART 02–03 commands. No second write path, caller-authored
money/state/beneficiary, ledger mutation, SaaS/FM coupling, or payout
execution is approved by this decision.

**This PART records a decision only.** No runtime, route, migration,
OpenAPI, test, or build change is made.
