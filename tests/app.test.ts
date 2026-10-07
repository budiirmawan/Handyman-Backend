import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { api } from './helpers/http';

describe('createApp', () => {
  it('responds with a runtime confirmation at /', async () => {
    const response = await api().get('/');

    assert.equal(response.status, 200);
    assert.match(String(response.headers['content-type']), /json/);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.name, 'Asentra Backend');
    assert.equal(response.body.data.status, 'running');
  });
});
