import fs from 'node:fs';
import path from 'node:path';
import type { CloudArtifactsResult } from '@agent-device/contracts/observability';
import type { LeaseLifecycleContext } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderWebDriverDependencies } from './dependencies.ts';
import {
  AWS_DEVICE_FARM_CAPABILITY_OVERRIDES,
  createAwsCliDeviceFarmClient,
  createAwsDeviceFarmPrepareSession,
  listAwsDeviceFarmCloudArtifacts,
} from './aws-device-farm.ts';
import {
  BROWSERSTACK_APP_AUTOMATE_ENDPOINT,
  BROWSERSTACK_APP_UPLOAD_ENDPOINT,
  BROWSERSTACK_CAPABILITY_OVERRIDES,
  buildBrowserStackCapabilities,
  createBrowserStackUploadApp,
  listBrowserStackCloudArtifacts,
  uploadBrowserStackApp,
} from './browserstack.ts';
import {
  buildBrowserStackDeviceFeatureCapabilities,
  readBrowserStackDeviceFeatureFields,
  rejectBrowserStackOnlyDeviceFeatures,
} from './browserstack-device-features.ts';
import type { LambdaTestApiOptions } from './lambdatest.ts';
import type { CloudWebDriverCapabilityOverrides } from './capabilities.ts';
import { CLOUD_WEBDRIVER_PROVIDERS, type CloudWebDriverKnownProviderName } from './providers.ts';
import { readAwsDeviceFarmRegionFromArn } from './connection-verification.ts';
import {
  buildCloudWebDriverBaseCapabilities,
  createCloudWebDriverRuntime,
  type CloudWebDriverPlatform,
  type CloudWebDriverRuntime,
} from './runtime.ts';

const LAMBDATEST_APPIUM_ENDPOINT = 'https://mobile-hub.lambdatest.com/wd/hub/';
const LAMBDATEST_CAPABILITY_OVERRIDES = {
  install: {
    support: 'partial',
    note: 'Local app artifacts are uploaded to LambdaTest app storage, then installed with Appium.',
  },
  portReverse: {
    support: 'unsupported',
    note: 'Use LambdaTest Tunnel for network tunneling; agent-device port reverse is not available.',
  },
  artifacts: {
    support: 'supported',
    note: 'LambdaTest session details expose provider-hosted video, command, Appium, console, and network logs, and screenshots.',
  },
} as const satisfies CloudWebDriverCapabilityOverrides;

export type DefaultCloudWebDriverArtifactEnv = {
  BROWSERSTACK_USERNAME?: string;
  BROWSERSTACK_ACCESS_KEY?: string;
  BROWSERSTACK_SESSION_DETAILS_ENDPOINT?: string;
  LT_USERNAME?: string;
  LT_ACCESS_KEY?: string;
  LAMBDATEST_SESSION_DETAILS_ENDPOINT?: string;
  AWS_REGION?: string;
  AWS_DEFAULT_REGION?: string;
};

export type DefaultCloudWebDriverProviderRuntimeEnv = DefaultCloudWebDriverArtifactEnv & {
  BROWSERSTACK_WEBDRIVER_ENDPOINT?: string;
  BROWSERSTACK_APP_UPLOAD_ENDPOINT?: string;
  LAMBDATEST_WEBDRIVER_ENDPOINT?: string;
  LAMBDATEST_APP_UPLOAD_ENDPOINT?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN?: string;
  AWS_DEVICE_FARM_PROJECT_ARN?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN?: string;
  AWS_DEVICE_FARM_DEVICE_ARN?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN?: string;
  AWS_DEVICE_FARM_APP_ARN?: string;
};

export type CloudWebDriverProviderDefinition = {
  provider: CloudWebDriverKnownProviderName;
  createRuntime: (env: DefaultCloudWebDriverProviderRuntimeEnv) => CloudWebDriverRuntime;
  listArtifactsFromEnv: (
    providerSessionId: string,
    env: DefaultCloudWebDriverArtifactEnv,
  ) => Promise<CloudArtifactsResult | undefined>;
};

