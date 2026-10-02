import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  buildLambdaTestCapabilities,
  listLambdaTestCloudArtifacts,
  uploadLambdaTestApp,
} from './lambdatest.ts';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';

const auth = { clientVersion: '0.0.0-test', username: 'lt-user', accessKey: 'lt-key' };
const expectedAuthorization = `Basic ${Buffer.from('lt-user:lt-key').toString('base64')}`;

afterEach(() => vi.unstubAllGlobals());

test('LambdaTest capabilities merge configured lt:options per key and keep w3c on', () => {
  const capabilities = buildLambdaTestCapabilities({
    platform: 'android',
    deviceName: 'Pixel 8',
    osVersion: '14',
    app: 'lt://APP123',
    buildName: 'build-a',
    sessionName: 'session-a',
    configured: { 'lt:options': { isRealMobile: true, w3c: false, tunnel: true } },
  });

  const ltOptions = capabilities['lt:options'] as Record<string, unknown>;
  assert.equal(ltOptions.isRealMobile, true);
  assert.equal(ltOptions.tunnel, true);
  assert.equal(ltOptions.w3c, true);
  assert.equal(ltOptions.build, 'build-a');
  assert.deepEqual(Object.keys(capabilities), ['platformName', 'lt:options']);
});

test('LambdaTest upload sends a local app as appFile with Basic auth', async () => {
  const tempDir = await mkdtempForTest('agent-device-lambdatest-upload-');
  const appPath = path.join(tempDir, 'App.apk');
  await fs.writeFile(appPath, 'placeholder');
  const controller = new AbortController();
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ app_url: 'lt://APP123' }));
  vi.stubGlobal('fetch', fetchMock);

  const appUrl = await uploadLambdaTestApp(
    appPath,
    { ...auth, endpoint: 'https://lambdatest.test/upload' },
    controller.signal,
  );

  assert.equal(appUrl, 'lt://APP123');
  const [input, init] = fetchMock.mock.calls[0] ?? [];
  assert.equal(String(input), 'https://lambdatest.test/upload');
  assert.equal(init?.signal, controller.signal);
  assert.equal(new Headers(init?.headers).get('Authorization'), expectedAuthorization);
  const form = init?.body as FormData;
  assert.equal((form.get('appFile') as File).name, 'App.apk');
  assert.equal(form.get('name'), 'App.apk');
  assert.equal(form.get('url'), null);
});

test('LambdaTest upload registers an HTTP app by URL and falls back to app_id', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ app_id: 'APP456' }));
  vi.stubGlobal('fetch', fetchMock);

  const appUrl = await uploadLambdaTestApp('https://apps.example/builds/App.zip?sig=1', auth);

  assert.equal(appUrl, 'lt://APP456');
  const [input, init] = fetchMock.mock.calls[0] ?? [];
  assert.doesNotMatch(String(input), /lt-key|lt-user/);
  const form = init?.body as FormData;
  assert.equal(form.get('url'), 'https://apps.example/builds/App.zip?sig=1');
  assert.equal(form.get('storage'), 'url');
  assert.equal(form.get('name'), 'App.zip');
  assert.equal(form.get('appFile'), null);
});

test('LambdaTest upload reports a response without an app reference as a failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ message: 'quota exceeded' }, 400)),
  );

  await assert.rejects(
    uploadLambdaTestApp('https://apps.example/App.apk', auth),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.equal((error as { details?: { status?: number } }).details?.status, 400);
      return true;
    },
  );
});

test('LambdaTest upload reports a non-JSON response with its HTTP status', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })),
  );

  await assert.rejects(uploadLambdaTestApp('https://apps.example/App.apk', auth), (error) =>
    assertCommandFailedWithStatus(error, 502),
  );
});

test.for([
  ['session details without URLs', () => jsonResponse({ data: {} })],
  ['unpublished session details', () => jsonResponse({ message: 'not found' }, 404)],
  ['a non-JSON 404', () => new Response('Not Found', { status: 404 })],
] as const)('LambdaTest artifacts stay pending for %s', async ([, response]) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response()),
  );

  const result = await listLambdaTestCloudArtifacts('lambdatest', 'session-1', auth);

  assert.equal(result?.status, 'pending');
  assert.equal(result?.message, 'LambdaTest artifacts are not ready yet.');
});

test('LambdaTest session details report a non-JSON response with its HTTP status', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html>maintenance</html>', { status: 200 })),
  );

  await assert.rejects(listLambdaTestCloudArtifacts('lambdatest', 'session-1', auth), (error) =>
    assertCommandFailedWithStatus(error, 200),
  );
});

function assertCommandFailedWithStatus(error: unknown, status: number): true {
  assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
  assert.equal((error as { details?: { status?: number } }).details?.status, status);
  return true;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
