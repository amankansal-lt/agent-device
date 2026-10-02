import { test } from 'vitest';
import assert from 'node:assert/strict';

import { AppError } from '@agent-device/kernel/errors';
import {
  TESTMU_DEVICE_FEATURE_SPECS,
  buildTestMuDeviceFeatureCapabilities,
  readTestMuDeviceFeatureFields,
  readTestMuDeviceType,
  rejectTestMuOnlyProviderFlags,
  rejectUnsupportedTestMuDeviceFeatures,
} from './testmu-device-features.ts';

// Every hosted-provider device-feature field is either a TestMu spec row or an explicit rejection:
// a field in neither parses off the CLI, rides the profile, and is silently dropped at the hub.
const SUPPORTED_FIELDS = [
  'providerDeviceOrientation',
  'providerGeoLocation',
  'providerTimezone',
  'providerAppiumVersion',
  'providerLanguage',
  'providerLocale',
] as const;
const REJECTED_FIELDS = [
  'providerNetworkProfile',
  'providerCustomNetwork',
  'providerNoResignApp',
] as const;

test('every supported device-feature field maps to exactly one lt:options key', () => {
  const fields = TESTMU_DEVICE_FEATURE_SPECS.map((spec) => spec.field);
  assert.deepEqual([...fields].sort(), [...SUPPORTED_FIELDS].sort());
  const capabilities = TESTMU_DEVICE_FEATURE_SPECS.map((spec) => spec.capability);
  assert.equal(new Set(capabilities).size, capabilities.length);
});

test('configured device features project onto TestMu capability keys', () => {
  const capabilities = buildTestMuDeviceFeatureCapabilities({
    providerDeviceOrientation: 'landscape',
    providerGeoLocation: 'US',
    providerTimezone: 'UTC+05:30',
    providerAppiumVersion: '2.16.2',
    providerLanguage: 'fr',
    providerLocale: 'fr_FR',
  });
  assert.deepEqual(capabilities, {
    deviceOrientation: 'LANDSCAPE',
    geoLocation: 'US',
    timezone: 'UTC+05:30',
    appiumVersion: '2.16.2',
    language: 'fr',
    locale: 'fr_FR',
  });
});

test('unset and empty device features emit nothing', () => {
  assert.deepEqual(buildTestMuDeviceFeatureCapabilities({}), {});
  assert.deepEqual(buildTestMuDeviceFeatureCapabilities({ providerGeoLocation: '' }), {});
});

test('daemon flag bags are read through the same table with orientation validated', () => {
  assert.deepEqual(
    readTestMuDeviceFeatureFields({
      providerDeviceOrientation: 'portrait',
      providerLocale: 'de_DE',
      providerNetworkProfile: 'ignored-here',
      providerGeoLocation: 7,
    }),
    { providerDeviceOrientation: 'portrait', providerLocale: 'de_DE' },
  );
  assert.throws(
    () => readTestMuDeviceFeatureFields({ providerDeviceOrientation: 'sideways' }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.flag === '--provider-device-orientation',
  );
});

test('BrowserStack-only flags are rejected by flag name instead of being dropped', () => {
  assert.doesNotThrow(() => rejectUnsupportedTestMuDeviceFeatures(undefined));
  assert.doesNotThrow(() =>
    rejectUnsupportedTestMuDeviceFeatures({
      providerGeoLocation: 'US',
      providerNoResignApp: false,
    }),
  );
  for (const field of REJECTED_FIELDS) {
    assert.throws(
      () =>
        rejectUnsupportedTestMuDeviceFeatures({
          [field]: field === 'providerNoResignApp' ? true : 'x',
        }),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
    );
  }
  assert.throws(
    () =>
      rejectUnsupportedTestMuDeviceFeatures({
        providerNetworkProfile: '4g-lte-good',
        providerCustomNetwork: '1000',
      }),
    /--provider-network-profile, --provider-custom-network are not supported by TestMu AI/,
  );
});

test('the device type defaults to the virtual pool and rejects unknown values', () => {
  assert.equal(readTestMuDeviceType(undefined), 'virtual');
  assert.equal(readTestMuDeviceType({ providerDeviceType: '' }), 'virtual');
  assert.equal(readTestMuDeviceType({ providerDeviceType: 'virtual' }), 'virtual');
  assert.equal(readTestMuDeviceType({ providerDeviceType: 'real' }), 'real');
  assert.throws(
    () => readTestMuDeviceType({ providerDeviceType: 'physical' }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.flag === '--provider-device-type',
  );
});

test('other providers refuse --provider-device-type by flag name', () => {
  assert.doesNotThrow(() => rejectTestMuOnlyProviderFlags(undefined, 'browserstack'));
  assert.doesNotThrow(() =>
    rejectTestMuOnlyProviderFlags({ providerGeoLocation: 'US' }, 'browserstack'),
  );
  for (const providerDeviceType of ['real', 'virtual']) {
    assert.throws(
      () => rejectTestMuOnlyProviderFlags({ providerDeviceType }, 'aws-device-farm'),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        /--provider-device-type is only supported by TestMu AI, not aws-device-farm/.test(
          error.message,
        ),
    );
  }
});
