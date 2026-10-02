import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import { basicAuthHeader } from './webdriver-utils.ts';
import type {
  CloudWebDriverConnectionVerification,
  CloudWebDriverConnectionVerificationOptions,
} from './connection-verification.ts';
import type { ProviderConnectionResource } from '@agent-device/contracts/remote';

const LAMBDATEST_CONCURRENCY_ENDPOINT =
  'https://mobile-api.lambdatest.com/mobile-automation/api/v1/org/concurrency';

type LambdaTestOptions = Extract<
  CloudWebDriverConnectionVerificationOptions,
  { provider: 'lambdatest' }
>;

export async function verifyLambdaTestConnection(
  options: LambdaTestOptions,
  clientVersion: string,
): Promise<CloudWebDriverConnectionVerification> {
  const app = verifyLambdaTestApp(options.app);
  await fetchLambdaTestConcurrency(
    options.concurrencyEndpoint ?? LAMBDATEST_CONCURRENCY_ENDPOINT,
    { username: options.username, accessKey: options.accessKey },
    clientVersion,
  );
  return {
    provider: 'lambdatest',
    service: 'LambdaTest',
    verificationMessage:
      'Credentials verified; LambdaTest checks the device, OS version, and app when creating the session.',
    device: {
      status: 'deferred',
      name: options.deviceName,
      platform: options.platform,
      osVersion: options.osVersion,
    },
    app,
  };
}

function verifyLambdaTestApp(app: string): ProviderConnectionResource {
  if (app.startsWith('lt://')) {
    if (!/^lt:\/\/[\w-]+$/.test(app)) {
      throw new AppError('INVALID_ARGS', `LambdaTest app reference "${app}" is malformed.`, {
        hint: 'Pass the lt:// app_url returned by the LambdaTest app upload API.',
      });
    }
    return {
      status: 'configured',
      reference: app,
      message: 'LambdaTest validates the app reference when creating the session.',
    };
  }
  if (/^https?:\/\//i.test(app)) {
    return {
      status: 'configured',
      reference: app,
      message: 'Public app URL configured; it is uploaded to LambdaTest when creating the session.',
    };
  }
  return {
    status: 'configured',
    name: path.basename(app),
    reference: app,
    message: 'Local app artifact is ready and will be uploaded when creating the session.',
  };
}

async function fetchLambdaTestConcurrency(
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
        'LambdaTest rejected connection verification.',
        {
          status: response.status,
          hint: unauthorized
            ? 'Check LT_USERNAME and LT_ACCESS_KEY.'
            : 'Retry connect or check the LambdaTest service status.',
        },
      );
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'COMMAND_FAILED',
      'LambdaTest connection verification failed.',
      { hint: 'Check network access to mobile-api.lambdatest.com and retry connect.' },
      error,
    );
  }
}
