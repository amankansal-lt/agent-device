---
title: TestMu
description: Drive TestMu (LambdaTest) virtual devices, Android emulators and iOS simulators, with agent-device.
---

# TestMu

Use TestMu virtual devices for hosted Android emulator and iOS simulator WebDriver sessions. TestMu
(formerly LambdaTest) fronts both with the same Appium hub its real devices use; agent-device
selects the virtual-device pool with `isRealMobile: false`.

## Credentials and connection

Set TestMu credentials in a non-interactive environment. These are the same variables every TestMu
SDK reads:

```bash
export LT_USERNAME=...
export LT_ACCESS_KEY=...
```

Connect with the platform, exact device name and OS version, and the app to test:

```bash
agent-device connect testmu \
  --platform android \
  --device "Pixel 8" \
  --provider-os-version 14 \
  --provider-app lt://APP-id
```

`--provider-app` accepts a TestMu app reference such as `lt://APP...`, an HTTP(S) app URL, or an
existing local app path (`.apk`, or a zipped simulator `.app` for iOS). TestMu uploads a local path
or fetches a URL when it creates the hosted session, through the virtual-device upload API.

During `connect`, agent-device checks the device/OS pair against TestMu's virtual-device catalog
(`/capability/generator?isVirtualDevice=true`), verifies the credentials against your uploaded-app
listing, matches an `lt://` reference against that listing, and confirms that a local artifact
exists before saving its absolute path. `open` still needs the app's installed package or bundle
identifier, not the upload name or `lt://` id.

Optional labels:

```bash
--provider-project agent-device
--provider-build "$GITHUB_RUN_ID"
--provider-session-name "$GITHUB_JOB"
```

Optional device features:

```bash
--provider-device-orientation portrait   # or landscape        (alias --device-orientation)
--provider-geo-location US                                   # (alias --geo-location)
--provider-timezone UTC+05:30                                # (alias --timezone)
--provider-appium-version 2.16.2                             # (alias --appium-version)
--provider-language fr                                       # (alias --language)
--provider-locale fr_FR                                      # (alias --locale)
```

TestMu receives these values in `lt:options` when it creates the hosted session.

- Without `--provider-appium-version`, agent-device requests `latest`, so the `mobile:` commands it
  issues (`deepLink`, `pressButton`, `activateApp`) land on an Appium 2.x or newer server. Pin a
  version when a suite depends on one.
- `--provider-network-profile`, `--provider-custom-network`, and `--provider-no-resign-app` are
  BrowserStack capabilities; a TestMu session refuses them by flag name rather than ignoring them.
- Session video and device logs are requested on every session so `artifacts` has something to
  return.

## CLI workflow

```bash
export LT_USERNAME=...
export LT_ACCESS_KEY=...

agent-device connect testmu \
  --platform ios \
  --device "iPhone 16" \
  --provider-os-version 18.0 \
  --provider-app ./MyApp.app.zip \
  --provider-build "$GITHUB_RUN_ID"

agent-device open com.example.app
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
agent-device artifacts --json
agent-device disconnect
```

For MCP-only use, run `connect` in the same effective state directory before starting
`agent-device mcp`. MCP exposes `open`, `snapshot`, `click`, `close`, and `artifacts`, but not
provider `connect` commands.

## Node.js client

Use direct client configuration when the Node process manages TestMu credentials and selectors
rather than a saved CLI connection profile:

```ts
import { createAgentDeviceClient } from 'agent-device';

const client = createAgentDeviceClient({
  leaseProvider: 'testmu',
  platform: 'android',
  device: 'Pixel 8',
  providerOsVersion: '14',
  providerApp: 'lt://APP-id',
  providerProject: 'agent-device',
  providerBuild: process.env.GITHUB_RUN_ID,
});

await client.apps.open({ app: 'com.example.app' });
const snapshot = await client.capture.snapshot({ interactiveOnly: true });
await client.interactions.click({ selector: 'label="Continue"' });
const closed = await client.sessions.close();
const providerSessionId = closed.provider?.providerSessionId;

if (providerSessionId) {
  const artifacts = await client.sessions.artifacts({ provider: 'testmu', providerSessionId });
  console.log(artifacts.cloudArtifacts);
}
```

## Artifacts and troubleshooting

After `close`, TestMu can return session video, Appium logs, device logs, network and command
logs, a screenshot archive, and the App Automation dashboard link. Run `agent-device artifacts
--json`, or look up a previous session explicitly:

```bash
agent-device artifacts <webdriver-session-id> --provider testmu --json
```

The TestMu session id is the WebDriver session id. If artifact lookup is pending immediately after
`close`, retry it; TestMu finalizes video and log URLs after the session ends.

Endpoints can be redirected for a staging or private TestMu deployment with
`TESTMU_WEBDRIVER_ENDPOINT`, `TESTMU_APP_UPLOAD_ENDPOINT`, and `TESTMU_API_ENDPOINT`.

On hosted WebDriver sessions, `fill` checks that the field received focus before it sends keys. If
it cannot confirm focus, it fails without typing. Use `snapshot -i` to confirm the target, or
`press <target>` followed by `type <text>`.
