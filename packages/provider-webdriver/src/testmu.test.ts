import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  TESTMU_DEFAULT_APPIUM_VERSION,
  buildTestMuCapabilities,
  createTestMuUploadApp,
  listTestMuCloudArtifacts,
  uploadTestMuApp,
  uploadTestMuAppFromUrl,
} from './testmu.ts';
import { buildCloudWebDriverBaseCapabilities } from './runtime.ts';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';

const realFetch = globalThis.fetch;
const auth = { clientVersion: '0.0.0-test', username: 'user', accessKey: 'key' };

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
});

// `isRealMobile: false` is the one capability that routes to the emulator/simulator pool; a
// session without it lands on a real device and bills differently.
test('TestMu capabilities select the virtual-device pool and keep vendor keys in lt:options', () => {
  const capabilities = buildTestMuCapabilities({
    platform: 'android',
    deviceName: 'Pixel 8',
    osVersion: '14',
    app: 'lt://APP1',
    projectName: 'agent-device',
    buildName: 'run-1',
    sessionName: 'lease-1',
    deviceFeatures: { geoLocation: 'US' },
    configured: buildCloudWebDriverBaseCapabilities('android', 'Pixel 8'),
  });

  assert.deepEqual(capabilities, {
    platformName: 'Android',
    'appium:deviceName': 'Pixel 8',
    'appium:platformVersion': '14',
    'appium:app': 'lt://APP1',
    'lt:options': {
      isRealMobile: false,
      w3c: true,
      platformName: 'Android',
      deviceName: 'Pixel 8',
      platformVersion: '14',
      app: 'lt://APP1',
      project: 'agent-device',
      build: 'run-1',
      name: 'lease-1',
      appiumVersion: TESTMU_DEFAULT_APPIUM_VERSION,
      video: true,
      devicelog: true,
      geoLocation: 'US',
    },
  });
  for (const key of Object.keys(capabilities)) {
    assert.ok(
      key === 'platformName' || key.startsWith('appium:') || key === 'lt:options',
      `legacy top-level key ${key} would make the hub ignore lt:options`,
    );
  }
});

test('a configured lt:options merges per key and a pinned Appium version wins over latest', () => {
  const capabilities = buildTestMuCapabilities({
    platform: 'ios',
    deviceName: 'iPhone 16',
    osVersion: '18.0',
    buildName: 'run-1',
    sessionName: 'lease-1',
    deviceFeatures: { appiumVersion: '2.16.2' },
    configured: { 'lt:options': { tunnel: true } },
  });
  const ltOptions = capabilities['lt:options'] as Record<string, unknown>;
  assert.equal(ltOptions.appiumVersion, '2.16.2');
  assert.equal(ltOptions.tunnel, true);
  assert.equal(ltOptions.build, 'run-1');
  assert.equal(ltOptions.platformName, 'iOS');
  assert.equal('appium:app' in capabilities, false);
});

test('a configured lt:options cannot turn off the W3C dialect', () => {
  const capabilities = buildTestMuCapabilities({
    platform: 'android',
    deviceName: 'Pixel 8',
    osVersion: '14',
    buildName: 'run-1',
    sessionName: 'lease-1',
    configured: { 'lt:options': { w3c: false, tunnel: true } },
  });
  const ltOptions = capabilities['lt:options'] as Record<string, unknown>;
  assert.equal(ltOptions.w3c, true);
  assert.equal(ltOptions.tunnel, true);
});

// A configured `isRealMobile` would silently move the session to the other pool, which bills
// differently.
test('the device type selects the TestMu pool and a configured lt:options cannot override it', () => {
  const base = {
    platform: 'ios' as const,
    deviceName: 'iPhone 16',
    osVersion: '18',
    buildName: 'run-1',
    sessionName: 'lease-1',
  };
  const real = buildTestMuCapabilities({
    ...base,
    deviceType: 'real',
    configured: { 'lt:options': { isRealMobile: false, tunnel: true } },
  });
  const realOptions = real['lt:options'] as Record<string, unknown>;
  assert.equal(realOptions.isRealMobile, true);
  assert.equal(realOptions.tunnel, true);
  assert.equal(realOptions.platformVersion, '18');

  const virtual = buildTestMuCapabilities({
    ...base,
    deviceType: 'virtual',
    configured: { 'lt:options': { isRealMobile: true } },
  });
  assert.equal((virtual['lt:options'] as Record<string, unknown>).isRealMobile, false);

  const unset = buildTestMuCapabilities(base);
  assert.equal((unset['lt:options'] as Record<string, unknown>).isRealMobile, false);
});

