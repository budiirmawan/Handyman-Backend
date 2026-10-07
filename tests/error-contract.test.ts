import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, ERROR_CODES } from '../src/shared/errors';
import { api } from './helpers/http';

describe('AppError', () => {
  it('carries optional validation details without becoming a domain framework', () => {
    const error = AppError.validation('Request validation failed.', [
      { field: 'name', message: 'Required' },
    ]);

    assert.equal(error.code, ERROR_CODES.VALIDATION_ERROR);
    assert.equal(error.statusCode, 400);
    assert.deepEqual(error.details, [{ field: 'name', message: 'Required' }]);
  });
});

describe('error contract', () => {
  it('maps unexpected exceptions to INTERNAL_SERVER_ERROR without leaking details', async () => {
    const response = await api({
      configure(application) {
        application.get('/api/v1/__test/boom', () => {
          throw new Error('secret internal boom');
        });
      },
    }).get('/api/v1/__test/boom');

    assert.equal(response.status, 500);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'INTERNAL_SERVER_ERROR');
    assert.equal(
      response.body.error.message,
      'An unexpected server error occurred.',
    );
    assert.ok(response.headers['x-request-id']);
    assert.equal(
      response.body.error.requestId,
      response.headers['x-request-id'],
    );
    assert.doesNotMatch(JSON.stringify(response.body), /secret internal boom/);
    assert.doesNotMatch(JSON.stringify(response.body), /stack/i);
  });

  it('maps invalid JSON bodies to BAD_REQUEST', async () => {
    const response = await api()
      .post('/api/v1/health')
      .set('content-type', 'application/json')
      .send('{"broken"');

    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.doesNotMatch(JSON.stringify(response.body), /SyntaxError/);
  });

  it('returns VALIDATION_ERROR details when an AppError provides them', async () => {
    const response = await api({
      configure(application) {
        application.post('/api/v1/__test/validate', () => {
          throw AppError.validation('Request validation failed.', [
            { field: 'name', message: 'Required' },
          ]);
        });
      },
    }).post('/api/v1/__test/validate');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(response.body.error.details, [
      { field: 'name', message: 'Required' },
    ]);
  });
});
