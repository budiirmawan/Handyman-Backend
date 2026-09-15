import request from 'supertest';
import { createApp, type CreateAppOptions } from '../../src/app';

export function api(options: CreateAppOptions = {}) {
  return request(createApp(options));
}
