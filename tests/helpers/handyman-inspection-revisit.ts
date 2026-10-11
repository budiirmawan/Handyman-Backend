import { api } from './http';
import { startDirectQuotationFixture, auth, status } from './handyman-direct-quotation';
export { auth, status, denied, closeDirectQuotationFixture } from './handyman-direct-quotation';
export const HM = '/api/v1/handyman/requests';
export const REASON = 'Customer has now confirmed access to the previously inaccessible unit.';
export async function startRevisitFixture(port: number) {
  const f = await startDirectQuotationFixture(port);
  const post = (id: string, path: string, body: object, token = f.ops.token) => api().post(`${HM}/${id}/${path}`).set(auth(token)).send(body);
  const capture = (id: string, result = 'NOT_INSPECTABLE', extra: object = {}, token = f.field.token) => post(id, 'inspection', {
    result, notes: result === 'INSPECTED' ? 'Pipe joint observed on the later physical visit.' : 'Unit remained locked; no technical inspection was possible.',
    ...(result === 'NOT_INSPECTABLE' ? { unsuccessfulReason: 'ACCESS_DENIED' } : {}), ...extra,
  }, token);
  const submit = (id: string, token = f.field.token) => post(id, 'inspection-reports', {
    disciplineId: f.disciplineId, technicalFindings: 'Recorded observations and limits of the physical attempt.',
    proposedDiagnosis: 'Operations must verify inspection success before technical preparation.',
  }, token);
  const review = (id: string, reportId: string, decision = 'ACCEPTED') => post(id, `inspection-reports/${reportId}/review`, {
    decision, ...(decision === 'RETURNED' ? { returnReason: 'Clarify the access failure and observations.' } : {}),
  });
  const diagnose = (id: string) => post(id, 'diagnosis', { disciplineId: f.disciplineId, diagnosis: 'Repair the successfully observed pipe joint.' });
  const draft = (id: string) => post(id, 'quotation', {});
  const cancel = (id: string, token = f.ops.token) => post(id, 'prequotation-cancellation', { reason: 'Customer withdrew the request before any quotation.' }, token);
  const window = async (id: string) => {
    const r = await post(id, 'scheduling-readiness', {
      preferredWindowStart: new Date(Date.now()+86_400_000).toISOString(),
      preferredWindowEnd: new Date(Date.now()+90_000_000).toISOString(),
    }); status(r, 201, 'preferred readiness'); return r.body.data;
  };
  const assigned = async () => {
    const request = await f.createRequest();
    status(await post(request.id, 'triage', { disposition: 'INSPECTION_REQUIRED', note: 'A site inspection is required.' }), 201, 'inspection triage');
    const assignment = await post(request.id, 'inspection-assignment', { assignedFieldUserId: f.field.userId });
    status(assignment, 201, 'Field assignment');
    return { request, assignment: assignment.body.data.current };
  };
  const failed = async (accept = true) => {
    const base = await assigned();
    const physical = await capture(base.request.id); status(physical, 201, 'unsuccessful physical attempt');
    const report = await submit(base.request.id); status(report, 201, 'failure report');
    if (accept) status(await review(base.request.id, report.body.data.id), 201, 'acknowledge unsuccessful attempt');
    const readiness = await window(base.request.id);
    const input = { precedingInspectionId: physical.body.data.id, precedingReportId: report.body.data.id,
      assignedFieldUserId: f.field.userId, schedulingReadinessId: readiness.id, reason: REASON };
    return { ...base, inspection: physical.body.data, report: report.body.data, readiness, input };
  };
  return { ...f, post, capture, submit, review, diagnose, draft, cancel, window, assigned, failed,
    plan: (id: string, input: object, token = f.ops.token) => post(id, 'inspection-revisits', input, token) };
}
