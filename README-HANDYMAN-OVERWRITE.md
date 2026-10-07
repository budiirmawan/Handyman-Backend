# Handyman Apartment — Overwrite Baseline

This repository was rebuilt from the user-provided ZIP as an overwrite baseline for the Handyman Apartment product.

## Canonical operating model
Tenant/Customer does **not** log in directly to Handyman. The customer is represented by Customer Care through BM Super App. Backend remains the lifecycle, authorization and financial authority. Dispatcher/Admin use a separate Operations Portal. Lead/Worker uses Mob-Handyman.

## Canonical lifecycle
Service Catalogue → Request → Triage → Inspection → Diagnosis → Scope Classification → Estimate → Quotation → Customer Approval → Dispatch → Schedule/Permit/Unit Access → Arrival Verification → Check-In → Start Work → Pause/Resume/Material Run → Material Execution → Complete → Evidence → QC/Rectification → Check-Out → BAST → Payment/Ledger → Entitlement → Settlement/Reconciliation → Warranty/Claim/Rework → Closed.

## Personas
Tenant/Customer; Customer Care; Dispatcher; Admin Operations; Admin Configuration; Admin Finance; Admin Access; Lead Worker; Helper/Worker. Platform Admin is outside operational Handyman and belongs to the SaaS plane.

## Non-negotiable boundaries
- No direct Tenant Handyman login.
- QR/GPS are arrival signals; Backend decides verification.
- Worker reports field actions; Backend decides lifecycle truth.
- MATERIAL_RUN is a work-clock state, not a material transaction.
- Presence Time, Actual Work Time and Billable Time are distinct.
- Quotation approval is not BAST.
- Midtrans/payment gateway is an adapter; Handyman ledger is financial authority.
- SaaS billing is separate from customer job transactions.
- FM/Housekeeping/Security/Utility workflows are not Handyman product surfaces.

See `docs/HANDYMAN_PRODUCT_BASELINE.md` and `docs/HANDYMAN_JOURNEY_LIFECYCLE.json`.
