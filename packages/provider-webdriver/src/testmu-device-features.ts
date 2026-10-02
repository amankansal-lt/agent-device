import {
  PROVIDER_DEVICE_TYPES,
  type CloudProviderProfileFields,
  type ProviderDeviceType,
} from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
import { requireProviderDeviceOrientation } from './webdriver-utils.ts';

/**
 * TestMu "device feature" session capabilities: the hosted-provider flags TestMu can act on,
 * projected onto their `lt:options` keys. The table is the contract; adding a capability means
 * adding a row, not a branch.
 */
export type TestMuDeviceFeatureFields = Pick<
  CloudProviderProfileFields,
  | 'providerDeviceOrientation'
  | 'providerGeoLocation'
  | 'providerTimezone'
  | 'providerAppiumVersion'
  | 'providerLanguage'
  | 'providerLocale'
>;

type TestMuDeviceFeatureSpec = {
  field: keyof TestMuDeviceFeatureFields;
  /** Key emitted inside `lt:options`. */
  capability: string;
  /** Canonical CLI flag, so an error can name a recovery action. */
  flag: string;
  /** Projects the validated flag value onto what the hub expects. */
  project?: (value: string) => unknown;
};

export const TESTMU_DEVICE_FEATURE_SPECS: readonly TestMuDeviceFeatureSpec[] = [
  {
    field: 'providerDeviceOrientation',
    capability: 'deviceOrientation',
    flag: '--provider-device-orientation',
    // The hub matches the orientation enum case-sensitively in upper case.
    project: (value) => value.toUpperCase(),
  },
  { field: 'providerGeoLocation', capability: 'geoLocation', flag: '--provider-geo-location' },
  { field: 'providerTimezone', capability: 'timezone', flag: '--provider-timezone' },
  {
    field: 'providerAppiumVersion',
    capability: 'appiumVersion',
    flag: '--provider-appium-version',
  },
  { field: 'providerLanguage', capability: 'language', flag: '--provider-language' },
  { field: 'providerLocale', capability: 'locale', flag: '--provider-locale' },
];

/** Hosted-provider flags other vendors own and TestMu has no capability for. */
const TESTMU_UNSUPPORTED_DEVICE_FEATURE_FLAGS: ReadonlyArray<{
  field: keyof CloudProviderProfileFields;
  flag: string;
}> = [
  { field: 'providerNetworkProfile', flag: '--provider-network-profile' },
  { field: 'providerCustomNetwork', flag: '--provider-custom-network' },
  { field: 'providerNoResignApp', flag: '--provider-no-resign-app' },
];

/** Builds the `lt:options` fragment for the configured device features. */
export function buildTestMuDeviceFeatureCapabilities(
  fields: TestMuDeviceFeatureFields,
): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {};
  for (const spec of TESTMU_DEVICE_FEATURE_SPECS) {
    const value = fields[spec.field];
    if (value === undefined || value === '') continue;
    capabilities[spec.capability] = spec.project ? spec.project(value) : value;
  }
  return capabilities;
}

/**
 * Fails when flags TestMu cannot act on were given. Called from both `connect testmu` (through the
 * `./testmu-device-features` subpath, so the package entry stays lazy) and session preparation,
 * since the typed client and hand-authored profiles skip `connect`.
 */
export function rejectUnsupportedTestMuDeviceFeatures(
  flags: Record<string, unknown> | undefined,
): void {
  const configured = TESTMU_UNSUPPORTED_DEVICE_FEATURE_FLAGS.filter(({ field }) => {
    const value = flags?.[field];
    return value !== undefined && value !== false && value !== '';
  }).map(({ flag }) => flag);
  if (configured.length === 0) return;
  const plural = configured.length !== 1;
  throw new AppError(
    'INVALID_ARGS',
    `${configured.join(', ')} ${plural ? 'are' : 'is'} not supported by TestMu.`,
    {
      hint: `Drop ${plural ? 'those flags' : 'the flag'}; TestMu has no equivalent capability.`,
      provider: 'testmu',
      flags: configured,
    },
  );
}

/**
 * Reads device-feature fields off an untyped flag bag (a daemon request). Enum values are
 * validated here rather than forwarded to the hub, where an unrecognized value is ignored.
 */
export function readTestMuDeviceFeatureFields(
  flags: Record<string, unknown> | undefined,
): TestMuDeviceFeatureFields {
  const fields: TestMuDeviceFeatureFields = {};
  for (const spec of TESTMU_DEVICE_FEATURE_SPECS) {
    const value = flags?.[spec.field];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (spec.field === 'providerDeviceOrientation') {
      fields.providerDeviceOrientation = requireProviderDeviceOrientation(spec, value);
      continue;
    }
    fields[spec.field] = value;
  }
  return fields;
}

/** Reads the TestMu device pool off an untyped flag bag; an unset value keeps the virtual pool. */
export function readTestMuDeviceType(
  flags: Record<string, unknown> | undefined,
): ProviderDeviceType {
  const value = flags?.providerDeviceType;
  if (value === undefined || value === '') return 'virtual';
  const match = PROVIDER_DEVICE_TYPES.find((deviceType) => deviceType === value);
  if (match) return match;
  throw new AppError('INVALID_ARGS', `Invalid --provider-device-type value: ${String(value)}.`, {
    hint: `Use ${PROVIDER_DEVICE_TYPES.join('|')}.`,
    flag: '--provider-device-type',
  });
}

/**
 * Fails when another provider was given a TestMu-only flag. Like the BrowserStack-only check, it
 * runs in both the connect profile builder and session preparation.
 */
export function rejectTestMuOnlyProviderFlags(
  flags: Record<string, unknown> | undefined,
  provider: string,
): void {
  const value = flags?.providerDeviceType;
  if (value === undefined || value === '') return;
  throw new AppError(
    'INVALID_ARGS',
    `--provider-device-type is only supported by TestMu, not ${provider}.`,
    {
      hint: 'Drop the flag or use the testmu provider.',
      provider,
      flags: ['--provider-device-type'],
    },
  );
}
