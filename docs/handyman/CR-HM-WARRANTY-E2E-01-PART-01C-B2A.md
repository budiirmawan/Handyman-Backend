# Warranty rework appointment and tenant consent

A rework visit is an existing execution appointment, pinned to the covered
claim, approved assessment, certificate, item, Client, Building and current
assigned Crew Leader. It is distinct from—and does not alter—the original
visit. A rework scope and active crew assignment must already exist.

* Operations proposes via `POST /handyman/service-warranty-reworks/:reworkId/appointments`
  with `startAt`, `endAt`, and `idempotencyKey`. The server derives the crew.
* The request's exact active Tenant PIC, using their authenticated local user
  session, consents via `POST .../appointments/:appointmentId/consent` with
  the proposal `version` and an `idempotencyKey`. The immutable consent records
  the authenticated session, PIC and exact appointment/slot. Care-entered
  statements and request-level slot choices are not rework consent. A request
  without a linked local PIC cannot use this path until that identity exists.
* Consent leaves the appointment `TENANT_SELECTED`. Operations confirms it
  through the existing `POST /handyman/requests/:requestId/visits/:appointmentId/confirm`
  with the selected `version`; normal capacity reservation is required.
* Operations cancels with `POST .../appointments/:appointmentId/cancel` and
  `{ "version": 3, "reason": "..." }`. A new proposal must name the cancelled
  appointment as `supersedesAppointmentId`; it requires new PIC consent.
  Existing live dispatch must be cancelled first; this part does not implement
  dispatch cancellation.
* `GET .../appointments` returns the latest appointment and `appointmentReady`.
  This is appointment readiness only—not dispatch, BM permit, unit access or
  payment readiness. Those existing guards are not bypassed by this feature.

Slots, consent and bindings are immutable. Confirmation and readiness recheck
the current claim and exact crew assignment. Reassignment makes an earlier
appointment stale, requiring cancellation and rescheduling. No invoice, payment,
quotation, claim-resolution or dispatch action is created here.

Pre-existing rework visits are preserved unchanged, with no reconstructed
consent or crew binding. They do not authorize the new guarded dispatch; a new
appointment and explicit PIC consent are required.
