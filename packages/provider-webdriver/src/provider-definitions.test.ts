import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createProviderWebDriver } from './index.ts';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';

afterEach(() => vi.unstubAllGlobals());

test('LambdaTest uploads an HTTP app by URL before creating the session', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith('/upload')
      ? jsonResponse({ app_url: 'lt://FROM-URL' })
      : jsonResponse({ value: { sessionId: 'wd-1', capabilities: {} } }),
  );
  vi.stubGlobal('fetch', fetchMock);

  await allocateLambdaTest('https://apps.example/App.apk');

  const [upload, session] = fetchMock.mock.calls;
  const form = upload?.[1]?.body as FormData;
  assert.equal(form.get('url'), 'https://apps.example/App.apk');
  const body = JSON.parse(String(session?.[1]?.body)) as {
    capabilities: { alwaysMatch: { 'lt:options': { app: string } } };
  };
  assert.equal(body.capabilities.alwaysMatch['lt:options'].app, 'lt://FROM-URL');
});

test('LambdaTest rejects a missing local app before calling the provider', async () => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  const tempDir = await mkdtempForTest('agent-device-lambdatest-app-');

  await assert.rejects(allocateLambdaTest(path.join(tempDir, 'missing.apk')), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'INVALID_ARGS');
    assert.equal((error as { details?: { hint?: string } }).details?.hint, undefined);
    return true;
  });
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('LambdaTest asks for a zipped bundle when given an unzipped .app directory', async () => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  const appPath = path.join(await mkdtempForTest('agent-device-lambdatest-app-'), 'Demo.app');
  await fs.mkdir(appPath);

  await assert.rejects(allocateLambdaTest(appPath), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'INVALID_ARGS');
    assert.match(String((error as { details?: { hint?: string } }).details?.hint), /Zip the \.app/);
    return true;
  });
  assert.equal(fetchMock.mock.calls.length, 0);
});

async function allocateLambdaTest(providerApp: string) {
  const runtime = createProviderWebDriver({ clientVersion: '1.2.3', runHostCommand: vi.fn() })
    .createDefaultRuntimes({
      LT_USERNAME: 'lt-user',
      LT_ACCESS_KEY: 'lt-key',
      LAMBDATEST_WEBDRIVER_ENDPOINT: 'https://lambdatest.test/wd/hub/',
      LAMBDATEST_APP_UPLOAD_ENDPOINT: 'https://lambdatest.test/upload',
    })
    .find((candidate) => candidate.provider === 'lambdatest');
  assert.ok(runtime);
  try {
    return await runtime.leaseLifecycle.allocate?.(lease, {
      flags: { platform: 'ios', device: 'iPhone 16', providerOsVersion: '18', providerApp },
    });
  } finally {
    await runtime.shutdown();
  }
}

const lease: DeviceLease = {
  leaseId: 'lease-1',
  tenantId: 'tenant-a',
  runId: 'run-a',
  leaseProvider: 'lambdatest',
  backend: 'ios-instance',
  createdAt: 1,
  expiresAt: 2,
  heartbeatAt: 1,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
