# CR-HM-BAST-SIGN-00 — Lifecycle / State Diagram

## BAST Status Flow

```
                    +-----------+
                    |   DRAFT   |
                    +-----------+
                       /   |
      PREPARE (idempotent) /     \ VOID (with reason)
         /                   |
        /                    |
   +-------+-----------+   +-----|-----+
   |  ISSUE  |           |       |
   | (DRAFT→ISSUED)      |       |
   +-------+-----------+   +-----|-----+
           |                   |
           | ISSUE requires:   | VOID requires:
           | - QC gate         | - voidReason in event metadata
           | - Crew Lead auth  | - Building guard
           +-----------+       +-----+-----+
                               |
                               v
                    +-----------+
                    |  ISSUED   |
                    +-----------+
                           |
    +----------------------+----------------------+
    |                                              |
    ACCEPT (ISSUED→ACCEPTED)                   REJECT (ISSUED→REJECTED)
    |                                              |
    |  Requires:                                   |
    |  - signatureDigest (challenge-response valid)|
    |  - QC gate (current guarded PASS)           |
    |  - Building guard                            |
    |  - idempotencyKey                           |
    +----------------------------------------------+
                           |
                           v
                    +-----------+
                    |ACCEPTED   |
                    +-----------+
                           |
                           v
                    +-----------+
                    | REJECTED  |
                    +-----------+

                    +-----------+
                    |   VOID    |
                    +-----------+
           ^              |
           | VOID (from)  | VOID (from ISSUED)
           | with reason  | with reason
           |              |
           +--------------+

Legend:
- Arrows show valid status transitions
- All transitions require appropriate authorization guards
- VOID from DRAFT/ISSUED preserves event history
- ACCEPT/REJECT from ISSUED requires: signature, QC gate, building guard
- After ACCEPTED or REJECTED, no further status transitions (terminal states)
- A new BAST can be PREPARED for a VOID'd execution_scope_id (unique index allows)