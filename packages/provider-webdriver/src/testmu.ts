import fs from 'node:fs/promises';
import path from 'node:path';
import type { CloudArtifact, CloudArtifactsResult } from '@agent-device/contracts/observability';
import type { ProviderDeviceType } from '@agent-device/contracts/remote';
import type { CloudWebDriverPlatform, CloudWebDriverUploadApp } from './runtime.ts';
import { AppError } from '@agent-device/kernel/errors';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import { cloudArtifactsReadyOrPending, urlArtifactFromDetails } from './artifact-results.ts';
import {
  basicAuthHeader,
  fetchProviderSessionDetails,
  readProviderJsonBody,
  trimTrailingSlash,
} from './webdriver-utils.ts';

/**
 * TestMu session, upload, and artifact mechanics. Loaded on demand by the provider definition;
 * `isRealMobile` in `lt:options` is what routes a session to the real or virtual device pool, and
 * the hostnames still carry the lambdatest.com brand.
 */
const TESTMU_APP_UPLOAD_ENDPOINTS: Record<ProviderDeviceType, string> = {
  real: 'https://manual-api.lambdatest.com/app/upload/realDevice',
  virtual: 'https://manual-api.lambdatest.com/app/upload/virtualDevice',
};
export const TESTMU_APPS_ENDPOINT = 'https://manual-api.lambdatest.com/app/data';
export const TESTMU_API_ENDPOINT = 'https://mobile-api.lambdatest.com/mobile-automation/api/v1';
const TESTMU_DASHBOARD_TEST_URL = 'https://appautomation.lambdatest.com/test?testID=';
const TESTMU_API_TIMEOUT_MS = 15_000;
/** The Appium alias TestMu resolves to the newest server it hosts for the selected OS version. */
export const TESTMU_DEFAULT_APPIUM_VERSION = 'latest';

export type TestMuCapabilitiesOptions = {
  platform: CloudWebDriverPlatform;
  /** Defaults to `virtual`. */
  deviceType?: ProviderDeviceType;
  deviceName: string;
  osVersion: string;
  app?: string;
  projectName?: string;
  buildName: string;
  sessionName: string;
  /** Vendor device-feature capabilities, already projected onto their `lt:options` keys. */
  deviceFeatures?: Record<string, unknown>;
  configured?: Record<string, unknown>;
};

export type TestMuAuth = {
  username: string;
  accessKey: string;
};

export type TestMuSessionDetailsOptions = TestMuAuth & {
  clientVersion: string;
  endpoint?: string | URL;
};

export async function listTestMuCloudArtifacts(
  provider: string,
  providerSessionId: string | undefined,
  options: TestMuSessionDetailsOptions,
): Promise<CloudArtifactsResult | undefined> {
  if (!providerSessionId) return undefined;
  const details = await fetchTestMuSessionDetails(providerSessionId, options);
  const artifacts = mapTestMuArtifacts(provider, providerSessionId, details);
  return cloudArtifactsReadyOrPending({
    provider,
    providerSessionId,
    artifacts,
    pendingMessage: 'TestMu artifacts are not ready yet.',
  });
}

export type TestMuUploadOptions = TestMuAuth & {
  clientVersion: string;
  /** Selects the pool's upload API when no endpoint override is given; defaults to `virtual`. */
  deviceType?: ProviderDeviceType;
  endpoint?: string | URL;
};

/** Uploads a local `.apk`, `.aab`, `.ipa`, or zipped simulator `.app` and returns its `lt://` reference. */
export async function uploadTestMuApp(
  appPath: string,
  options: TestMuUploadOptions,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!(await fs.stat(appPath)).isFile()) {
    throw new AppError('INVALID_ARGS', `TestMu can only upload an app file: ${appPath}`, {
      appPath,
      hint:
        options.deviceType === 'real'
          ? 'Real iOS devices install a signed .ipa; pass the .ipa file.'
          : 'Zip the .app bundle of an iOS simulator build and pass the .zip.',
    });
  }
  const file = await fs.readFile(appPath);
  const form = new FormData();
  form.set('appFile', new Blob([file]), path.basename(appPath));
  form.set('name', path.parse(appPath).name);
  return await postTestMuUpload(form, options, signal);
}

/** Has TestMu fetch a public app URL itself, returning its `lt://` reference. */
export async function uploadTestMuAppFromUrl(
  url: string,
  options: TestMuUploadOptions,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const form = new FormData();
  form.set('url', url);
  form.set('storage', 'url');
  form.set('name', path.basename(new URL(url).pathname) || 'app');
  return await postTestMuUpload(form, options, signal);
}

async function postTestMuUpload(
  form: FormData,
  options: TestMuUploadOptions,
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = options.endpoint ?? TESTMU_APP_UPLOAD_ENDPOINTS[options.deviceType ?? 'virtual'];
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...agentDeviceRequestHeaders(options.clientVersion),
      Authorization: basicAuthHeader(options),
    },
    body: form,
    signal,
  });
  const json = await readProviderJsonBody(response);
  const appUrl = readTestMuAppReference(json);
  if (!response.ok || !appUrl) {
    throw new AppError('COMMAND_FAILED', 'TestMu app upload failed.', {
      status: response.status,
      response: json,
    });
  }
  return appUrl;
}

