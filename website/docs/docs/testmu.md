---
title: TestMu AI
description: Drive TestMu AI App Automation sessions on Android emulators and iOS simulators with agent-device.
---

# TestMu AI

Use TestMu AI (formerly LambdaTest) App Automation for hosted Android emulator and iOS simulator WebDriver sessions.

## Credentials and connection

Set TestMu AI credentials in a non-interactive environment:

```bash
export LT_USERNAME=...
export LT_ACCESS_KEY=...
```

Connect with `--platform`, the TestMu AI `--device` name, `--provider-os-version`, and the app to test, as shown in the [CLI workflow](#cli-workflow). The device name and OS version must match a TestMu AI emulator or simulator exactly as the [TestMu AI capabilities generator](https://www.lambdatest.com/capabilities-generator) lists it; for example, an iOS simulator needs `18.0`, not `18`:

```bash
agent-device connect testmu \
  --platform ios \
  --device "iPhone 16" \
  --provider-os-version 18.0 \
  --provider-app ./Demo.zip
```

`--provider-app` accepts a TestMu AI app reference such as `lt://...`, an HTTP(S) app URL, or an existing local app path. agent-device uploads a local path or URL to TestMu AI app storage when it creates the hosted session. Android apps are `.apk` or `.aab` files. iOS simulator builds must be a zipped `.app` bundle, not an `.ipa`.

During `connect`, agent-device verifies the TestMu AI credentials with a read-only call, checks that an `lt://` reference is well formed, and confirms that a local artifact exists before saving its absolute path. TestMu AI checks the device name, OS version, and app when the session starts. `open` still needs the app's installed package or bundle identifier, not its upload name.

Optional labels:

```bash
--provider-project agent-device
--provider-build "$GITHUB_RUN_ID"
--provider-session-name "$GITHUB_JOB"
```

agent-device sends every selector and label inside `lt:options`, with `w3c: true` and `isRealMobile: false`, and turns on session video and device logs. BrowserStack device-feature flags such as `--provider-timezone` are rejected for TestMu AI.

## CLI workflow

```bash
export LT_USERNAME=...
export LT_ACCESS_KEY=...

agent-device connect testmu \
  --platform android \
  --device "Pixel 8" \
  --provider-os-version 14 \
  --provider-app lt://APP123 \
  --provider-project agent-device \
  --provider-build "$GITHUB_RUN_ID"

agent-device open com.example.app
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
agent-device artifacts --json
agent-device disconnect
```

For MCP-only use, run `connect` in the same effective state directory before starting `agent-device mcp`. MCP exposes `open`, `snapshot`, `click`, `close`, and `artifacts`, but not provider `connect` commands.

## Node.js client

The typed client reaches TestMu AI through a lease. Allocate one with the provider selectors, then scope a client to it for normal commands. `sessions.close()` ends the hosted session and releases the lease; `leases.release()` in `finally` is then a no-op, and still releases the lease when a command fails first. The daemon reads `LT_USERNAME` and `LT_ACCESS_KEY` from its environment.

```ts
import { createAgentDeviceClient } from 'agent-device';

const scope = {
  tenant: 'testmu',
  runId: process.env.GITHUB_RUN_ID ?? 'local-run',
  leaseBackend: 'android-instance',
  leaseProvider: 'testmu',
} as const;

const lease = await createAgentDeviceClient().leases.allocate({
  ...scope,
  platform: 'android',
  device: 'Pixel 8',
  providerOsVersion: '14',
  providerApp: 'lt://APP123',
  providerProject: 'agent-device',
  providerBuild: process.env.GITHUB_RUN_ID,
});
const client = createAgentDeviceClient({ ...scope, leaseId: lease.leaseId });

let providerSessionId: string | undefined;
try {
  await client.apps.open({ app: 'com.example.app' });
  await client.capture.snapshot({ interactiveOnly: true });
  await client.interactions.click({ selector: 'label="Continue"' });
  const closed = await client.sessions.close();
  providerSessionId = closed.provider?.providerSessionId;
} finally {
  await client.leases.release({ ...scope, leaseId: lease.leaseId });
}

if (providerSessionId) {
  const artifacts = await client.sessions.artifacts({ provider: 'testmu', providerSessionId });
  if ('cloudArtifacts' in artifacts) console.log(artifacts.cloudArtifacts);
}
```

## Artifacts and troubleshooting

After `close`, agent-device reads TestMu AI's session details for video, command log, Appium log, console log, network log, and screenshot URLs and returns the ones TestMu AI has published. A failed lookup does not fail `close`; the TestMu AI dashboard keeps the same evidence.

```bash
agent-device artifacts <webdriver-session-id> --provider testmu --json
```

If artifact lookup is pending immediately after `close`, retry it. TestMu AI may still be finalizing video and log URLs.

TestMu AI WebDriver sessions do not support agent-device port reverse; use TestMu AI Tunnel for network access to local services. Native snapshot backends, settings, alerts, pinch and rotate gestures, logs, and recording are not available on hosted WebDriver sessions.
