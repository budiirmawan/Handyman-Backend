import type { Response } from 'supertest';
import { api } from './http';

/**
 * Reaches the CLOSED terminal state through the legitimate BE-08I path:
 * verify the COMPLETED Work Order as APPROVED, then close it. Returns the
 * close response. The caller must supply a token with building access to the
 * Work Order's Building.
 */
export async function closeWorkOrderVia(
  workOrderId: string,
  token: string,
): Promise<Response> {
  const auth = { Authorization: `Bearer ${token}` };
  const verify = await api()
    .post(`/api/v1/work-orders/${workOrderId}/verification`)
    .set(auth)
    .send({ decision: 'APPROVED', notes: 'Verified and approved' });
  if (verify.status !== 201) {
    return verify;
  }
  return api()
    .post(`/api/v1/work-orders/${workOrderId}/close`)
    .set(auth)
    .send({});
}
