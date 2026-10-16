# CR-HM-QUOTE-PROJECTION-SEC-01 — Frontend Handoff

**Consumer:** Handyman-Frontend PR #20 (reported OPEN / security blocked)
**Backend contract:** `GET /api/v1/handyman/quotation-versions/:quotationVersionId/lines`
**Scope:** Backend quotation response projection only; no frontend changes in this repository.

## Safe customer quotation-line response

The endpoint continues to return the standard success envelope. `data` is an array of closed, allow-listed line objects:

```json
{
  "success": true,
  "data": [
    {
      "id": "<quotation-line-uuid>",
      "quotationVersionId": "<quotation-version-uuid>",
      "lineType": "MATERIAL",
      "description": "Copper pipe supply",
      "quantity": 2,
      "uomId": "<unit-of-measure-uuid>",
      "finalQuotedUnitAmount": 30000,
      "lineTotal": 60000,
      "currency": "IDR",
      "createdAt": "<ISO-8601>",
      "updatedAt": "<ISO-8601>"
    }
  ],
  "meta": {}
}
```

Use `finalQuotedUnitAmount` and `lineTotal` for the customer quotation; `lineTotal` remains Backend-calculated. The existing totals and authoritative version/status reads retain their customer facts; actor IDs are not needed for rendering. `uomId` remains the unit reference.

The following fields are absent (not `null`) from both the line-list response and the line-create response: **`referenceUnitAmount`**, **`sourceItemId`**, and **`createdByUserId`**. Do not use these fields to render or calculate a customer quotation. In particular, do not substitute the governed reference-price snapshot for the quoted amount.

## Compatibility / Operations notes

- This is a response-only change. The authorized material-line create request may still provide `sourceItemId` as provenance input; request validation, stored source identity, reference-price snapshot, line totals, quotation totals, lifecycle, and approval authority are unchanged.
- The tenant-readable Customer Care material read at `/handyman/execution-scopes/:executionScopeId/material-lines` omits `sourceItemId`.
- The other Tenant-readable quotation GET responses also use narrow customer projections: quotation root/version reads omit `createdByUserId`, the presented-version read omits `createdByUserId`, decision reads omit `decidedByUserId`, and execution-scope reads omit `createdByUserId`. Version/status, decision, tenant/PIC, and approved scope/location facts remain. Authorized creation/management responses retain their audit actor fields; the assigned-field execution-scope quotation snapshot remains unchanged.
- `/handyman/execution-scopes/:executionScopeId/material-lines/final-charge-ready` is **not** a Tenant read: it requires the current authoritative assigned Crew Lead and Client access. Its internal Crew Lead projection retains `sourceItemId` (and has no price fields); a Tenant/non-Lead receives 403. Current Crew Lead material command responses and the assigned field-feed projection likewise retain the source identifier for their independently authorized operational roles. The field feed exposes no prices. Price-catalog routes keep their separate `price_catalog.read` authorization.
- If the frontend used `createdByUserId`, `decidedByUserId`, `referenceUnitAmount`, or `sourceItemId` from a customer read, it must remove that dependency. There is no need to change quoted-price display or totals calculations.

## Consumer inspection status

The Handyman-Frontend source and PR #20 could not be retrieved from this session: GitHub's API returned `403 Resource not accessible by integration`, and the unauthenticated PR URL returned `404`. The user supplied read-only evidence that PR #20 is at `ce7ede83e38b7ca4b8bc961ad76f53f56aac51f9`, includes SEC-02 commit `2276c1b`, and that 18 quotation-consumer parser tests pass. Those tests are consumer contract/parser tests, not live Backend end-to-end tests; their individual assertions could not be independently inspected here. No Handyman-Frontend files were modified.
