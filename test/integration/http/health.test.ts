import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../../src/bootstrap';
import { loadConfig } from '../../../src/infrastructure/config/app-config';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { baseAppEnv } from '../../support/test-env';

describe('GET /health/live', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createApp(loadConfig(baseAppEnv({ DATABASE_URL: db.appUrl })));
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  test('responds 200 without authentication', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('echoes the caller correlation id', async () => {
    const response = await fetch(`${baseUrl}/health/live`, {
      headers: { 'x-correlation-id': 'corr-123' },
    });
    expect(response.headers.get('x-correlation-id')).toBe('corr-123');
  });

  test('generates a correlation id when none is sent', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