export function createTestMuUploadApp(options: TestMuUploadOptions): CloudWebDriverUploadApp {
  return async ({ appPath, options: installOptions, signal }) => {
    const appReference = await uploadTestMuApp(appPath, options, signal);
    return {
      appReference,
      bundleId: installOptions?.appIdentifierHint,
      packageName: installOptions?.packageNameHint,
      launchTarget: installOptions?.appIdentifierHint ?? installOptions?.packageNameHint,
    };
  };
}

/**
 * Builds the W3C `alwaysMatch` capabilities for a TestMu session.
 *
 * Standard Appium keys stay `appium:`-prefixed at the top level; everything TestMu-specific lives
 * in `lt:options`. `isRealMobile` selects a real device or an emulator/simulator, and `w3c: true`
 * keeps the hub on the W3C dialect agent-device speaks. Without an explicit Appium version the hub
 * may start a 1.x server, which lacks the `mobile:` extensions the interactor issues, so `latest`
 * is requested unless the caller pins one.
 */
export function buildTestMuCapabilities(
  options: TestMuCapabilitiesOptions,
): Record<string, unknown> {
  const { 'lt:options': configuredLtOptions, ...configured } = options.configured ?? {};
  const deviceFeatures = options.deviceFeatures ?? {};
  return {
    'appium:deviceName': options.deviceName,
    'appium:platformVersion': options.osVersion,
    ...(options.app ? { 'appium:app': options.app } : {}),
    ...configured,
    // Merged per key, never assigned: a configured `lt:options` must not drop the labels below.
    'lt:options': {
      platformName: options.platform === 'ios' ? 'iOS' : 'Android',
      deviceName: options.deviceName,
      platformVersion: options.osVersion,
      ...(options.app ? { app: options.app } : {}),
      ...(options.projectName ? { project: options.projectName } : {}),
      build: options.buildName,
      name: options.sessionName,
      appiumVersion: TESTMU_DEFAULT_APPIUM_VERSION,
      video: true,
      devicelog: true,
      ...deviceFeatures,
      ...asRecord(configuredLtOptions),
      // A configured value cannot switch the device pool or drop the W3C dialect agent-device speaks.
      isRealMobile: options.deviceType === 'real',
      w3c: true,
    },
  };
}

export function isTestMuAppReference(value: string): boolean {
  return value.startsWith('lt://');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function fetchTestMuSessionDetails(
  sessionId: string,
  options: TestMuSessionDetailsOptions,
): Promise<Record<string, unknown>> {
  const endpoint = new URL(
    `${trimTrailingSlash(String(options.endpoint ?? TESTMU_API_ENDPOINT))}/sessions/${encodeURIComponent(sessionId)}`,
  );
  let json: unknown;
  try {
    json = await fetchProviderSessionDetails(endpoint, {
      clientVersion: options.clientVersion,
      auth: options,
      service: 'TestMu',
      timeoutMs: TESTMU_API_TIMEOUT_MS,
    });
  } catch (error) {
    // Details are published a little after the session ends; until then the API answers 404.
    if (error instanceof AppError && error.details?.status === 404) return {};
    throw error;
  }
  // The API wraps the session in a jsend envelope: `{ status, data: {...}, message }`.
  const details = (json as { data?: unknown }).data;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new AppError('COMMAND_FAILED', 'TestMu session details response had no data.', {
      response: json,
    });
  }
  return details as Record<string, unknown>;
}

function mapTestMuArtifacts(
  provider: string,
  providerSessionId: string,
  details: Record<string, unknown>,
): CloudArtifact[] {
  // Virtual-device sessions report the device log as `console_logs_url`.
  const deviceLogField =
    typeof details.console_logs_url === 'string' && details.console_logs_url.length > 0
      ? 'console_logs_url'
      : 'device_logs_url';
  const fromDetails = (
    [
      ['video_url', 'video', 'Session video'],
      ['appium_logs_url', 'appium-log', 'Appium logs'],
      [deviceLogField, 'device-log', 'Device logs'],
      ['network_logs_url', 'raw', 'Network logs'],
      ['command_logs_url', 'automation-log', 'Command logs'],
      ['screenshot_url', 'raw', 'Screenshots'],
    ] as const
  ).map(([field, kind, name]) =>
    urlArtifactFromDetails(provider, providerSessionId, details, field, kind, name),
  );
  const dashboard: CloudArtifact = {
    provider,
    providerSessionId,
    kind: 'provider-session',
    name: 'TestMu dashboard',
    url: `${TESTMU_DASHBOARD_TEST_URL}${encodeURIComponent(providerSessionId)}`,
    availability: 'ready',
  };
  const ready = fromDetails.filter((artifact): artifact is CloudArtifact => artifact !== undefined);
  // The dashboard link alone does not mean the session finished uploading; keep "pending" until
  // the API reports at least one artifact URL.
  return ready.length > 0 ? [...ready, dashboard] : [];
}

function readTestMuAppReference(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { app_url?: unknown; app_id?: unknown };
  if (typeof record.app_url === 'string' && record.app_url.length > 0) return record.app_url;
  if (typeof record.app_id === 'string' && record.app_id.length > 0) {
    return isTestMuAppReference(record.app_id) ? record.app_id : `lt://${record.app_id}`;
  }
  return undefined;
}
