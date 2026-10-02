import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connectCommand } from '../cli/commands/connection.ts';
import { runCliCapture } from './cli-capture.ts';
import {
  readActiveConnectionState,
  type RemoteConnectionState,
} from '../remote/remote-connection-state.ts';
import type { AgentDeviceClient } from '../agent-device-client.ts';
import { resolveCloudWebDriverConnectProfile } from '../cli/connection/cloud-webdriver-profile.ts';
import { AppError } from '@agent-device/kernel/errors';
import { providerWebDriver } from '../provider-webdriver.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

vi.mock('../provider-webdriver.ts', () => ({
  providerWebDriver: { verifyConnection: vi.fn() },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const mockedVerifyWebDriverConnection = vi.mocked(providerWebDriver.verifyConnection);

beforeEach(() => {
  mockedVerifyWebDriverConnection.mockImplementation(async (options) => {
    assert.equal(options.provider, 'testmu');
    return {
      provider: 'testmu',
      service: 'TestMu AI',
      verificationMessage: 'Credentials, device, and uploaded app verified.',
      device: {
        status: 'verified',
        name: options.deviceName,
        platform: options.platform,
        osVersion: options.osVersion,
      },
      app: { status: 'verified', reference: options.app },
    };
  });
});

test('connect testmu generates a local provider profile and verifies the virtual device', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-testmu-');
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LT_USERNAME', 'lt-user');
  vi.stubEnv('LT_ACCESS_KEY', 'lt-key');

  try {
    await connectWithGeneratedProviderProfile({
      stateDir,
      positionals: ['testmu'],
      flags: {
        platform: 'ios',
        device: 'iPhone 16',
        providerOsVersion: '18.0',
        providerApp: 'lt://APP1',
        providerBuild: 'build-a',
      },
    });

    assert.deepEqual(mockedVerifyWebDriverConnection.mock.calls[0]?.[0], {
      provider: 'testmu',
      username: 'lt-user',
      accessKey: 'lt-key',
      platform: 'ios',
      deviceName: 'iPhone 16',
      osVersion: '18.0',
      app: 'lt://APP1',
    });
    const state = readRequiredActiveState(stateDir);
    assert.equal(state.tenant, 'testmu');
    assert.equal(state.leaseProvider, 'testmu');
    assert.match(state.remoteConfigPath, /generated\/testmu-[a-f0-9]{16}\.json$/);
    const generated = readGeneratedConfig(state.remoteConfigPath);
    assert.equal(generated.providerApp, 'lt://APP1');
    assert.equal(generated.providerOsVersion, '18.0');
    assert.equal(generated.providerBuild, 'build-a');
    assert.equal(JSON.stringify(generated).includes('lt-key'), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect testmu rejects BrowserStack network and re-sign flags before saving a profile', () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-testmu-reject-');

  try {
    assert.throws(
      () =>
        resolveCloudWebDriverConnectProfile({
          provider: 'testmu',
          stateDir: path.join(tempRoot, '.state'),
          cwd: tempRoot,
          env: { LT_USERNAME: 'lt-user', LT_ACCESS_KEY: 'lt-key' },
          flags: {
            json: false,
            help: false,
            version: false,
            platform: 'ios',
            device: 'iPhone 16',
            providerOsVersion: '18.0',
            providerApp: 'lt://APP1',
            providerNetworkProfile: '3g-lossy',
            providerNoResignApp: true,
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.match(error.message, /not supported by TestMu AI/);
        assert.deepEqual(error.details?.flags, [
          '--provider-network-profile',
          '--provider-no-resign-app',
        ]);
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(tempRoot, '.state')), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect testmu stores and verifies the real-device pool', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-testmu-real-');
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LT_USERNAME', 'lt-user');
  vi.stubEnv('LT_ACCESS_KEY', 'lt-key');

  try {
    await connectWithGeneratedProviderProfile({
      stateDir,
      positionals: ['testmu'],
      flags: {
        platform: 'ios',
        device: 'iPhone 16',
        providerOsVersion: '18',
        providerDeviceType: 'real',
        providerApp: 'lt://APP1',
      },
    });

    assert.deepEqual(mockedVerifyWebDriverConnection.mock.calls[0]?.[0], {
      provider: 'testmu',
      username: 'lt-user',
      accessKey: 'lt-key',
      platform: 'ios',
      deviceName: 'iPhone 16',
      osVersion: '18',
      app: 'lt://APP1',
      deviceType: 'real',
    });
    const state = readRequiredActiveState(stateDir);
    const generated = readGeneratedConfig(state.remoteConfigPath);
    assert.equal(generated.providerDeviceType, 'real');
    assert.equal(generated.providerOsVersion, '18');

    // The saved profile reproduces the same verification when it is loaded again.
    mockedVerifyWebDriverConnection.mockClear();
    await connectWithGeneratedProviderProfile({
      stateDir,
      positionals: [],
      flags: { remoteConfig: state.remoteConfigPath, force: true },
    });
    const reloaded = mockedVerifyWebDriverConnection.mock.calls[0]?.[0];
    assert.equal(reloaded?.provider, 'testmu');
    assert.equal(reloaded.deviceType, 'real');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('providers other than TestMu refuse --provider-device-type before saving a profile', () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-device-type-reject-');
  const base = { json: false, help: false, version: false, platform: 'android' as const };

  try {
    for (const [provider, flags, env] of [
      [
        'browserstack',
        {
          ...base,
          device: 'Google Pixel 8',
          providerOsVersion: '14.0',
          providerApp: 'bs://app-id',
        },
        { BROWSERSTACK_USERNAME: 'u', BROWSERSTACK_ACCESS_KEY: 'k' },
      ],
      [
        'aws-device-farm',
        {
          ...base,
          awsProjectArn: 'arn:aws:devicefarm:us-west-2:123:project/p',
          awsDeviceArn: 'arn:aws:devicefarm:us-west-2::device/d',
        },
        {},
      ],
    ] as const) {
      assert.throws(
        () =>
          resolveCloudWebDriverConnectProfile({
            provider,
            stateDir: path.join(tempRoot, '.state'),
            cwd: tempRoot,
            env,
            flags: { ...flags, providerDeviceType: 'real' },
          }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'INVALID_ARGS');
          assert.match(
            error.message,
            new RegExp(`--provider-device-type is only supported by TestMu AI, not ${provider}`),
          );
          return true;
        },
      );
    }
    assert.equal(fs.existsSync(path.join(tempRoot, '.state')), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('connect limrun refuses the TestMu device type', async () => {
  const result = await runCliCapture(
    ['connect', 'limrun', '--platform', 'ios', '--provider-device-type', 'real', '--json'],
    {
      env: { LIMRUN_API_KEY: 'lim_test_key' },
      stateDirPrefix: 'agent-device-connect-limrun-device-type-',
    },
  );
  assert.equal(result.code, 1);
  assert.match(result.stdout, /--provider-device-type is only supported by TestMu AI, not limrun/);
});

async function connectWithGeneratedProviderProfile(options: {
  stateDir: string;
  positionals: string[];
  flags: Partial<Parameters<typeof connectCommand>[0]['flags']>;
}): Promise<void> {
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await connectCommand({
      positionals: options.positionals,
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir: options.stateDir,
        ...options.flags,
      },
      client: {} as AgentDeviceClient,
    });
  } finally {
    stdoutWrite.mockRestore();
  }
}

function readGeneratedConfig(configPath: string): {
  providerApp?: string;
  providerOsVersion?: string;
  providerDeviceType?: string;
  providerBuild?: string;
} {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    providerApp?: string;
    providerOsVersion?: string;
    providerDeviceType?: string;
    providerBuild?: string;
  };
}

function readRequiredActiveState(stateDir: string): RemoteConnectionState {
  const state = readActiveConnectionState({ stateDir });
  assert.ok(state);
  return state;
}
