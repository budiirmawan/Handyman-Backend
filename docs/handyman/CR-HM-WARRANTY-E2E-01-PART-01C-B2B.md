# Warranty 01C-B2B — noncommercial rework dispatch

The existing dispatch release endpoint is used. For a warranty rework it requires
scoped Operations authority and the current approved COVERED assessment, including
byte-verification of the claim evidence. The child must be the exact claim-bound,
noncommercial rework execution. Its released visit must be the current confirmed
appointment for that child, with immutable, session-authenticated PIC consent for
its exact version and slot, the current assigned Crew Leader and capacity. Local
permit and access windows, and the existing BM clearance verifier where applicable,
are rechecked for release and for execution. Rework START, check-in, start-work and
resume cannot bypass the released visit or current Lead. Verified arrival remains an
independent requirement. The visit cannot be cancelled while dispatch is active.

The original required-DP gate is unchanged for ordinary jobs. An independently
approved, explicitly noncommercial covered rework is exempt; readiness and the
release snapshot label that decision `COVERED_NONCOMMERCIAL_REWORK`. No payment,
customer ledger, invoice, or quotation is created or changed for the exemption.

## Legacy migration

0526's old preflight rejected every existing visit on a rework scope. Its preflight
is removed without editing or backfilling any legacy row; legacy rows retain a null
rework-visit identity and no new consent or assignment binding, so they cannot
authorize rework dispatch. Because migrations commit separately, 0526 temporarily
blocks new rework release, START/completion and session start until 0527 installs
the final prospective guards in the same transaction that removes the temporary
blocks. Already-applied 0526 installations need only 0527. A downgrade reinstates
the temporary guards, and 0526 refuses to remove them while rework history exists.

The focused PostgreSQL scenario exercises an unconsented live legacy visit across
both migration steps; fresh consent after reschedule and reassignment; invalid
claim evidence; unauthorized Operations/Leads and cross-Building/Client access;
permit/access changes before and after release; direct SQL bypasses; and execution.
It verifies that an ordinary approved required-DP job remains blocked without
payment, while the covered rework produces no commercial facts. The covered
rework fixture's original quotation does not itself require DP; a covered child
of a paid required-DP original was not simulated, to avoid creating a payment or
ledger solely for the test.