export function createCloudWebDriverProviderDefinitions(
  dependencies: ProviderWebDriverDependencies,
): readonly CloudWebDriverProviderDefinition[] {
  return [
    {
      provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
      createRuntime: (env) =>
        createCloudWebDriverRuntime({
          clientVersion: dependencies.clientVersion,
          provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
          platform: 'android',
          deviceName: 'BrowserStack device',
          endpoint: env.BROWSERSTACK_WEBDRIVER_ENDPOINT ?? BROWSERSTACK_APP_AUTOMATE_ENDPOINT,
          capabilityOverrides: BROWSERSTACK_CAPABILITY_OVERRIDES,
          listArtifacts: async ({ provider, providerSessionId }) => {
            const username = requireEnv(
              env,
              'BROWSERSTACK_USERNAME',
              'BrowserStack artifact lookup',
            );
            const accessKey = requireEnv(
              env,
              'BROWSERSTACK_ACCESS_KEY',
              'BrowserStack artifact lookup',
            );
            return await listBrowserStackCloudArtifacts(provider, providerSessionId, {
              clientVersion: dependencies.clientVersion,
              username,
              accessKey,
              endpoint: env.BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
            });
          },
          prepareSession: async ({ req, lease, base }) => {
            const request = requireRequest(req, 'BrowserStack');
            const username = requireEnv(env, 'BROWSERSTACK_USERNAME', 'BrowserStack');
            const accessKey = requireEnv(env, 'BROWSERSTACK_ACCESS_KEY', 'BrowserStack');
            const platform = requireRequestPlatform(request, 'BrowserStack');
            const deviceName = requireFlag(
              request,
              'device',
              'BrowserStack requires --device <name>.',
            );
            const osVersion = requireFlag(
              request,
              'providerOsVersion',
              'BrowserStack requires --provider-os-version <version>.',
            );
            const app = await resolveBrowserStackAppReference({
              clientVersion: dependencies.clientVersion,
              app: requireFlag(
                request,
                'providerApp',
                'BrowserStack requires --provider-app <bs://app-id-or-local-path>.',
              ),
              cwd: request.cwd,
              username,
              accessKey,
              uploadEndpoint: env.BROWSERSTACK_APP_UPLOAD_ENDPOINT,
              // A local IPA/APK upload can run long (130 MB is routine); an
              // upload is not a billed resource, so the request's cancellation
              // may simply abort it — unlike the session creation that follows.
              signal: request.signal,
            });
            return {
              ...base,
              platform,
              deviceName,
              auth: { username, accessKey },
              uploadApp: createBrowserStackUploadApp({
                clientVersion: dependencies.clientVersion,
                username,
                accessKey,
                endpoint: env.BROWSERSTACK_APP_UPLOAD_ENDPOINT ?? BROWSERSTACK_APP_UPLOAD_ENDPOINT,
              }),
              webdriverCapabilities: buildBrowserStackCapabilities({
                deviceName,
                osVersion,
                app,
                projectName: readFlag(request, 'providerProject'),
                buildName: readFlag(request, 'providerBuild') ?? lease.runId,
                sessionName: readFlag(request, 'providerSessionName') ?? lease.leaseId,
                deviceFeatures: buildBrowserStackDeviceFeatureCapabilities(
                  readBrowserStackDeviceFeatureFields(request.flags),
                  platform,
                ),
                configured: buildCloudWebDriverBaseCapabilities(platform, deviceName),
              }),
            };
          },
        }),
      listArtifactsFromEnv: async (providerSessionId, env) => {
        const username = requireEnv(env, 'BROWSERSTACK_USERNAME', 'BrowserStack artifact lookup');
        const accessKey = requireEnv(
          env,
          'BROWSERSTACK_ACCESS_KEY',
          'BrowserStack artifact lookup',
        );
        return await listBrowserStackCloudArtifacts(
          CLOUD_WEBDRIVER_PROVIDERS.browserStack,
          providerSessionId,
          {
            clientVersion: dependencies.clientVersion,
            username,
            accessKey,
            endpoint: env.BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
          },
        );
      },
    },
    {
      provider: CLOUD_WEBDRIVER_PROVIDERS.lambdaTest,
      createRuntime: (env) =>
        createCloudWebDriverRuntime({
          clientVersion: dependencies.clientVersion,
          provider: CLOUD_WEBDRIVER_PROVIDERS.lambdaTest,
          platform: 'android',
          deviceName: 'LambdaTest device',
          endpoint: env.LAMBDATEST_WEBDRIVER_ENDPOINT ?? LAMBDATEST_APPIUM_ENDPOINT,
          capabilityOverrides: LAMBDATEST_CAPABILITY_OVERRIDES,
          listArtifacts: async ({ provider, providerSessionId }) =>
            await listLambdaTestArtifacts(
              provider,
              providerSessionId,
              env,
              dependencies.clientVersion,
            ),
          prepareSession: async ({ req, lease, base }) => {
            const request = requireRequest(req, 'LambdaTest');
            // Loaded on demand so adding a provider does not grow the facade's eager import closure.
            const {
              LAMBDATEST_APP_UPLOAD_ENDPOINT,
              buildLambdaTestCapabilities,
              createLambdaTestUploadApp,
            } = await import('./lambdatest.ts');
            rejectBrowserStackOnlyDeviceFeatures(
              request.flags,
              CLOUD_WEBDRIVER_PROVIDERS.lambdaTest,
            );
            const username = requireEnv(env, 'LT_USERNAME', 'LambdaTest');
            const accessKey = requireEnv(env, 'LT_ACCESS_KEY', 'LambdaTest');
            const platform = requireRequestPlatform(request, 'LambdaTest');
            const deviceName = requireFlag(
              request,
              'device',
              'LambdaTest requires --device <name>.',
            );
            const osVersion = requireFlag(
              request,
              'providerOsVersion',
              'LambdaTest requires --provider-os-version <version>.',
            );
            const uploadOptions = {
              clientVersion: dependencies.clientVersion,
              username,
              accessKey,
              endpoint: env.LAMBDATEST_APP_UPLOAD_ENDPOINT ?? LAMBDATEST_APP_UPLOAD_ENDPOINT,
            };
            const app = await resolveLambdaTestAppReference(
              requireFlag(
                request,
                'providerApp',
                'LambdaTest requires --provider-app <lt://app-id-or-local-path>.',
              ),
              request.cwd,
              uploadOptions,
              request.signal,
            );
            return {
              ...base,
              platform,
              deviceName,
              auth: { username, accessKey },
              uploadApp: createLambdaTestUploadApp(uploadOptions),
              webdriverCapabilities: buildLambdaTestCapabilities({
                platform,
                deviceName,
                osVersion,
                app,
                projectName: readFlag(request, 'providerProject'),
                buildName: readFlag(request, 'providerBuild') ?? lease.runId,
                sessionName: readFlag(request, 'providerSessionName') ?? lease.leaseId,
              }),
            };
          },
        }),
      listArtifactsFromEnv: async (providerSessionId, env) =>
        await listLambdaTestArtifacts(
          CLOUD_WEBDRIVER_PROVIDERS.lambdaTest,
          providerSessionId,
          env,
          dependencies.clientVersion,
        ),
    },
    {
      provider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
      createRuntime: (env) =>
        createCloudWebDriverRuntime({
          clientVersion: dependencies.clientVersion,
          provider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
          endpoint: 'http://127.0.0.1/',
          platform: 'android',
          deviceName: 'AWS Device Farm device',
          capabilityOverrides: AWS_DEVICE_FARM_CAPABILITY_OVERRIDES,
          listArtifacts: async ({ provider, providerSessionId }) => {
            const client = createAwsCliDeviceFarmClient({
              runHostCommand: dependencies.runHostCommand,
              region:
                env.AWS_REGION ??
                env.AWS_DEFAULT_REGION ??
                readAwsDeviceFarmRegionFromArn(providerSessionId ?? ''),
            });
            return await listAwsDeviceFarmCloudArtifacts(provider, providerSessionId, client);
          },
          prepareSession: async ({ req, lease, base }) => {
            const request = requireRequest(req, 'AWS Device Farm');
            // Enforced here, not only in the CLI profile builder: the typed client and
            // hand-authored remote-config profiles both reach session preparation without passing
            // through `connect`, and would otherwise have these capabilities silently dropped.
            rejectBrowserStackOnlyDeviceFeatures(
              request.flags,
              CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
            );
            const platform = requireRequestPlatform(request, 'AWS Device Farm');
            const sessionOptions = {
              client: createAwsCliDeviceFarmClient({
                runHostCommand: dependencies.runHostCommand,
                region: readFlag(request, 'awsRegion') ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
              }),
              projectArn: requireAwsValue(
                request,
                env,
                'awsProjectArn',
                'AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN',
                'AWS_DEVICE_FARM_PROJECT_ARN',
              ),
              deviceArn: requireAwsValue(
                request,
                env,
                'awsDeviceArn',
                'AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN',
                'AWS_DEVICE_FARM_DEVICE_ARN',
              ),
              appArn:
                readFlag(request, 'awsAppArn') ??
                env.AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN ??
                env.AWS_DEVICE_FARM_APP_ARN,
              platform,
              deviceName: readFlag(request, 'device') ?? 'AWS Device Farm device',
              sessionName: readFlag(request, 'providerSessionName') ?? lease.leaseId,
              interactionMode: readAwsInteractionMode(request),
            };
            return await createAwsDeviceFarmPrepareSession(sessionOptions)({ lease, req, base });
          },
        }),
      listArtifactsFromEnv: async (providerSessionId, env) => {
        const client = createAwsCliDeviceFarmClient({
          runHostCommand: dependencies.runHostCommand,
          region:
            env.AWS_REGION ??
            env.AWS_DEFAULT_REGION ??
            readAwsDeviceFarmRegionFromArn(providerSessionId),
        });
        return await listAwsDeviceFarmCloudArtifacts(
          CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
          providerSessionId,
          client,
        );
      },
    },
  ];
}

