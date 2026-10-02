import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { fetchProviderVerificationJson, trimTrailingSlash } from './webdriver-utils.ts';
import { TESTMU_API_ENDPOINT, TESTMU_APPS_ENDPOINT, isTestMuAppReference } from './testmu.ts';
import type {
  CloudWebDriverConnectionVerification,
  CloudWebDriverConnectionVerificationOptions,
} from './connection-verification.ts';
import type { ProviderConnectionResource } from '@agent-device/contracts/remote';

type TestMuOptions = Extract<CloudWebDriverConnectionVerificationOptions, { provider: 'testmu' }>;

type TestMuAuth = { username: string; accessKey: string };

/**
 * Verifies a TestMu virtual-device selection without creating a session: the public capability
 * catalog confirms the device/OS pair exists in the emulator and simulator pool, and the
 * authenticated app listing confirms the credentials and, for an `lt://` reference, the upload.
 */
export async function verifyTestMuConnection(
  options: TestMuOptions,
  clientVersion: string,
): Promise<CloudWebDriverConnectionVerification> {
  const auth = { username: options.username, accessKey: options.accessKey };
  const catalog = await fetchTestMuJson(
    options.devicesEndpoint ??
      `${trimTrailingSlash(TESTMU_API_ENDPOINT)}/capability/generator?isVirtualDevice=true`,
    undefined,
    clientVersion,
  );
  const namedDevices = readTestMuVirtualDevices(catalog, options.platform).filter(
    (device) => device.name === options.deviceName,
  );
  // Exact match on purpose: the hub rejects `18` for a device the catalog lists as `18.0`.
  const matchedDevice = namedDevices.find((device) =>
    device.osVersions.includes(options.osVersion),
  );
  if (!matchedDevice) {
    const offered = [...new Set(namedDevices.flatMap((device) => device.osVersions))].sort(
      (left, right) => left.localeCompare(right, undefined, { numeric: true }),
    );
    throw new AppError(
      'INVALID_ARGS',
      `TestMu virtual device "${options.deviceName}" with ${options.platform} ${options.osVersion} is not available${
        offered.length > 0 ? `; ${options.deviceName} offers ${offered.join(', ')}` : ''
      }.`,
      {
        hint: 'Choose an exact device name and OS version from the TestMu virtual-device capability generator.',
        ...(offered.length > 0 ? { availableOsVersions: offered } : {}),
      },
    );
  }

  const app = await verifyTestMuApp(options, auth, clientVersion);
  return {
    provider: 'testmu',
    service: 'TestMu',
    verificationMessage:
      app.status === 'verified'
        ? 'Credentials, virtual device, and uploaded app verified.'
        : 'Credentials and virtual device verified; app availability is checked when the session is created.',
    device: {
      status: 'verified',
      name: matchedDevice.name,
      platform: options.platform,
      osVersion: options.osVersion,
    },
    app,
  };
}

async function verifyTestMuApp(
  options: TestMuOptions,
  auth: TestMuAuth,
  clientVersion: string,
): Promise<ProviderConnectionResource> {
  const { app } = options;
  // The listing is authenticated, so it doubles as the credential check for every app kind.
  const apps = await fetchTestMuJson(
    `${options.appsEndpoint ?? TESTMU_APPS_ENDPOINT}?type=${options.platform}&level=user`,
    auth,
    clientVersion,
  );
  if (isTestMuAppReference(app)) {
    const matched = readTestMuApps(apps).find((entry) => entry.reference === app);
    if (!matched) {
      return {
        status: 'configured',
        reference: app,
        message:
          'App reference was not found among your uploaded apps; TestMu validates it when creating the session.',
      };
    }
    return { status: 'verified', ...matched };
  }
  if (/^https?:\/\//i.test(app)) {
    return {
      status: 'configured',
      reference: app,
      message: 'Public app URL configured; TestMu fetches it when creating the session.',
    };
  }
  return {
    status: 'configured',
    name: path.basename(app),
    reference: app,
    message: 'Local app artifact is ready and will be uploaded when creating the session.',
  };
}

async function fetchTestMuJson(
  endpoint: string | URL,
  auth: TestMuAuth | undefined,
  clientVersion: string,
): Promise<unknown> {
  return await fetchProviderVerificationJson(endpoint, {
    clientVersion,
    auth,
    hints: {
      service: 'TestMu',
      unauthorizedHint: 'Check LT_USERNAME and LT_ACCESS_KEY.',
      networkHint:
        'Check network access to mobile-api.lambdatest.com and manual-api.lambdatest.com, then retry connect.',
    },
  });
}

/**
 * The capability generator lists virtual devices per platform under
 * `app.devices.<platform>.brands.<brand>[]` as `{ name, osVersion: string[] }`.
 */
function readTestMuVirtualDevices(
  value: unknown,
  platform: 'android' | 'ios',
): Array<{ name: string; osVersions: string[] }> {
  const brands = asRecord(asRecord(asRecord(asRecord(value)?.app)?.devices)?.[platform])?.brands;
  const brandRecord = asRecord(brands);
  if (!brandRecord) {
    throw new AppError(
      'COMMAND_FAILED',
      'TestMu virtual-device catalog response did not list devices for the platform.',
      { platform },
    );
  }
  return Object.values(brandRecord).flatMap((devices) => {
    if (!Array.isArray(devices)) return [];
    return devices.flatMap((entry) => {
      const record = asRecord(entry);
      if (!record || typeof record.name !== 'string' || !Array.isArray(record.osVersion)) return [];
      const osVersions = record.osVersion.flatMap((osVersion) =>
        typeof osVersion === 'string' || typeof osVersion === 'number' ? [String(osVersion)] : [],
      );
      return [{ name: record.name, osVersions }];
    });
  });
}

/** `/app/data` answers `{ data: [{ app_id, name, version, ... }], metaData }`. */
function readTestMuApps(
  value: unknown,
): Array<{ name?: string; reference: string; version?: string }> {
  const record = asRecord(value);
  const data = record?.data;
  if (!Array.isArray(data)) {
    throw new AppError('COMMAND_FAILED', 'TestMu app listing response was not a list.');
  }
  return data.flatMap((entry) => {
    const app = asRecord(entry);
    if (!app || typeof app.app_id !== 'string') return [];
    const reference = isTestMuAppReference(app.app_id) ? app.app_id : `lt://${app.app_id}`;
    return [
      {
        reference,
        ...(typeof app.name === 'string' ? { name: app.name } : {}),
        ...(typeof app.version === 'string' ? { version: app.version } : {}),
      },
    ];
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
