import type { DeviceLease } from '@agent-device/contracts/device';
import {
  PROVIDER_DEVICE_ORIENTATIONS,
  type ProviderDeviceOrientation,
} from '@agent-device/contracts/remote';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { agentDeviceRequestHeaders } from './request-headers.ts';

export type LeaseValue<T> = T | ((lease: DeviceLease) => T);

/** Best-effort release after a failure; a failed release rides along as `cleanupError`, never masks the primary. */
export async function releaseOnFailure(
  primaryError: unknown,
  release: () => Promise<unknown> | undefined,
): Promise<void> {
  try {
    await release();
  } catch (cleanupError) {
    if (primaryError instanceof AppError) {
      primaryError.details = { ...primaryError.details, cleanupError: errorMessage(cleanupError) };
    }
  }
}

export function resolveLeaseValue<T>(
  value: LeaseValue<T> | undefined,
  lease: DeviceLease,
): T | undefined {
  return typeof value === 'function' ? (value as (lease: DeviceLease) => T)(lease) : value;
}

export function basicAuthHeader(credentials: { username: string; accessKey: string }): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.accessKey}`).toString('base64')}`;
}

export function trimLeadingSlash(value: string): string {
  let firstNonSlash = 0;
  while (firstNonSlash < value.length && value.charCodeAt(firstNonSlash) === 47) {
    firstNonSlash += 1;
  }
  return firstNonSlash === 0 ? value : value.slice(firstNonSlash);
}

export function trimTrailingSlash(value: string): string {
  let lastNonSlash = value.length - 1;
  while (lastNonSlash >= 0 && value.charCodeAt(lastNonSlash) === 47) {
    lastNonSlash -= 1;
  }
  return lastNonSlash === value.length - 1 ? value : value.slice(0, lastNonSlash + 1);
}

export function withTrailingSlash(url: URL): URL {
  if (url.pathname.endsWith('/')) return url;
  const copy = new URL(url);
  copy.pathname = `${copy.pathname}/`;
  return copy;
}

/** The provider rejected or could not answer a verification call; typed so callers never sniff text. */
export type ProviderJsonFailureHints = {
  service: string;
  unauthorizedHint: string;
  networkHint: string;
};

/**
 * Fetches JSON from a hosted provider's API during connection verification. A 401/403 is
 * `UNAUTHORIZED` with a credential hint, any other non-2xx is `COMMAND_FAILED`, and a transport
 * failure is wrapped so its cause survives without leaking the credentials.
 */
export async function fetchProviderVerificationJson(
  endpoint: string | URL,
  options: {
    clientVersion: string;
    auth?: { username: string; accessKey: string };
    hints: ProviderJsonFailureHints;
  },
): Promise<unknown> {
  const { service, unauthorizedHint, networkHint } = options.hints;
  try {
    const response = await fetch(endpoint, {
      headers: {
        ...agentDeviceRequestHeaders(options.clientVersion),
        ...(options.auth ? { Authorization: basicAuthHeader(options.auth) } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const unauthorized = response.status === 401 || response.status === 403;
      throw new AppError(
        unauthorized ? 'UNAUTHORIZED' : 'COMMAND_FAILED',
        `${service} rejected connection verification.`,
        { status: response.status, hint: unauthorized ? unauthorizedHint : networkHint },
      );
    }
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'COMMAND_FAILED',
      `${service} connection verification failed.`,
      { hint: networkHint },
      error,
    );
  }
}

/** Fetches a provider's session-details JSON with basic auth, failing typed on a non-2xx or non-object body. */
export async function fetchProviderSessionDetails(
  endpoint: string | URL,
  options: {
    clientVersion: string;
    auth: { username: string; accessKey: string };
    service: string;
    timeoutMs?: number;
  },
): Promise<unknown> {
  let response: Response;
  let json: unknown;
  try {
    response = await fetch(endpoint, {
      headers: {
        ...agentDeviceRequestHeaders(options.clientVersion),
        Authorization: basicAuthHeader(options.auth),
      },
      ...(options.timeoutMs === undefined
        ? {}
        : { signal: AbortSignal.timeout(options.timeoutMs) }),
    });
    json = await readProviderJsonBody(response);
  } catch (error) {
    // Only callers that opted into a timeout get the typed failure; others keep their raw error.
    if (options.timeoutMs === undefined) throw error;
    throw new AppError(
      'COMMAND_FAILED',
      `${options.service} session details lookup failed.`,
      { hint: `Check network access to the ${options.service} API, then retry.` },
      error,
    );
  }
  if (!response.ok || !json || typeof json !== 'object') {
    throw new AppError('COMMAND_FAILED', `${options.service} session details lookup failed.`, {
      status: response.status,
      response: json,
    });
  }
  return json;
}

/** A provider response body parsed as JSON, or `undefined` when it is empty or not JSON (a gateway error page). */
export async function readProviderJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `1.0` and `1` name the same OS release on BrowserStack's catalog; TestMu's hub matches spellings exactly. */
export function sameOsVersion(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/(?:\.0)+$/, '');
  return normalize(left) === normalize(right);
}

/** Validates a device-orientation flag against the shared enum before it reaches a hub that would ignore it. */
export function requireProviderDeviceOrientation(
  spec: { flag: string; capability: string },
  value: string,
): ProviderDeviceOrientation {
  const match = PROVIDER_DEVICE_ORIENTATIONS.find((orientation) => orientation === value);
  if (match) return match;
  throw new AppError('INVALID_ARGS', `Invalid ${spec.flag} value: ${value}.`, {
    hint: `Use ${PROVIDER_DEVICE_ORIENTATIONS.join('|')}.`,
    flag: spec.flag,
    capability: spec.capability,
  });
}
