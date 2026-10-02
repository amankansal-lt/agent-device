import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createProviderWebDriver } from './index.ts';

const lambdaTestOptions = {
  provider: 'lambdatest' as const,
  username: 'lt-user',
  accessKey: 'lt-key',
  platform: 'android' as const,
  deviceName: 'Pixel 8',
  osVersion: '14',
  app: 'lt://APP123',
};

afterEach(() => vi.unstubAllGlobals());

test('LambdaTest verifies credentials read-only and defers the device to session creation', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    jsonResponse({ data: { max_concurrency: 2, running: 0, queued: 0 } }),
  );
  vi.stubGlobal('fetch', fetchMock);

  const result = await createProvider().verifyConnection({
    ...lambdaTestOptions,
    concurrencyEndpoint: 'https://lambdatest.test/concurrency',
  });

  assert.equal(result.provider, 'lambdatest');
  assert.deepEqual(result.device, {
    status: 'deferred',
    name: 'Pixel 8',
    platform: 'android',
    osVersion: '14',
  });
  assert.equal(result.app.status, 'configured');
  assert.equal(result.app.reference, 'lt://APP123');
  assert.equal(fetchMock.mock.calls.length, 1);
  const [input, init] = fetchMock.mock.calls[0] ?? [];
  assert.equal(String(input), 'https://lambdatest.test/concurrency');
  assert.equal(
    new Headers(init?.headers).get('Authorization'),
    `Basic ${Buffer.from('lt-user:lt-key').toString('base64')}`,
  );
});

test('LambdaTest classifies rejected credentials without exposing them', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({}, 401)),
  );

  await assert.rejects(createProvider().verifyConnection(lambdaTestOptions), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'UNAUTHORIZED');
    assert.doesNotMatch(JSON.stringify(error), /lt-key/);
    return true;
  });
});

test('LambdaTest rejects a malformed lt:// reference before calling the provider', async () => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);

  await assert.rejects(
    createProvider().verifyConnection({ ...lambdaTestOptions, app: 'lt://' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'INVALID_ARGS');
      return true;
    },
  );
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('LambdaTest reports an unreachable API as a connection failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed');
    }),
  );

  await assert.rejects(createProvider().verifyConnection(lambdaTestOptions), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
    assert.match(
      String((error as { details?: { hint?: string } }).details?.hint),
      /mobile-api\.lambdatest\.com/,
    );
    return true;
  });
});

function createProvider() {
  return createProviderWebDriver({ clientVersion: '1.2.3', runHostCommand: vi.fn() });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