test('TestMu uploads go to the upload API of the selected device pool', async () => {
  const tempDir = await mkdtempForTest('agent-device-testmu-upload-pool-');
  const appPath = path.join(tempDir, 'MyApp.ipa');
  const endpoints: string[] = [];
  try {
    await fs.writeFile(appPath, 'placeholder');
    globalThis.fetch = async (input) => {
      endpoints.push(String(input));
      return jsonResponse({ app_url: 'lt://APP1' });
    };
    await uploadTestMuApp(appPath, { ...auth, deviceType: 'real' });
    await uploadTestMuAppFromUrl('https://example.test/App.apk', { ...auth, deviceType: 'real' });
    await uploadTestMuApp(appPath, auth);
    await uploadTestMuApp(appPath, { ...auth, deviceType: 'virtual' });
    await uploadTestMuApp(appPath, {
      ...auth,
      deviceType: 'real',
      endpoint: 'https://upload.test/real',
    });
    assert.deepEqual(endpoints, [
      'https://manual-api.lambdatest.com/app/upload/realDevice',
      'https://manual-api.lambdatest.com/app/upload/realDevice',
      'https://manual-api.lambdatest.com/app/upload/virtualDevice',
      'https://manual-api.lambdatest.com/app/upload/virtualDevice',
      'https://upload.test/real',
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('a real-device upload of an .app directory asks for a signed .ipa', async () => {
  const tempDir = await mkdtempForTest('agent-device-testmu-real-app-dir-');
  const appPath = path.join(tempDir, 'Demo.app');
  try {
    await fs.mkdir(appPath);
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
    await assert.rejects(
      uploadTestMuApp(appPath, { ...auth, deviceType: 'real' }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.match(String(error.details?.hint), /signed \.ipa/);
        return true;
      },
    );
    assert.equal(fetchMock.mock.calls.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('TestMu upload reads the lt:// reference and aborts while the request is in flight', async () => {
  const tempDir = await mkdtempForTest('agent-device-testmu-upload-');
  const appPath = path.join(tempDir, 'App.apk');
  const controller = new AbortController();
  const abortReason = new Error('request cancelled during TestMu AI upload');
  try {
    await fs.writeFile(appPath, 'placeholder');
    globalThis.fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        assert.equal(init?.signal, controller.signal);
        if (init?.signal?.aborted) {
          reject(init.signal.reason);
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });

    const pending = uploadTestMuApp(appPath, auth, controller.signal);
    await Promise.resolve();
    controller.abort(abortReason);
    await assert.rejects(pending, (error: unknown) => error === abortReason);

    globalThis.fetch = async (_input, init) => {
      const body = init?.body as FormData;
      assert.ok(body.get('appFile') instanceof Blob);
      assert.equal(body.get('name'), 'App');
      return jsonResponse({ app_id: 'APP123', name: 'App' });
    };
    assert.equal(await uploadTestMuApp(appPath, auth), 'lt://APP123');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// iOS simulator builds are `.app` directories; the upload API only takes a file.
test('TestMu upload rejects an unzipped .app bundle before calling the upload API', async () => {
  const tempDir = await mkdtempForTest('agent-device-testmu-app-dir-');
  const appPath = path.join(tempDir, 'Demo.app');
  try {
    await fs.mkdir(appPath);
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
    await assert.rejects(uploadTestMuApp(appPath, auth), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(String(error.details?.hint), /[Zz]ip the \.app bundle/);
      return true;
    });
    assert.equal(fetchMock.mock.calls.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('the install adapter uploads the local build and launches the hinted app id', async () => {
  const tempDir = await mkdtempForTest('agent-device-testmu-install-');
  const appPath = path.join(tempDir, 'Demo.apk');
  try {
    await fs.writeFile(appPath, 'placeholder');
    globalThis.fetch = async () => jsonResponse({ app_url: 'lt://APP77' });
    const uploadApp = createTestMuUploadApp(auth);
    const result = await uploadApp({
      provider: 'testmu',
      lease: {} as never,
      device: {} as never,
      app: 'com.example.demo',
      appPath,
      options: { packageNameHint: 'com.example.demo' },
    });
    assert.deepEqual(result, {
      appReference: 'lt://APP77',
      bundleId: undefined,
      packageName: 'com.example.demo',
      launchTarget: 'com.example.demo',
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('TestMu URL upload hands the URL to the upload API and surfaces a failed upload', async () => {
  globalThis.fetch = async (_input, init) => {
    const body = init?.body as FormData;
    assert.equal(body.get('url'), 'https://example.test/builds/App.apk');
    assert.equal(body.get('storage'), 'url');
    assert.equal(body.get('name'), 'App.apk');
    assert.equal(body.get('appFile'), null);
    return jsonResponse({ app_url: 'lt://APP9' });
  };
  assert.equal(
    await uploadTestMuAppFromUrl('https://example.test/builds/App.apk', auth),
    'lt://APP9',
  );

  globalThis.fetch = async () => jsonResponse({ message: 'invalid app' }, 400);
  await assert.rejects(
    uploadTestMuAppFromUrl('https://example.test/builds/App.apk', auth),
    (error: unknown) =>
      error instanceof AppError && error.code === 'COMMAND_FAILED' && error.details?.status === 400,
  );
});

test('TestMu artifacts come from the jsend session payload and stay pending until a URL exists', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string | undefined>;
    assert.match(String(headers.Authorization), /^Basic /);
    return jsonResponse({
      status: 'success',
      data: {
        test_id: 'SESSION1',
        video_url: 'https://cdn.test/video.mp4',
        appium_logs_url: 'https://api.test/sessions/SESSION1/log/appium',
        device_logs_url: '',
      },
    });
  };
  const result = await listTestMuCloudArtifacts('testmu', 'SESSION1', {
    ...auth,
    endpoint: 'https://api.test/mobile-automation/api/v1/',
  });
  assert.deepEqual(calls, ['https://api.test/mobile-automation/api/v1/sessions/SESSION1']);
  assert.equal(result?.status, 'ready');
  assert.deepEqual(
    result?.cloudArtifacts.map((artifact) => [artifact.kind, artifact.url]),
    [
      ['video', 'https://cdn.test/video.mp4'],
      ['appium-log', 'https://api.test/sessions/SESSION1/log/appium'],
      ['provider-session', 'https://appautomation.lambdatest.com/test?testID=SESSION1'],
    ],
  );

  globalThis.fetch = async () => jsonResponse({ status: 'success', data: { test_id: 'SESSION1' } });
  const pending = await listTestMuCloudArtifacts('testmu', 'SESSION1', auth);
  assert.equal(pending?.status, 'pending');
  assert.deepEqual(pending?.cloudArtifacts, []);
});

// Virtual-device session details carry the device log as `console_logs_url`.
test('TestMu reads the console log as the device log and falls back to device_logs_url', async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      status: 'success',
      data: {
        console_logs_url: 'https://api.test/sessions/SESSION1/log/console',
        device_logs_url: 'https://api.test/sessions/SESSION1/log/device',
      },
    });
  const consoleLog = await listTestMuCloudArtifacts('testmu', 'SESSION1', auth);
  assert.deepEqual(
    consoleLog?.cloudArtifacts
      .filter((artifact) => artifact.kind === 'device-log')
      .map((artifact) => artifact.url),
    ['https://api.test/sessions/SESSION1/log/console'],
  );

  globalThis.fetch = async () =>
    jsonResponse({
      status: 'success',
      data: { device_logs_url: 'https://api.test/sessions/SESSION1/log/device' },
    });
  const deviceLog = await listTestMuCloudArtifacts('testmu', 'SESSION1', auth);
  assert.deepEqual(
    deviceLog?.cloudArtifacts
      .filter((artifact) => artifact.kind === 'device-log')
      .map((artifact) => artifact.url),
    ['https://api.test/sessions/SESSION1/log/device'],
  );
});

test('TestMu session details read as pending on 404 and fail typed on a body that is not JSON', async () => {
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    signal = init?.signal ?? undefined;
    return jsonResponse({ status: 'fail', message: 'session not found' }, 404);
  };
  const notFound = await listTestMuCloudArtifacts('testmu', 'SESSION1', auth);
  assert.equal(notFound?.status, 'pending');
  assert.deepEqual(notFound?.cloudArtifacts, []);
  assert.ok(signal instanceof AbortSignal, 'session details lookup should carry a timeout');

  globalThis.fetch = async () => new Response('<html>Bad Gateway</html>', { status: 502 });
  await assert.rejects(
    listTestMuCloudArtifacts('testmu', 'SESSION1', auth),
    (error: unknown) =>
      error instanceof AppError && error.code === 'COMMAND_FAILED' && error.details?.status === 502,
  );

  globalThis.fetch = async () => new Response('', { status: 200 });
  await assert.rejects(
    listTestMuCloudArtifacts('testmu', 'SESSION1', auth),
    (error: unknown) =>
      error instanceof AppError && error.code === 'COMMAND_FAILED' && error.details?.status === 200,
  );
});

test('TestMu session details require the jsend data envelope', async () => {
  globalThis.fetch = async () => jsonResponse({ video_url: 'https://cdn.test/video.mp4' });
  await assert.rejects(
    listTestMuCloudArtifacts('testmu', 'SESSION1', auth),
    (error: unknown) => error instanceof AppError && error.code === 'COMMAND_FAILED',
  );
});

test('TestMu upload reports the HTTP status when the response is not JSON', async () => {
  globalThis.fetch = async () => new Response('<html>Bad Gateway</html>', { status: 502 });
  await assert.rejects(
    uploadTestMuAppFromUrl('https://example.test/builds/App.apk', auth),
    (error: unknown) =>
      error instanceof AppError && error.code === 'COMMAND_FAILED' && error.details?.status === 502,
  );

  globalThis.fetch = async () => new Response('', { status: 200 });
  await assert.rejects(
    uploadTestMuAppFromUrl('https://example.test/builds/App.apk', auth),
    (error: unknown) =>
      error instanceof AppError && error.code === 'COMMAND_FAILED' && error.details?.status === 200,
  );
});

test('TestMu session details lookup types a timeout and a network failure', async () => {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  globalThis.fetch = async () => {
    throw timeout;
  };
  await assert.rejects(listTestMuCloudArtifacts('testmu', 'SESSION1', auth), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.match(error.message, /TestMu AI session details lookup failed/);
    assert.match(String(error.details?.hint), /retry/);
    assert.equal(error.cause, timeout);
    return true;
  });

  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    listTestMuCloudArtifacts('testmu', 'SESSION1', auth),
    (error: unknown) => error instanceof AppError && error.code === 'COMMAND_FAILED',
  );
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
