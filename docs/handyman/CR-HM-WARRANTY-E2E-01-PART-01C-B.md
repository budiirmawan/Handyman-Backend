# Warranty 01C-B: rework execution and fresh QC

A rework is created only for the current approved, certificate-bound COVERED
assessment. The original quotation, execution, QC, accepted BAST and warranty
certificate remain unchanged. After the existing customer authorization,
Operations creates a distinct scope with
`POST /handyman/service-warranty-reworks/:reworkId/execution` and
`{ "idempotencyKey": "..." }`. Assign its Lead using the existing execution
scope assignment API. The scope retains its exact claim, assessment,
certificate, covered item, Client and Building; its recorder is the real
Operations user, not the earlier quotation approver.

The assigned Lead needs a real verified arrival and currently active local
permit and unit access before the existing rework START. A declined assignment
requires reassignment; a response cannot be changed after rework starts. COMPLETE requires a
new, exact-scope `BEFORE_AFTER_WORK` managed upload by that Lead, verified
with stored bytes after START. The existing rework lifecycle is the completion
authority: no Work Session, tenant visit consent or dispatch fact is invented.
If real Work Sessions exist, all must be completed. Helpers do not declare
completion or decide QC.

Configure and run the existing versioned QC checklist on the child scope after
completion. The independent, authorized supervisor must supply fresh QC
uploads; the new run is immutably bound to the completion. The guarded QC
consumer rechecks the covered claim and completion bytes and requires the
latest passed run. Ordinary non-rework QC retains its normal Work Session
gates. After a failed QC, the existing corrective-session gate remains in
force; this part does not add a corrective-rework/retry workflow.

`GET /handyman/service-warranty-reworks/:reworkId/execution` exposes the
completion and current QC status. An optional `qcRunId` requires that exact
run to be the current guarded PASS. Final claim resolution is not implemented;
new uses of the old VERIFY shortcut are rejected and historical rows remain.

The child scope is barred from opening a customer transaction, reusing paid
completion declarations or creating commercial variations; separately agreed
chargeable work requires a different scope. No customer transaction, charge
line, invoice, quotation item, payment or payment request is created by rework. The pre-existing scope-insert trigger
creates only its zero-revision invoice-source concurrency fence; it is not an
invoice, charge or payment. There are no invoice or payment code changes.
The focused test's CLOSED-original check is explicitly a rolled-back state
simulation, not a fabricated financial close or proof of a live final-close
flow.