async function resolveBrowserStackAppReference(options: {
  clientVersion: string;
  app: string;
  cwd?: string;
  username: string;
  accessKey: string;
  uploadEndpoint?: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (isProviderAppReference(options.app)) return options.app;
  const appPath = path.resolve(options.cwd ?? process.cwd(), options.app);
  if (!fs.existsSync(appPath)) {
    throw new AppError(
      'INVALID_ARGS',
      'BrowserStack --provider-app must be a bs:// app id, URL, or existing local app path.',
      { providerApp: options.app },
    );
  }
  return await uploadBrowserStackApp(
    appPath,
    {
      clientVersion: options.clientVersion,
      username: options.username,
      accessKey: options.accessKey,
      endpoint: options.uploadEndpoint,
    },
    options.signal,
  );
}

async function resolveLambdaTestAppReference(
  app: string,
  cwd: string | undefined,
  uploadOptions: LambdaTestApiOptions,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (app.startsWith('lt://')) return app;
  const { uploadLambdaTestApp } = await import('./lambdatest.ts');
  if (/^https?:\/\//i.test(app)) return await uploadLambdaTestApp(app, uploadOptions, signal);
  const appPath = path.resolve(cwd ?? process.cwd(), app);
  const stat = fs.statSync(appPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw new AppError(
      'INVALID_ARGS',
      'LambdaTest --provider-app must be an lt:// app id, URL, or existing local app file.',
      {
        providerApp: app,
        ...(stat?.isDirectory()
          ? { hint: 'Zip the .app bundle before uploading it for an iOS simulator.' }
          : {}),
      },
    );
  }
  return await uploadLambdaTestApp(appPath, uploadOptions, signal);
}

async function listLambdaTestArtifacts(
  provider: string,
  providerSessionId: string | undefined,
  env: DefaultCloudWebDriverArtifactEnv,
  clientVersion: string,
): Promise<CloudArtifactsResult | undefined> {
  const { listLambdaTestCloudArtifacts } = await import('./lambdatest.ts');
  return await listLambdaTestCloudArtifacts(provider, providerSessionId, {
    clientVersion,
    username: requireEnv(env, 'LT_USERNAME', 'LambdaTest artifact lookup'),
    accessKey: requireEnv(env, 'LT_ACCESS_KEY', 'LambdaTest artifact lookup'),
    endpoint: env.LAMBDATEST_SESSION_DETAILS_ENDPOINT,
  });
}

function isProviderAppReference(value: string): boolean {
  return value.startsWith('bs://') || /^https?:\/\//.test(value);
}

function requireRequest(
  req: LeaseLifecycleContext | undefined,
  providerLabel: string,
): LeaseLifecycleContext {
  if (req) return req;
  throw new AppError(
    'INVALID_ARGS',
    `${providerLabel} lease allocation requires provider profile flags on the request.`,
  );
}

function requireRequestPlatform(
  req: LeaseLifecycleContext,
  providerLabel: string,
): CloudWebDriverPlatform {
  const platform = req.flags?.platform;
  if (platform === 'android' || platform === 'ios') return platform;
  throw new AppError('INVALID_ARGS', `${providerLabel} requires --platform ios|android.`);
}

function requireFlag(req: LeaseLifecycleContext, key: string, message: string): string {
  const value = readFlag(req, key);
  if (value) return value;
  throw new AppError('INVALID_ARGS', message);
}

function readFlag(req: LeaseLifecycleContext, key: string): string | undefined {
  const value = req.flags?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireEnv(
  env: DefaultCloudWebDriverProviderRuntimeEnv,
  key: keyof DefaultCloudWebDriverProviderRuntimeEnv,
  providerLabel: string,
): string {
  const value = env[key];
  if (value) return value;
  throw new AppError('INVALID_ARGS', `${providerLabel} requires ${key} in the environment.`);
}

function requireAwsValue(
  req: LeaseLifecycleContext,
  env: DefaultCloudWebDriverProviderRuntimeEnv,
  flagKey: string,
  primaryEnv: keyof DefaultCloudWebDriverProviderRuntimeEnv,
  fallbackEnv: keyof DefaultCloudWebDriverProviderRuntimeEnv,
): string {
  const value = readFlag(req, flagKey) ?? env[primaryEnv] ?? env[fallbackEnv];
  if (value) return value;
  throw new AppError(
    'INVALID_ARGS',
    `AWS Device Farm requires --${dasherize(String(flagKey))} or ${fallbackEnv}.`,
  );
}

function readAwsInteractionMode(
  req: LeaseLifecycleContext,
): 'INTERACTIVE' | 'NO_VIDEO' | 'VIDEO_ONLY' | undefined {
  const value = readFlag(req, 'awsInteractionMode');
  if (value === 'INTERACTIVE' || value === 'NO_VIDEO' || value === 'VIDEO_ONLY') return value;
  return undefined;
}

function dasherize(value: string): string {
  return value.replaceAll(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}
