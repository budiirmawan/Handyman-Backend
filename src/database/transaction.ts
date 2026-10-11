import { AppError, ERROR_CODES } from '../shared/errors';
import type { PoolClient } from 'pg';
import { getPool } from './connection';

/**
 * Runs `work` inside a database transaction, committing on success and
 * rolling back on any error.
 */
export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const constraint = (error as { constraint?: string })?.constraint;
    if (constraint === 'handyman_prequotation_cancelled' || constraint === 'handyman_cancellation_not_eligible') {
      throw new AppError({ code: ERROR_CODES.HANDYMAN_PREQUOTATION_CONFLICT, statusCode: 409,
        message: 'The request is cancelled or is no longer eligible for pre-quotation cancellation.' });
    }
    throw error;
  } finally {
    client.release();
  }
}
