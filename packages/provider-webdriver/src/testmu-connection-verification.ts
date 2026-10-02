import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import { basicAuthHeader } from './webdriver-utils.ts';
import type {
  CloudWebDriverConnectionVerification,
  CloudWebDriverConnectionVerificationOptions,
} from './connection-verification.ts';
import type { ProviderConnectionResource } from '@agent-device/contracts/remote';

const TESTMU_CONCURRENCY_ENDPOINT =
  'https://mobile-api.lambdatest.com/mobile-automation/api/v1/org/concurrency';

type TestMuOptions = Extract<CloudWebDriverConnectionVerificationOptions, { provider: 'testmu' }>;

export async function verifyTestMuConnection(
  options: TestMuOptions,
  clientVersion: string,
): Promise<CloudWebDriverConnectionVerification> {
  const app = verifyTestMuApp(options.app);
  await fetchTestMuConcurrency(
    options.concurrencyEndpoint ?? TESTMU_CONCURRENCY_ENDPOINT,
    { username: options.username, accessKey: options.accessKey },
    clientVersion,
  );
  return {
    provider: 'testmu',
    service: 'TestMu AI',
    verificationMessage:
      'Credentials verified; TestMu AI checks the device, OS version, and app when creating the session.',
    device: {
      status: 'deferred',
      name: options.deviceName,
      platform: options.platform,
      osVersion: options.osVersion,
    },
    app,
  };
}

function verifyTestMuApp(app: string): ProviderConnectionResource {
  if (app.startsWith('lt://')) {
    if (!/^lt:\/\/[\w-]+$/.test(app)) {
      throw new AppError('INVALID_ARGS', `TestMu AI app reference "${app}" is malformed.`, {
        hint: 'Pass the lt:// app_url returned by the TestMu AI app upload API.',
      });
    }
    return {
      status: 'configured',
      reference: app,
      message: 'TestMu AI validates the app reference when creating the session.',
    };
  }
  if (/^https?:\/\//i.test(app)) {
    return {
      status: 'configured',
      reference: app,
      message: 'Public app URL configured; it is uploaded to TestMu AI when creating the session.',
    };
  }
  return {
    status: 'configured',
    name: path.basename(app),
    reference: app,
    message: 'Local app artifact is ready and will be uploaded when creating the session.',
  };
}

async function fetchTestMuConcurrency(
  endpoint: string | URL,
  auth: { username: string; accessKey: string },
  clientVersion: string,
): Promise<void> {
  try {
    const response = await fetch(endpoint, {
      headers: {
        ...agentDeviceRequestHeaders(clientVersion),
        Authorization: basicAuthHeader(auth),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const unauthorized = response.status === 401 || response.status === 403;
      throw new AppError(
        unauthorized ? 'UNAUTHORIZED' : 'COMMAND_FAILED',
        'TestMu AI rejected connection verification.',
        {
          status: response.status,
          hint: unauthorized
            ? 'Check LT_USERNAME and LT_ACCESS_KEY.'
            : 'Retry connect or check the TestMu AI service status.',
        },
      );
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'COMMAND_FAILED',
      'TestMu AI connection verification failed.',
      { hint: 'Check network access to mobile-api.lambdatest.com and retry connect.' },
      error,
    );
  }
}
