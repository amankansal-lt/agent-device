import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createProviderWebDriver } from './index.ts';
import type { RunHostCommand } from './dependencies.ts';

const browserStackOptions = {
  provider: 'browserstack' as const,
  username: 'browser-user',
  accessKey: 'browser-key',
  platform: 'android' as const,
  deviceName: 'Google Pixel 8',
  osVersion: '14.0',
  app: 'bs://app-id',
};

const awsResources = {
  project: { arn: 'project-arn', name: 'Agent Device' },
  device: {
    arn: 'device-arn',
    name: 'Google Pixel 8',
    platform: 'ANDROID',
    os: '14',
    availability: 'HIGHLY_AVAILABLE',
  },
  upload: {
    arn: 'app-arn',
    name: 'sample.apk',
    type: 'ANDROID_APP',
    status: 'SUCCEEDED',
  },
};

afterEach(() => vi.unstubAllGlobals());

test('BrowserStack verifies the selected resources without creating a session', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input).includes('devices')
      ? jsonResponse([
          { os: 'android', os_version: '14.0', device: 'Google Pixel 8', realMobile: true },
        ])
      : jsonResponse([{ app_name: 'sample.apk', app_version: '1.2.3', app_url: 'bs://app-id' }]),
  );
  vi.stubGlobal('fetch', fetchMock);

  const result = await createProvider().verifyConnection({
    ...browserStackOptions,
    devicesEndpoint: 'https://browserstack.test/devices',
    appsEndpoint: 'https://browserstack.test/apps',
  });

  assert.equal(result.provider, 'browserstack');
  assert.deepEqual(result.device, {
    status: 'verified',
    name: 'Google Pixel 8',
    platform: 'android',
    osVersion: '14.0',
  });
  assert.deepEqual(result.app, {
    status: 'verified',
    name: 'sample.apk',
    reference: 'bs://app-id',
    version: '1.2.3',
  });
  assert.deepEqual(
    fetchMock.mock.calls.map(([input]) => String(input)),
    ['https://browserstack.test/devices', 'https://browserstack.test/apps'],
  );
});

test('BrowserStack classifies rejected credentials without exposing them', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({}, 401)),
  );

  await assert.rejects(createProvider().verifyConnection(browserStackOptions), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'UNAUTHORIZED');
    assert.doesNotMatch(JSON.stringify(error), /browser-key/);
    return true;
  });
});

test('BrowserStack defers a bs app reference outside the recent upload window', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) =>
      String(input).includes('devices')
        ? jsonResponse([{ os: 'android', os_version: '14', device: 'Google Pixel 8' }])
        : jsonResponse([]),
    ),
  );

  const result = await createProvider().verifyConnection(browserStackOptions);

  assert.deepEqual(result.app, {
    status: 'configured',
    reference: 'bs://app-id',
    message:
      'App reference was not found in the 100 most recent uploads; BrowserStack validates it when creating the session.',
  });
  assert.match(
    result.verificationMessage,
    /app availability is checked when the session is created/,
  );
});

test('BrowserStack accepts an empty-object recent apps response', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) =>
      String(input).includes('devices')
        ? jsonResponse([{ os: 'android', os_version: '14', device: 'Google Pixel 8' }])
        : jsonResponse({}),
    ),
  );

  const result = await createProvider().verifyConnection(browserStackOptions);
  assert.equal(result.app.status, 'configured');
});

test('AWS Device Farm verifies resources without creating a remote access session', async () => {
  const concurrency = { active: 0, max: 0 };
  const runHostCommand = createAwsRunner(awsResources, concurrency);
  const result = await createProvider(runHostCommand).verifyConnection({
    provider: 'aws-device-farm',
    platform: 'android',
    projectArn: 'project-arn',
    deviceArn: 'device-arn',
    appArn: 'app-arn',
    region: 'us-west-2',
  });

  assert.equal(result.provider, 'aws-device-farm');
  if (result.provider !== 'aws-device-farm') return;
  assert.deepEqual(result.project, { name: 'Agent Device', reference: 'project-arn' });
  assert.equal(result.device.name, 'Google Pixel 8');
  assert.equal(result.app.name, 'sample.apk');
  assert.deepEqual(
    runHostCommand.mock.calls.map(([, args]) => args[1]),
    ['get-project', 'get-device', 'get-upload'],
  );
  assert.equal(
    runHostCommand.mock.calls.some(([, args]) => args.includes('create-remote-access-session')),
    false,
  );
  assert.equal(concurrency.max, 3);
});

test('AWS Device Farm reports an unattached app without pretending it is installed', async () => {
  const runHostCommand = createAwsRunner({
    project: awsResources.project,
    device: { ...awsResources.device, platform: 'IOS', name: 'iPhone 15', os: '17' },
  });
  const result = await createProvider(runHostCommand).verifyConnection({
    provider: 'aws-device-farm',
    platform: 'ios',
    projectArn: 'project-arn',
    deviceArn: 'device-arn',
  });

  assert.equal(result.app.status, 'missing');
  assert.match(result.app.message ?? '', /--aws-app-arn/);
  assert.equal(runHostCommand.mock.calls.length, 2);
});

