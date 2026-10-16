# CR-HM-BAST-SIGN-00 — Signature Options Comparison

## 3. Signature Options

### A. Authenticated Electronic Approval with Recorded Evidence
- **Mechanism**: Customer authenticates via SSO/OAuth, server generates one-time challenge, customer's device signs the challenge, signatureDigest is the base64url-encoded ECDSA signature. Evidence records optionally linked.
- **Trust chain**: Authentication → Challenge → Signature → Verification → BAST state hash
- **Pros**: 
  - No PSrE infrastructure required
  - Cryptographically verifiable
  - Binding to challenge prevents replay
  - Works with existing SSO/organization identities
- **Cons**: 
  - Reliance on customer's device security
  - No legal "certified" status (depends on jurisdiction)
  - Not a "certified electronic signature" in the strict PKI sense

### B. Certified Electronic Signature through PSrE
- **Mechanism**: Customer uses a certified PKI-based electronic signature (PSrE - Penanda Tangan Digital Terpercaya). The signature is issued by a certified authority (CA) and has legal standing under Indonesian law (uu No. 11/2020 concerning Information and Electronic Transactions).
- **Trust chain**: CA-verified identity → PSrE signature → BAST acceptance
- **Pros**: 
  - Legally certified under Indonesian law
  - Highest trust level - non-reputable signatory
  - Court-admissible evidence
  - PKI-based non-repudiation
- **Cons**: 
  - Requires PSrE infrastructure and certificate provisioning
  - Customer must have a PSrE certificate
  - Additional cost and complexity
  - May be overkill for internal handyman services

### C. Hybrid Policy
- **Mechanism**: Combines both approaches:
  - Default: Authenticated electronic approval (Option A) for standard handyman contracts
  - Certified: PSrE (Option B) for high-value contracts, government projects, or where legally required
  - Policy decision per contract type determines which signature mode is required
- **Trust chain**: Per-contract policy → corresponding signature mechanism
- **Pros**: 
  - Flexibility to match contract risk/value
  - PSrE only where needed (cost optimization)
  - Balanced user experience
- **Cons**: 
  - Requires policy/decision logic per contract
  - Frontend must support both signature modes
  - Complexity in validation layer

## Recommended Minimum Secure Model for Handyman

**

## CR-HM-BM-CARE-HANDOFF-01: Exchange Token and Decision Provenance

This section explicitly separates the BAST sign-off model from the Care decision model,
preventing unsafe assumptions about exchange token meaning and decision provenance:

### 3b. Exchange Token Does Not Prove Tenant Approval

The BM Super App handoff exchange token (`evidence_exchange_token_hash`) is often
misunderstood as proof that the Tenant approved a quotation, variation, or BAST. This
is explicitly **NOT APPROVED** as an interpretation:

- The exchange token is a **single-use, one-time consumption event** for BM Super App
  handoff attribution. It records which token was consumed by the Building Customer
  Care layer for audit provenance.

- **NOT APPROVED**: The exchange token hash does NOT prove Tenant approval of any
  commercial entity — quotation, variation, or BAST.

- **NOT APPROVED**: The exchange token does NOT authorize quotation APPROVE, variation
  APPROVE, or BAST ACCEPT operations. These require their own verifiable provenance
  chains per existing authority contract provisions.

- The token hash is stored in `handyman_care_decisions.evidence_exchange_token_hash`
  for audit trail completeness. Its presence or absence does not affect the verification
  status of any BAST or quotation decision.

### 3c. Care Decision Does Not Trigger Commercial Mutations

**NOT APPROVED**: Creating a Care decision record (CONFIRM/REJECT) does NOT automatically
perform any of the following:

- Quotation approval (`quotation APPROVE`)
- Variation approval (`variation APPROVE`)
- BAST ACCEPT

Each commercial decision requires its own independently verified provenance. The Care
decision is neutrally recorded for audit purposes only. Without explicit product authority
for commercial mutations, the system remains fail-closed: no automatic propagation
occurs from Care decision creation.

### 3d. Tenant Without Direct Handyman Account

**PROPOSED**: The Tenant/PIC does not require a direct Handyman account or credentials
to participate in the care flow. The Building Customer Care actor authenticates via
backend session, and the Tenant's decision evidence is conveyed through the Building's
mediated channel using a single-use exchange token hash for provenance. This is the
minimum secure model for care mediation — no direct Tenant login to Handyman is
required or permitted.

- This model is PROPOSED as the default for CR-HM-BM-CARE-HANDOFF-01
- PSrE or other signature mechanisms for Tenant direct login are NOT required
- The exchange token binds the decision to the real Tenant/PIC without requiring
  Tenant Handyman login
- Care cannot impersonate Tenant (token binding prevents this)

### 3e. Verifiable Decision Provenance Unresolved for Commercial Operations

**NOT APPROVED**: Even when a Care decision record is created, the authority contract
for what constitutes valid decision provenance for BAST ACCEPT, quotation APPROVE, and
variation APPROVE remains explicitly unresolved.

- Care decision CONFIRM/REJECT → recorded in `handyman_care_decisions` table
- BAST ACCEPT → requires its own challenge-response signature provenance (per
  CR-HM-BAST-SIGN-00 CR-02 through CR-04)
- Quotation APPROVE → requires its own approval chain (separate from care mediation)
- Variation APPROVE → requires its own approval chain (separate from care mediation)

The authority contract for commercial decision provenance is left **Pending** per
  the Unresolved Decisions SD-11: "PSrE integration path for existing ACCEPTed BASTs:
  No migration path; PSrE only for new BASTs — backward compatibility."

All commercial mutations remain fail-closed without explicit product authority.
Recommendation: Option A — Authenticated Electronic Approval with Recorded Evidence**

This is the minimum secure model because:
1. It provides cryptographic proof of signature without requiring PSrE infrastructure
2. It binds the signature to a server-generated challenge, preventing replay
3. It ties the signature to the specific BAST, execution scope, and tenant PIC
4. It works with existing SSO/organization identities most customers already have
5. It's sufficient for the typical handyman service contract use case

## Business/Legal Decisions Requiring Approval

The following decisions must be explicitly approved and cannot be assumed:

1. **PSrE necessity**: Is PSrE required for ALL customer contracts, or only for high-value/government contracts? (Currently: NOT mandatory for every contract — Option A is the default)

2. **Jurisdictional validity**: What level of electronic signature is legally sufficient for handyman service acceptance in the relevant jurisdictions? ( Indonesian law: uu No. 11/2020 acknowledges electronic signatures; PSrE provides higher certification)

3. **Challenge expiration**: What is the acceptable nonce/challenge validity period? (Recommended: 5 minutes)

4. **Signature algorithm**: Which cryptographic algorithms are approved? (ECDSA with P-256 or P-384 recommended)

5. **Evidence record requirement**: When `evidenceRecordId` is provided for ACCEPT, is it mandatory or optional? (Currently: optional, but policy decision needed)

6. **Reject reason mandatory**: Is `rejectReason` always required for REJECT, or can it be omitted? (Currently: mandatory for REJECT per constraint)

7. **Step-up verification for all ACCEPT**: Must all ACCEPT requests go through the challenge-response flow, or can trusted internal actors bypass? (Recommended: challenge-response for all external customers; optional waiver for internal verified actors)

8. **Algorithm migration path**: If PSrE is adopted later, what is the migration path for existing ACCEPTed BASTs?