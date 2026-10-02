import fs from 'node:fs/promises';
import path from 'node:path';
import type { CloudArtifact, CloudArtifactsResult } from '@agent-device/contracts/observability';
import type { CloudWebDriverPlatform, CloudWebDriverUploadApp } from './runtime.ts';
import { AppError } from '@agent-device/kernel/errors';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import { cloudArtifactsReadyOrPending } from './artifact-results.ts';
import { basicAuthHeader, trimTrailingSlash } from './webdriver-utils.ts';

export const TESTMU_APP_UPLOAD_ENDPOINT =
  'https://manual-api.lambdatest.com/app/upload/virtualDevice';
const TESTMU_SESSION_DETAILS_ENDPOINT =
  'https://mobile-api.lambdatest.com/mobile-automation/api/v1/sessions';
export type TestMuCapabilitiesOptions = {
  platform: CloudWebDriverPlatform;
  deviceName: string;
  osVersion: string;
  app: string;
  projectName?: string;
  buildName: string;
  sessionName: string;
  configured?: Record<string, unknown>;
};

export type TestMuApiOptions = {
  clientVersion: string;
  username: string;
  accessKey: string;
  endpoint?: string | URL;
};

export async function listTestMuCloudArtifacts(
  provider: string,
  providerSessionId: string | undefined,
  options: TestMuApiOptions,
): Promise<CloudArtifactsResult | undefined> {
  if (!providerSessionId) return undefined;
  const details = await fetchTestMuSessionDetails(providerSessionId, options);
  return cloudArtifactsReadyOrPending({
    provider,
    providerSessionId,
    artifacts: mapTestMuArtifacts(provider, providerSessionId, details),
    pendingMessage: 'TestMu AI artifacts are not ready yet.',
  });
}

/** Uploads a local app file, or an HTTP(S) app URL by reference, and returns its `lt://` id. */
export async function uploadTestMuApp(
  app: string,
  options: TestMuApiOptions,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const form = new FormData();
  if (isHttpUrl(app)) {
    form.set('url', app);
    form.set('storage', 'url');
    form.set('name', path.posix.basename(new URL(app).pathname) || 'app');
  } else {
    const file = await fs.readFile(app);
    form.set('appFile', new Blob([file]), path.basename(app));
    form.set('name', path.basename(app));
  }
  const response = await fetch(options.endpoint ?? TESTMU_APP_UPLOAD_ENDPOINT, {
    method: 'POST',
    headers: {
      ...agentDeviceRequestHeaders(options.clientVersion),
      Authorization: basicAuthHeader(options),
    },
    body: form,
    signal,
  });
  const json = await readTestMuJson(response, 'app upload');
  const appUrl = readTestMuAppUrl(json);
  if (!response.ok || !appUrl) {
    throw new AppError('COMMAND_FAILED', 'TestMu AI app upload failed.', {
      status: response.status,
      response: json,
    });
  }
  return appUrl;
}

export function createTestMuUploadApp(
  options: Required<TestMuApiOptions>,
): CloudWebDriverUploadApp {
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
 * Builds the W3C `alwaysMatch` capabilities for a TestMu AI App Automation session, in the shape
 * TestMu AI documents for emulators and simulators: `platformName` at the top level and every
 * selector and label inside `lt:options`.
 */
export function buildTestMuCapabilities(
  options: TestMuCapabilitiesOptions,
): Record<string, unknown> {
  const { 'lt:options': configuredLtOptions, ...configured } = options.configured ?? {};
  const platformName = options.platform === 'ios' ? 'iOS' : 'Android';
  return {
    platformName,
    ...configured,
    'lt:options': {
      platformName,
      deviceName: options.deviceName,
      platformVersion: options.osVersion,
      app: options.app,
      isRealMobile: false,
      ...(options.projectName ? { project: options.projectName } : {}),
      build: options.buildName,
      name: options.sessionName,
      video: true,
      devicelog: true,
      ...asRecord(configuredLtOptions),
      // TestMu AI's documented W3C capability shape requires it, so a configured value cannot drop it.
      w3c: true,
    },
  };
}

const TESTMU_ARTIFACT_FIELDS: ReadonlyArray<{
  field: string;
  kind: CloudArtifact['kind'];
  name: string;
}> = [
  { field: 'video_url', kind: 'video', name: 'Session video' },
  { field: 'command_logs_url', kind: 'automation-log', name: 'Command logs' },
  { field: 'appium_logs_url', kind: 'appium-log', name: 'Appium logs' },
  { field: 'console_logs_url', kind: 'device-log', name: 'Device console logs' },
  { field: 'network_logs_url', kind: 'raw', name: 'Network logs' },
  { field: 'screenshot_url', kind: 'raw', name: 'Screenshots' },
];

function mapTestMuArtifacts(
  provider: string,
  providerSessionId: string,
  details: Record<string, unknown>,
): CloudArtifact[] {
  return TESTMU_ARTIFACT_FIELDS.flatMap(({ field, kind, name }) => {
    const url = details[field];
    if (typeof url !== 'string' || url.length === 0) return [];
    return [{ provider, providerSessionId, kind, name, url, availability: 'ready' as const }];
  });
}

async function fetchTestMuSessionDetails(
  sessionId: string,
  options: TestMuApiOptions,
): Promise<Record<string, unknown>> {
  const endpoint = new URL(
    `${trimTrailingSlash(String(options.endpoint ?? TESTMU_SESSION_DETAILS_ENDPOINT))}/${encodeURIComponent(sessionId)}`,
  );
  const response = await fetch(endpoint, {
    headers: {
      ...agentDeviceRequestHeaders(options.clientVersion),
      Authorization: basicAuthHeader(options),
    },
  });
  // A session whose details TestMu AI has not published yet reads as pending, not as a failure.
  if (response.status === 404) return {};
  const json = await readTestMuJson(response, 'session details lookup');
  if (!response.ok || !json || typeof json !== 'object') {
    throw new AppError('COMMAND_FAILED', 'TestMu AI session details lookup failed.', {
      status: response.status,
      response: json,
    });
  }
  return asRecord((json as { data?: unknown }).data);
}

async function readTestMuJson(response: Response, action: string): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `TestMu AI ${action} returned a response that is not JSON.`,
      { status: response.status },
      error,
    );
  }
}

function readTestMuAppUrl(value: unknown): string | undefined {
  const record = asRecord(value);
  if (typeof record.app_url === 'string' && record.app_url.length > 0) return record.app_url;
  return typeof record.app_id === 'string' && record.app_id.length > 0
    ? `lt://${record.app_id}`
    : undefined;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