test('AWS Device Farm rejects a device from the wrong platform before allocation', async () => {
  const runHostCommand = createAwsRunner({
    project: awsResources.project,
    device: { ...awsResources.device, platform: 'IOS', name: 'iPhone 15', os: '17' },
  });

  await assert.rejects(
    createProvider(runHostCommand).verifyConnection({
      provider: 'aws-device-farm',
      platform: 'android',
      projectArn: 'project-arn',
      deviceArn: 'device-arn',
    }),
    /is ios, not android/,
  );
  assert.equal(
    runHostCommand.mock.calls.some(([, args]) => args.includes('create-remote-access-session')),
    false,
  );
});

const testMuOptions = {
  provider: 'testmu' as const,
  username: 'lt-user',
  accessKey: 'lt-key',
  platform: 'android' as const,
  deviceName: 'Pixel 8',
  osVersion: '14',
  app: 'lt://APP1',
  devicesEndpoint: 'https://testmu.test/capability/generator?isVirtualDevice=true',
  appsEndpoint: 'https://testmu.test/app/data',
};

const testMuCatalog = {
  app: {
    devices: {
      android: {
        brands: {
          Google: [
            { name: 'Pixel 8', osVersion: ['14', '15'] },
            { name: 'Pixel 4a', osVersion: ['13'] },
          ],
        },
      },
      ios: { brands: { Apple: [{ name: 'iPhone 16', osVersion: ['18.0'] }] } },
    },
  },
};

test('TestMu verifies the virtual device and uploaded app without creating a session', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string | undefined>;
    if (String(input).includes('capability/generator')) {
      assert.equal(headers.Authorization, undefined);
      return jsonResponse(testMuCatalog);
    }
    assert.match(String(headers.Authorization), /^Basic /);
    return jsonResponse({
      data: [{ app_id: 'APP1', name: 'sample.apk', version: '1.2.3', type: 'android' }],
      metaData: { total: 1 },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await createProvider().verifyConnection(testMuOptions);

  assert.equal(result.provider, 'testmu');
  assert.equal(result.service, 'TestMu');
  assert.deepEqual(result.device, {
    status: 'verified',
    name: 'Pixel 8',
    platform: 'android',
    osVersion: '14',
  });
  assert.deepEqual(result.app, {
    status: 'verified',
    name: 'sample.apk',
    reference: 'lt://APP1',
    version: '1.2.3',
  });
  assert.deepEqual(
    fetchMock.mock.calls.map(([input]) => String(input)),
    [
      'https://testmu.test/capability/generator?isVirtualDevice=true',
      'https://testmu.test/app/data?type=android&level=user',
    ],
  );
});

test('TestMu rejects a device or OS version missing from the virtual-device catalog', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => jsonResponse(testMuCatalog)),
  );
  await assert.rejects(
    createProvider().verifyConnection({ ...testMuOptions, osVersion: '12' }),
    (error: unknown) =>
      error instanceof Error && /"Pixel 8" with android 12 is not available/.test(error.message),
  );
  await assert.rejects(
    createProvider().verifyConnection({ ...testMuOptions, platform: 'ios', deviceName: 'Pixel 8' }),
    /is not available/,
  );
});

test('TestMu classifies rejected credentials without exposing them', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) =>
      String(input).includes('capability/generator')
        ? jsonResponse(testMuCatalog)
        : jsonResponse({ message: 'Unauthorized' }, 401),
    ),
  );
  await assert.rejects(createProvider().verifyConnection(testMuOptions), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, 'UNAUTHORIZED');
    assert.doesNotMatch(error.message, /lt-key/);
    return true;
  });
});

test('TestMu defers an lt:// reference it cannot find and a local path it will upload', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) =>
      String(input).includes('capability/generator')
        ? jsonResponse(testMuCatalog)
        : jsonResponse({ data: [], metaData: { total: 0 } }),
    ),
  );
  const unknownApp = await createProvider().verifyConnection(testMuOptions);
  assert.equal(unknownApp.app.status, 'configured');
  assert.equal(unknownApp.app.reference, 'lt://APP1');

  const localApp = await createProvider().verifyConnection({
    ...testMuOptions,
    app: '/tmp/builds/App.apk',
  });
  assert.deepEqual(localApp.app, {
    status: 'configured',
    name: 'App.apk',
    reference: '/tmp/builds/App.apk',
    message: 'Local app artifact is ready and will be uploaded when creating the session.',
  });
});

function createProvider(runHostCommand: RunHostCommand = vi.fn()) {
  return createProviderWebDriver({ clientVersion: '1.2.3', runHostCommand });
}

function createAwsRunner(
  resources: Partial<typeof awsResources>,
  concurrency?: { active: number; max: number },
) {
  return vi.fn<RunHostCommand>(async (_command, args) => {
    if (concurrency) {
      concurrency.active += 1;
      concurrency.max = Math.max(concurrency.max, concurrency.active);
    }
    await Promise.resolve();
    try {
      const resource = resources[String(args[1]).replace('get-', '') as keyof typeof awsResources];
      if (!resource) throw new Error(`Unexpected AWS command: ${args[1]}`);
      return { stdout: JSON.stringify({ [String(args[1]).replace('get-', '')]: resource }) };
    } finally {
      if (concurrency) concurrency.active -= 1;
    }
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
