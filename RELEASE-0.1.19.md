# VK Play Cloud TV 0.1.19

## Changes

- Release the bridge's reference to the complete input-WASM module when the current transmitter is deleted. Previously the transmitter/token were cleared, but the module remained strongly referenced while the next session attempted another allocation. This removes our retention path; it does not force browser garbage collection or prove that all TV memory failures are resolved.
- Restore the correct module when the SDK constructs a replacement transmitter from a module it still owns. A stale transmitter's delete cannot release the active replacement.
- At each Tizen module startup, reconcile the selected resolution, manual quality preset and 60 FPS preference. The old applied-profile marker could remain correct while VK preferences drifted to Auto/high. Other video preferences such as bitrate remain untouched. Settings are not continuously rewritten during a running session.
- Report whether the bridge currently holds an input-WASM module (`input.wasmModuleHeld`).

## Why 60 FPS

The official VK SDK permits up to120 FPS for the Chrome OS identity used by this module. An Auto/high preference is therefore not equivalent to the60 FPS envelope declared to Tizen. Samsung documents60 FPS for cloud-game video and does not support dynamic frame rate in this mode: [Samsung cloud gaming media specifications](https://developer.samsung.com/smarttv/develop/guides/cloud_gaming/cg_av_spec.html).

This release preserves the selected1080p/experimental1440p profile; it does not prove1440p decoding support or actual server output. Green held~2seconds selects the other profile for the next full module startup. The relay service is unchanged and still reports0.1.17.

## Validation

Regression tests reproduce stale module retention and Auto/high drift before the fix, and pass afterwards. The real public VK input-WASM loader is exercised offline through create/delete/recreate; mouse/gamepad controls and report transport are also regression-tested. These are isolated Chrome tests, not a successful live TV session.

After updating, fully close the old module and start a fresh VK session. After repeated memory failures, a full TV restart is a useful clean-baseline test. Keep the selected profile unchanged for the first comparison; if video still fails, send a red-key report before retrying. The next report should show manual preset4/FPS3 and input-WASM released after SDK teardown. Successful gameplay remains a TV-side check.
