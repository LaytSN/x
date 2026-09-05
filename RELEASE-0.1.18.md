# VK Play Cloud TV 0.1.18

## Input

- Observe the official standalone player's existing input-WASM promise before it constructs InputTransmitter. Its private webpack runtime is not the dashboard's webpackChunkcg_frontend runtime.
- Do not load another SDK, allocate another WASM module, rewrite remote bundles, or change authorization/browser-gate behavior.
- Capture the current transmitter and its normal flush token; clear both on deletion/replacement. A stale transmitter cannot supply a new session's token.
- Preserve L1 + R1 + Options and the original gamepad mode. A mode request is no longer logged as working native input before the bridge is ready.

## Diagnostics

- Coalesce repeated errors across interleaved messages, retain repeat counts and the last occurrence time.
- Do not echo captured diagnostics into the page's console.
- Classify the SDK's ELK endpoint as telemetry, separately from session APIs.
- Include nativeMouseReady, a redacted bridge error and numeric video preferences from an explicit allowlist. No session/token storage dump.
- Label decoded FPS as decoding, not game/presentation FPS. Video quality, SDP, registration and report-relay behavior are otherwise unchanged. The unchanged report service still identifies itself as 0.1.17.

## Verification / limits

The current public SDK's real input-WASM loader was tested offline in isolated Chrome: the old bridge remained waiting; this build captured and released the actual transmitter. Separate browser controls tests verify mouse movement/clicks into a model transmitter, neutralization only in mouse mode, and return to the real pad.

These tests do not prove live packet delivery, latency, decoder stability or memory availability on a Samsung TV. After updating, fully exit the old module, start a session, toggle mouse, move/click, toggle back, and send a red-key report. Expected: VK input ready and its mouse-event count increasing.

Regression tests require Node.js, Playwright with installed Chrome, and acorn for the optional public-SDK test. Set VKPLAY_SDK_FILE to a downloaded copy of https://vkplaycloud.mrgcdn.ru/bundle/bundle.min.js. The SDK source and private reports are not distributed in this repository.
