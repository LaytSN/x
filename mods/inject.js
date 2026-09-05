(function (root, factory) {
  "use strict";

  var api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root && root.document) {
    api.install(root);
  }
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var VERSION = "0.1.19";
  var RELAY_URL = "http://127.0.0.1:8788";
  var TARGET_MODEL = "Samsung UE55U8000FUXCE";
  var SPOOFED_UA =
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120.0.0.0 Safari/537.36";
  var IMAGE_ATTR = "send [x=[960:1920],y=[540:1080],fps=[60:60]]";

  function errorText(error) {
    if (!error) return "Unknown error";
    if (error.name || error.message) {
      return String((error.name || "Error") + ": " + (error.message || error));
    }
    return String(error);
  }

  function scrubDiagnosticText(value) {
    return String(value == null ? "" : value)
      .replace(/\b(?:https?|wss?):\/\/[^\s<>"')]+/gi, "[URL]")
      .replace(/[?#][^\s<>"')\]]+/g, "[query/fragment omitted]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
      .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
      .replace(/\b([A-Za-z_]*(?:token|password|passwd|cookie|authorization|sessionid|session_id|secret)[A-Za-z_]*)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1=[redacted]")
      .replace(/\b[A-Za-z0-9_+\/-]{48,}={0,2}\b/g, "[opaque]")
      .slice(0, 1200);
  }

  function scrubReport(value) {
    return JSON.parse(JSON.stringify(value, function (key, item) {
      if (/token|password|cookie|authorization|secret/i.test(key)) return "[redacted]";
      return typeof item === "string" ? scrubDiagnosticText(item) : item;
    }));
  }

  function patchSamsungSdp(sdp, profile) {
    if (typeof sdp !== "string" || sdp.indexOf("m=video") === -1) {
      return sdp;
    }

    var newline = sdp.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
    var lines = sdp.split(/\r\n|\n/);
    var inVideo = false;
    var imageAttrPayloads = Object.create(null);
    var index;

    for (index = 0; index < lines.length; index += 1) {
      if (lines[index].indexOf("m=") === 0) {
        inVideo = lines[index].indexOf("m=video ") === 0;
      }
      if (inVideo) {
        var existing = lines[index].match(/^a=imageattr:(\d+)\s/i);
        if (existing) imageAttrPayloads[existing[1]] = true;
      }
    }

    inVideo = false;
    var output = [];
    for (index = 0; index < lines.length; index += 1) {
      var line = lines[index];
      if (line.indexOf("m=") === 0) {
        inVideo = line.indexOf("m=video ") === 0;
      }

      output.push(line);
      if (!inVideo) continue;

      var h264 = line.match(/^a=rtpmap:(\d+)\s+H264\/90000(?:\s|$)/i);
      if (h264 && !imageAttrPayloads[h264[1]]) {
        var imageAttr = profile === "1440p"
          ? "send [x=[960:2560],y=[540:1440],fps=[60:60]]" : IMAGE_ATTR;
        output.push("a=imageattr:" + h264[1] + " " + imageAttr);
        imageAttrPayloads[h264[1]] = true;
      }
    }

    return output.join(newline);
  }

  function countSamsungImageAttrs(sdp) {
    var matches = String(sdp || "").match(/^a=imageattr:\d+\s+send\s+/gim);
    return matches ? matches.length : 0;
  }

  function summarizeStreamMetrics(current, previous) {
    var result = { decodedFps: null, bitrateMbps: null, decodeMs: null,
      jitterBufferMs: null, lossPercent: null, rttMs: null, resolution: "unknown", codec: "unknown" };
    var peer = null, video = null;
    (current || []).forEach(function (candidate) {
      (candidate.stats || []).forEach(function (item) {
        if (item.type === "inbound-rtp" && item.kind === "video") { peer = candidate; video = item; }
      });
    });
    if (!video) return result;
    var old = null;
    (previous || []).forEach(function (candidate) {
      if (candidate.index !== peer.index) return;
      (candidate.stats || []).forEach(function (item) { if (item.id === video.id) old = item; });
    });
    function number(value) { return typeof value === "number" && isFinite(value); }
    function delta(key) {
      return old && number(old[key]) && number(video[key]) && video[key] >= old[key] ? video[key] - old[key] : null;
    }
    function round(value) { return Math.round(value * 100) / 100; }
    var elapsed = old && number(video.timestamp) && number(old.timestamp) ? video.timestamp - old.timestamp : 0;
    var frames = delta("framesDecoded"), bytes = delta("bytesReceived");
    var decode = delta("totalDecodeTime"), buffer = delta("jitterBufferDelay"), emitted = delta("jitterBufferEmittedCount");
    var received = delta("packetsReceived"), lost = delta("packetsLost");
    if (elapsed > 0 && frames != null) result.decodedFps = round(frames * 1000 / elapsed);
    if (elapsed > 0 && bytes != null) result.bitrateMbps = round(bytes * 8 / elapsed / 1000);
    if (frames > 0 && decode != null) result.decodeMs = round(decode * 1000 / frames);
    if (emitted > 0 && buffer != null) result.jitterBufferMs = round(buffer * 1000 / emitted);
    if (lost != null && received != null && received + lost > 0) result.lossPercent = round(lost * 100 / (received + lost));
    if (video.frameWidth && video.frameHeight) result.resolution = video.frameWidth + "x" + video.frameHeight;
    var selected = null;
    peer.stats.forEach(function (item) {
      if (item.id === video.codecId) result.codec = item.mimeType || "unknown";
      if (item.type === "transport" && item.selectedCandidatePairId) selected = item.selectedCandidatePairId;
    });
    peer.stats.forEach(function (item) {
      if (item.type === "candidate-pair" && item.id === selected && number(item.currentRoundTripTime)) result.rttMs = round(item.currentRoundTripTime * 1000);
    });
    return result;
  }

  function neutralGamepadButtons(buttonCount) {
    var buttons = [];
    for (var index = 0; index < buttonCount; index += 1) {
      buttons.push({ pressed: false, touched: false, value: 0 });
    }
    return buttons;
  }

  var VK_LAUNCH_MODULE_ID = 10389;
  var VK_INPUT_MODULE_ID = 442;

  function createVkInputBridge() {
    return {
      module: null,
      transmitter: null,
      token: null,
      factoryPatched: false,
      moduleReady: false,
      transmitterReady: false,
      sentEvents: 0,
      lastError: null,
      onState: null,
      onError: null
    };
  }

  // VK Play регистрирует геймпад ровно один раз — в обработчике события
  // `gamepadconnected`, и только пока его список входов пуст. Если браузер
  // выдал это событие до старта игровой сессии (на дашборде), обработчик VK
  // ещё не навешен, повторного события не будет, и виртуальный геймпад на
  // сервере не создаётся. Регистратор переиздаёт событие уже внутри сессии
  // и проверяет успех по тому, начал ли VK опрашивать navigator.getGamepads().
  function createVkGamepadRegistrar(options) {
    var config = options || {};
    var dispatch = typeof config.dispatch === "function" ? config.dispatch : null;
    var pollCount = typeof config.pollCount === "function" ? config.pollCount : null;
    var log = typeof config.log === "function" ? config.log : function () {};
    var startDelayMs = config.startDelayMs || 700;
    var probeWindowMs = config.probeWindowMs || 500;
    var retryDelayMs = config.retryDelayMs || 1500;
    var maxAnnounces = config.maxAnnounces || 3;
    var probeTimeoutMs = config.probeTimeoutMs || 4000;

    var streamWasActive = false;
    var announcedOnce = false;
    var status = "idle";
    var announces = 0;
    var nextAnnounceAt = 0;
    var knownIndex = -1;
    var probeMark = 0;
    var probeAt = 0;
    var pollRate = 0;
    var lastPad = null;
    var announcedAt = 0;

    function arm(timestamp, delay) {
      status = "pending";
      announces = 0;
      announcedOnce = false;
      nextAnnounceAt = timestamp + delay;
      probeMark = pollCount ? pollCount() : 0;
      probeAt = timestamp;
    }

    function idle() {
      streamWasActive = false;
      announcedOnce = false;
      status = "idle";
      announces = 0;
      nextAnnounceAt = 0;
      knownIndex = -1;
      pollRate = 0;
      lastPad = null;
      announcedAt = 0;
    }

    function announce(pad, timestamp) {
      announces += 1;
      if (dispatch) dispatch("gamepadconnected", pad);
      announcedOnce = true;
      lastPad = pad;
      announcedAt = timestamp;
      nextAnnounceAt = timestamp + retryDelayMs;
      if (!pollCount) status = "announced";
      log("announce #" + announces + " for " + ((pad && pad.id) || "gamepad"));
    }

    function update(pad, streamActive, timestamp) {
      if (!streamActive) {
        if (streamWasActive) idle();
        knownIndex = pad ? pad.index : -1;
        return status;
      }

      if (!streamWasActive) {
        streamWasActive = true;
        knownIndex = pad ? pad.index : -1;
        arm(timestamp, startDelayMs);
      }

      if (!pad) {
        if (knownIndex !== -1) {
          if (announcedOnce && dispatch && lastPad) {
            dispatch("gamepaddisconnected", lastPad);
          }
          knownIndex = -1;
          announcedOnce = false;
          arm(timestamp, startDelayMs);
          log("gamepad lost inside session");
        }
        return status;
      }

      if (pad.index !== knownIndex) {
        if (lastPad && announcedOnce && dispatch) {
          dispatch("gamepaddisconnected", lastPad);
        }
        knownIndex = pad.index;
        arm(timestamp, startDelayMs);
        log("gamepad reconnected inside session");
      }

      if (pollCount && timestamp - probeAt >= probeWindowMs) {
        pollRate = pollCount() - probeMark;
        probeMark = pollCount();
        probeAt = timestamp;
        if (pollRate > 0 && announces > 0) {
          if (status !== "ready") {
            status = "ready";
            log("registered after " + announces + " announce(s)");
          }
          return status;
        }
        // A slow/stalled rAF is not a physical disconnect. Never reset a
        // registered controller merely because the main thread is busy.
      }

      if (status === "ready") return status;
      if (!pollCount && announcedOnce) return status;
      if (status === "failed") return status;
      if (announces >= maxAnnounces && timestamp - announcedAt >= probeTimeoutMs) {
        status = "failed";
        log("VK did not start gamepad polling; startup attempts exhausted");
        return status;
      }
      if (timestamp < nextAnnounceAt) return status;

      if (announces < maxAnnounces) announce(pad, timestamp);
      return status;
    }

    return {
      update: update,
      status: function () { return status; },
      announces: function () { return announces; },
      pollRate: function () { return pollRate; }
    };
  }

  function notifyVkInputBridge(bridge, status, detail) {
    if (bridge && typeof bridge.onState === "function") {
      bridge.onState(status, detail || "");
    }
  }

  function failVkInputBridge(bridge, error) {
    if (!bridge) return;
    bridge.lastError = errorText(error);
    if (typeof bridge.onError === "function") bridge.onError(error);
  }

  function captureVkInputTransmitter(bridge, transmitter) {
    if (!bridge || !transmitter) return transmitter;
    if (bridge.transmitter !== transmitter) bridge.token = null;
    bridge.transmitter = transmitter;
    bridge.transmitterReady = true;

    if (
      typeof transmitter.flush === "function" &&
      !transmitter.flush.__vkplayTizenTokenCapture
    ) {
      var nativeFlush = transmitter.flush;
      function capturedFlush(force, secondary, token) {
        if (bridge.transmitter === this && token !== undefined && token !== null && token !== "") {
          var firstToken = bridge.token == null;
          bridge.token = token;
          if (firstToken) notifyVkInputBridge(bridge, "ready", "session token captured");
        }
        return nativeFlush.apply(this, arguments);
      }
      try {
        Object.defineProperty(capturedFlush, "__vkplayTizenTokenCapture", {
          configurable: false,
          value: true
        });
        transmitter.flush = capturedFlush;
      } catch (error) {
        failVkInputBridge(bridge, error);
      }
    }

    if (typeof transmitter.delete === "function" && !transmitter.delete.__vkplayTizenInputDelete) {
      var nativeDelete = transmitter.delete;
      function capturedDelete() {
        if (bridge.transmitter === this) {
          bridge.transmitter = null;
          bridge.transmitterReady = false;
          bridge.token = null;
          // The SDK releases its module on destroy. Do not keep its WASM heap
          // alive until a replacement has already managed to allocate memory.
          bridge.module = null;
          bridge.moduleReady = false;
          notifyVkInputBridge(bridge, "transmitter-destroyed", "waiting for next player input");
        }
        return nativeDelete.apply(this, arguments);
      }
      capturedDelete.__vkplayTizenInputDelete = true;
      transmitter.delete = capturedDelete;
    }

    notifyVkInputBridge(
      bridge,
      bridge.token == null ? "transmitter-ready" : "ready",
      bridge.token == null ? "waiting for session token" : "native input ready"
    );
    return transmitter;
  }

  function patchVkInputModule(moduleValue, bridge) {
    if (!moduleValue || !bridge) return moduleValue;
    bridge.module = moduleValue;
    bridge.moduleReady = true;

    var NativeInputTransmitter = moduleValue.InputTransmitter;
    if (
      typeof NativeInputTransmitter !== "function" ||
      NativeInputTransmitter.__vkplayTizenInputCapture
    ) {
      notifyVkInputBridge(
        bridge,
        bridge.token != null ? "ready" : bridge.transmitterReady ? "transmitter-ready" : "module-ready",
        "VK input WASM loaded"
      );
      return moduleValue;
    }

    function CapturedInputTransmitter() {
      var instance;
      var args = Array.prototype.slice.call(arguments);
      try {
        if (typeof Reflect === "object" && typeof Reflect.construct === "function") {
          instance = Reflect.construct(NativeInputTransmitter, args);
        } else if (!args.length) {
          instance = new NativeInputTransmitter();
        } else {
          instance = new (Function.prototype.bind.apply(
            NativeInputTransmitter,
            [null].concat(args)
          ))();
        }
      } catch (error) {
        failVkInputBridge(bridge, error);
        throw error;
      }
      // The SDK can construct another transmitter from a module it still owns.
      bridge.module = moduleValue;
      bridge.moduleReady = true;
      bridge.lastError = null;
      return captureVkInputTransmitter(bridge, instance);
    }

    CapturedInputTransmitter.prototype = NativeInputTransmitter.prototype;
    try {
      Object.setPrototypeOf(CapturedInputTransmitter, NativeInputTransmitter);
    } catch (_) {}
    Object.defineProperty(CapturedInputTransmitter, "__vkplayTizenInputCapture", {
      configurable: false,
      value: true
    });

    try {
      moduleValue.InputTransmitter = CapturedInputTransmitter;
    } catch (error) {
      try {
        Object.defineProperty(moduleValue, "InputTransmitter", {
          configurable: true,
          writable: true,
          value: CapturedInputTransmitter
        });
      } catch (defineError) {
        failVkInputBridge(bridge, defineError || error);
      }
    }

    notifyVkInputBridge(bridge, "module-ready", "VK input WASM patched");
    return moduleValue;
  }

  // The standalone MGCWebRTCPlayer has a PRIVATE webpack runtime, unrelated
  // to webpackChunkcg_frontend. Its SDK calls wasmFactory().then(module =>
  // new module.InputTransmitter()). Observe that existing resolution before
  // the callback, without loading/evaluating source or allocating more WASM.
  // Only own data properties are inspected; unrelated accessors are not run.
  function installVkInputPromiseHook(win, bridge) {
    if (!win.Promise || !bridge) return false;
    var prototype = win.Promise.prototype;
    var nativeThen = prototype.then;
    if (nativeThen.__vkplayTizenInputResolution) return true;
    function ownValue(object, key) {
      var descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && descriptor.value;
    }
    function inputThen(onFulfilled, onRejected) {
      var callback = onFulfilled;
      if (typeof callback === "function") {
        onFulfilled = function (value) {
          try {
            if (value && typeof value === "object" &&
                typeof ownValue(value, "InputTransmitter") === "function" &&
                typeof ownValue(value, "timestamp") === "function" &&
                typeof ownValue(value, "MOUSE_DEV_ID_OFFSET") === "number" &&
                ownValue(value, "MouseEventType")) {
              patchVkInputModule(value, bridge);
            }
          } catch (error) { failVkInputBridge(bridge, error); }
          return callback.apply(this, arguments);
        };
      }
      return nativeThen.call(this, onFulfilled, onRejected);
    }
    inputThen.__vkplayTizenInputResolution = true;
    try {
      prototype.then = inputThen;
      if (prototype.then !== inputThen) return false;
      notifyVkInputBridge(bridge, "waiting-for-input-module", "standalone player input observer installed");
      return true;
    } catch (error) { failVkInputBridge(bridge, error); return false; }
  }

  function wrapVkInputFactory(factory, bridge) {
    if (typeof factory !== "function") return factory;
    if (factory.__vkplayTizenInputBridge) return factory;

    function wrappedFactory(moduleObject, moduleExports, requireModule) {
      var result = factory.call(this, moduleObject, moduleExports, requireModule);
      var wasmFactory = moduleObject && moduleObject.exports;
      if (
        typeof wasmFactory === "function" &&
        !wasmFactory.__vkplayTizenInputBridge
      ) {
        function wrappedWasmFactory() {
          var moduleResult = wasmFactory.apply(this, arguments);
          if (moduleResult && typeof moduleResult.then === "function") {
            return moduleResult.then(function (moduleValue) {
              return patchVkInputModule(moduleValue, bridge);
            });
          }
          return patchVkInputModule(moduleResult, bridge);
        }
        Object.defineProperty(wrappedWasmFactory, "__vkplayTizenInputBridge", {
          configurable: false,
          value: true
        });
        moduleObject.exports = wrappedWasmFactory;
      }
      return result;
    }

    Object.defineProperty(wrappedFactory, "__vkplayTizenInputBridge", {
      configurable: false,
      value: true
    });
    bridge.factoryPatched = true;
    notifyVkInputBridge(bridge, "factory-patched", "waiting for VK input WASM");
    return wrappedFactory;
  }

  function isVkInputFactory(factory) {
    if (typeof factory !== "function") return false;
    if (factory.__vkplayTizenInputBridge) return true;
    try {
      var source = Function.prototype.toString.call(factory);
      return (
        source.indexOf("InputTransmitter") !== -1 &&
        source.indexOf("MOUSE_DEV_ID_OFFSET") !== -1
      );
    } catch (_) {
      return false;
    }
  }

  function patchVkInputFactory(requireModule, bridge) {
    if (typeof requireModule !== "function" || !requireModule.m || !bridge) {
      return false;
    }
    var factory = requireModule.m[VK_INPUT_MODULE_ID];
    if (factory && (isVkInputFactory(factory) || String(VK_INPUT_MODULE_ID) in requireModule.m)) {
      requireModule.m[VK_INPUT_MODULE_ID] = wrapVkInputFactory(factory, bridge);
      return true;
    }

    var moduleIds = Object.keys(requireModule.m);
    for (var index = 0; index < moduleIds.length; index += 1) {
      var moduleId = moduleIds[index];
      if (!isVkInputFactory(requireModule.m[moduleId])) continue;
      requireModule.m[moduleId] = wrapVkInputFactory(requireModule.m[moduleId], bridge);
      return true;
    }
    return false;
  }

  function patchVkInputChunk(payload, bridge) {
    var modules = payload && payload[1];
    if (!modules || !bridge) return false;
    var factory = modules[VK_INPUT_MODULE_ID];
    if (typeof factory === "function") {
      modules[VK_INPUT_MODULE_ID] = wrapVkInputFactory(factory, bridge);
      return true;
    }

    var moduleIds = Object.keys(modules);
    for (var index = 0; index < moduleIds.length; index += 1) {
      var moduleId = moduleIds[index];
      if (!isVkInputFactory(modules[moduleId])) continue;
      modules[moduleId] = wrapVkInputFactory(modules[moduleId], bridge);
      return true;
    }
    return false;
  }

  function sendVkNativeMouse(bridge, kind, detail) {
    if (
      !bridge ||
      !bridge.module ||
      !bridge.transmitter ||
      bridge.token == null
    ) {
      return false;
    }

    var moduleValue = bridge.module;
    var transmitter = bridge.transmitter;
    var eventTypes = moduleValue.MouseEventType;
    if (!eventTypes || typeof transmitter.sendMouseEvent !== "function") {
      return false;
    }

    var eventType;
    if (kind === "move") eventType = eventTypes.MOVE;
    else if (kind === "press") eventType = eventTypes.BUTTON_PRESS;
    else if (kind === "release") eventType = eventTypes.BUTTON_RELEASE;
    else if (kind === "scroll") eventType = eventTypes.SCROLL;
    else return false;

    var values = detail || {};
    var event = {
      eventType: eventType,
      deviceID: moduleValue.MOUSE_DEV_ID_OFFSET,
      deltaX: values.deltaX || 0,
      deltaY: values.deltaY || 0,
      deltaZ: values.deltaZ || 0,
      absX: values.absX || 0,
      absY: values.absY || 0,
      buttonID: values.buttonID || 0,
      timestamp:
        typeof moduleValue.timestamp === "function"
          ? moduleValue.timestamp()
          : Date.now() * 1000
    };

    try {
      transmitter.setCollectEventsFlag(true);
      transmitter.sendMouseEvent(event);
      transmitter.setCollectEventsFlag(false);
      transmitter.flush(false, false, bridge.token);
      bridge.sentEvents += 1;
      notifyVkInputBridge(bridge, "ready", "native mouse event sent");
      return true;
    } catch (error) {
      failVkInputBridge(bridge, error);
      return false;
    }
  }

  function isVkLaunchFactory(factory) {
    if (typeof factory !== "function") return false;
    if (factory.__vkplayTizenBrowserGate) return true;
    try {
      var source = Function.prototype.toString.call(factory);
      return (
        source.indexOf("isAvailableWebPlayer") !== -1 &&
        source.indexOf("isGameUnavailableForWebRTC") !== -1
      );
    } catch (_) {
      return false;
    }
  }

  function wrapVkLaunchFactory(factory) {
    if (typeof factory !== "function") return factory;
    if (factory.__vkplayTizenBrowserGate) return factory;

    function wrappedFactory(moduleObject, moduleExports, requireModule) {
      function patchedRequire(moduleId) {
        var original = requireModule(moduleId);
        if (
          !original ||
          typeof original.isAvailableWebPlayer !== "function"
        ) {
          return original;
        }

        var replacement = Object.create(original);
        Object.defineProperty(replacement, "isAvailableWebPlayer", {
          configurable: true,
          enumerable: true,
          value: function () {
            return true;
          }
        });
        return replacement;
      }

      try {
        Object.setPrototypeOf(patchedRequire, requireModule);
      } catch (_) {
        Object.keys(requireModule).forEach(function (key) {
          try {
            patchedRequire[key] = requireModule[key];
          } catch (_) {}
        });
      }

      return factory.call(this, moduleObject, moduleExports, patchedRequire);
    }

    Object.defineProperty(wrappedFactory, "__vkplayTizenBrowserGate", {
      configurable: false,
      value: true
    });
    return wrappedFactory;
  }

  function patchVkLaunchFactory(requireModule) {
    if (typeof requireModule !== "function" || !requireModule.m) {
      return false;
    }

    var moduleIds = Object.keys(requireModule.m);
    if (requireModule.m[VK_LAUNCH_MODULE_ID]) {
      moduleIds.unshift(String(VK_LAUNCH_MODULE_ID));
    }
    for (var index = 0; index < moduleIds.length; index += 1) {
      var moduleId = moduleIds[index];
      var factory = requireModule.m[moduleId];
      if (!isVkLaunchFactory(factory)) continue;
      requireModule.m[moduleId] = wrapVkLaunchFactory(factory);
      return !!requireModule.m[moduleId].__vkplayTizenBrowserGate;
    }
    return false;
  }

  function patchVkLaunchChunk(payload) {
    var modules = payload && payload[1];
    if (!modules) return false;

    var moduleIds = Object.keys(modules);
    if (modules[VK_LAUNCH_MODULE_ID]) {
      moduleIds.unshift(String(VK_LAUNCH_MODULE_ID));
    }
    for (var index = 0; index < moduleIds.length; index += 1) {
      var moduleId = moduleIds[index];
      var factory = modules[moduleId];
      if (!isVkLaunchFactory(factory)) continue;
      modules[moduleId] = wrapVkLaunchFactory(factory);
      return !!modules[moduleId].__vkplayTizenBrowserGate;
    }
    return false;
  }

  function install(win) {
    var currentHostname =
      win && win.location ? String(win.location.hostname || "").toLowerCase() : "";
    var isTopLevelContext = false;
    try {
      isTopLevelContext = win.top === win;
    } catch (_) {}
    var isBootstrapPage = Boolean(
      isTopLevelContext &&
      win.location &&
      win.location.protocol === "about:" &&
      win.location.hash === "#vkplay-tv-bootstrap"
    );
    var isCloudHost = currentHostname === "cloud.vkplay.ru";
    var isVkPlayAccountHost =
      currentHostname === "account.vkplay.ru" ||
      currentHostname === "auth-ac.vkplay.ru";
    var isVkAuthHost =
      currentHostname === "id.vk.ru" ||
      currentHostname === "oauth.vk.ru" ||
      currentHostname === "login.vk.ru" ||
      currentHostname === "id.vk.com" ||
      currentHostname === "oauth.vk.com" ||
      currentHostname === "login.vk.com";
    var isLocalTestHost =
      currentHostname === "127.0.0.1" && win.__VKPLAY_TIZEN_TEST__ === true;

    if (
      !isBootstrapPage &&
      !isCloudHost &&
      !isVkPlayAccountHost &&
      !isVkAuthHost &&
      !isLocalTestHost
    ) {
      return {
        installed: false,
        skipped: true,
        version: VERSION,
        hostname: currentHostname
      };
    }

    if (win.__VKPLAY_TIZEN__ && win.__VKPLAY_TIZEN__.installed) {
      return win.__VKPLAY_TIZEN__;
    }

    var doc = win.document;
    var nav = win.navigator;
    var reportFetch = win.fetch ? win.fetch.bind(win) : null;
    var realUserAgent = nav.userAgent;
    var realScreen = { width: win.screen.width, height: win.screen.height, devicePixelRatio: win.devicePixelRatio || 1 };
    var qualityProfile = "1080p";
    var nativeGetGamepads =
      typeof nav.getGamepads === "function" ? nav.getGamepads.bind(nav) : null;
    var peerConnections = [];
    var recentEvents = [];
    var reportTimer = 0;
    var reportInFlight = null;
    var nextAutomaticReportAt = 0;
    var runId = "tv-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    var reportSequence = 0;
    var outbox = [];
    var journalTimer = 0;
    var logView = null;
    var logText = null;
    var logsVisible = false;
    var overlay = null;
    var overlayDetails = null;
    var overlayVisible = false;
    var previousGamepadButtons = Object.create(null);
    var gamepadNavigationState = Object.create(null);
    var authScanTimer = 0;
    var virtualCursor = null;
    var virtualCursorHint = null;
    var virtualCursorTarget = null;
    var virtualCursorX = 0;
    var virtualCursorY = 0;
    var virtualCursorLastFrame = 0;
    var virtualCursorButtons = [];
    var virtualCursorPressTarget = null;
    var streamHintVisible = false;
    var lastStreamHintText = "";
    var lastStreamHintMode = "";
    var streamMouseMode = false;
    var streamMouseInputActive = false;
    var streamMouseLastWheelAt = 0;
    var vkMouseComboGamepadIndex = -1;
    var vkMouseComboLatched = false;
    var streamMenuComboLatched = false;
    var vkMouseComboShimInstalled = false;
    var vkGamepadPollCount = 0;
    var vkGamepadRegistrar = null;
    var vkInputBridge = createVkInputBridge();

    var state = {
      installed: true,
      version: VERSION,
      startedAt: new Date().toISOString(),
      targetModel: TARGET_MODEL,
      quality: { active: "1080p", next: "1080p", experimental: false, screenOverride: false },
      realUserAgent: realUserAgent,
      spoofedUserAgent: SPOOFED_UA,
      browserShim: false,
      rtcShim: false,
      mediaShim: false,
      fullscreenShim: false,
      imageAttrCount: 0,
      peerConnections: 0,
      peerStates: [],
      videoTracks: 0,
      audioTracks: 0,
      combinedTracks: 0,
      gamepads: [],
      inputMode: "tv-cursor",
      streamMouseMode: false,
      streamMenuOpen: false,
      vkMouseComboCount: 0,
      vkMouseComboShim: "not-installed",
      vkBrowserGate: "not-installed",
      vkInputTransmitter: "not-installed",
      vkNativeMouseEvents: 0,
      vkGamepadRegistration: "idle",
      vkGamepadAnnounces: 0,
      vkGamepadPollRate: 0,
      diagnostics: {
        trace: [],
        history: [],
        network: [],
        stream: summarizeStreamMetrics([], []),
        display: { hdrSupported: null, hdrActive: "unknown", gameModeActive: "unknown", realScreen: realScreen },
        previousRun: null,
        shell: {
          fps: 0,
          averageFrameMs: 0,
          maxFrameMs: 0,
          longFrames: 0,
          sampledAt: null
        },
        video: {
          event: "not-seen",
          intrinsic: "unknown",
          layout: "unknown",
          objectFit: "unknown",
          readyState: -1,
          paused: null,
          totalFrames: null,
          droppedFrames: null,
          sampledAt: null
        }
      },
      reportStatus: "not-sent",
      reportError: null,
      reportId: null,
      runId: runId,
      reporting: { transport: "tizenbrew-loopback", service: "unknown", storage: "unknown", pending: 0, evicted: 0, lastDeliveredId: null },
      errors: []
    };

    function persistJournal() {
      if (!isCloudHost || !isTopLevelContext) return;
      win.clearTimeout(journalTimer);
      try {
        win.localStorage.setItem("VKPLAY_TV_JOURNAL", JSON.stringify({
          runId: runId, version: VERSION, at: new Date().toISOString(),
          entries: state.diagnostics.trace.slice(-120), errors: state.errors.slice(-20),
          reportStatus: state.reportStatus, reportError: state.reportError
        }));
      } catch (error) { state.reporting.storage = scrubDiagnosticText(errorText(error)); }
    }

    function persistOutbox() {
      state.reporting.pending = outbox.length;
      try {
        win.localStorage.setItem("VKPLAY_TV_OUTBOX", JSON.stringify(outbox));
        state.reporting.storage = "saved";
      } catch (error) { state.reporting.storage = scrubDiagnosticText(errorText(error)); }
    }

    function restoreReportStorage() {
      if (!isCloudHost || !isTopLevelContext) return;
      try {
        var previous = win.localStorage.getItem("VKPLAY_TV_JOURNAL");
        if (previous && previous.length < 250000) {
          var journal = JSON.parse(previous);
          state.diagnostics.previousJournal = Array.isArray(journal.entries) ? scrubReport(journal.entries.slice(-120)) : [];
          state.diagnostics.previousErrors = Array.isArray(journal.errors) ? scrubReport(journal.errors.slice(-20)) : [];
        }
      } catch (error) { state.reporting.storage = "journal restore: " + scrubDiagnosticText(errorText(error)); }
      try {
        var saved = win.localStorage.getItem("VKPLAY_TV_OUTBOX");
        if (saved && saved.length < 3000000) {
          var pending = JSON.parse(saved);
          if (Array.isArray(pending)) outbox = pending.filter(function (report) {
            return report && report.schema === "vkplay-tizen-live/1" && /^[a-zA-Z0-9_-]{1,100}$/.test(report.reportId || "");
          }).slice(-3).map(scrubReport);
        }
      } catch (error) { state.reporting.storage = "outbox restore: " + scrubDiagnosticText(errorText(error)); }
      state.reporting.pending = outbox.length;
      win.addEventListener("pagehide", persistJournal);
      doc.addEventListener("visibilitychange", function () { if (doc.hidden) persistJournal(); });
    }

    function traceEvent(type, detail) {
      var entry = {
        at: new Date().toISOString(),
        type: type,
        detail: scrubDiagnosticText(detail).slice(0, 512),
        runId: runId
      };
      // VK's failed telemetry alternates fetch/error messages. Coalesce across
      // interleaving entries too, so the flood cannot erase the input timeline.
      for (var i = state.diagnostics.trace.length - 1; i >= 0; i -= 1) {
        var last = state.diagnostics.trace[i];
        if (Date.now() - Date.parse(last.at) >= 5000) break;
        if (last.type === type && last.detail === entry.detail) {
          last.repeats = (last.repeats || 1) + 1;
          last.lastAt = entry.at;
          return last;
        }
      }
      recentEvents.push(entry);
      if (recentEvents.length > 60) recentEvents.shift();
      state.diagnostics.trace.push(entry);
      if (state.diagnostics.trace.length > 120) {
        state.diagnostics.trace.shift();
      }
      if (isCloudHost && isTopLevelContext) {
        win.clearTimeout(journalTimer);
        journalTimer = win.setTimeout(persistJournal, 300);
      }
      // Do not echo captured console/network events back into page console:
      // SDK instrumentation can observe it. The persisted journal is the sink.
      return entry;
    }

    function addEvent(type, detail) {
      traceEvent(type, detail);
      renderOverlay();
    }

    function recordError(scope, error) {
      var message = scrubDiagnosticText(errorText(error));
      var previous = state.errors[state.errors.length - 1];
      if (previous && previous.scope === scope && previous.error === message &&
          Date.now() - Date.parse(previous.at) < 5000) {
        previous.repeats = (previous.repeats || 1) + 1;
        return;
      }
      var entry = {
        at: new Date().toISOString(),
        scope: scope,
        error: message.slice(0, 512),
        stack: error && error.stack ? scrubDiagnosticText(error.stack) : null,
        runId: runId
      };
      state.errors.push(entry);
      if (state.errors.length > 30) state.errors.shift();
      addEvent("error:" + scope, entry.error);
      queueReport(500);
    }

    function installErrorJournal() {
      if (!isCloudHost || !isTopLevelContext) return;
      ["warn", "error"].forEach(function (level) {
        var original = win.console && win.console[level];
        if (typeof original !== "function") return;
        win.console[level] = function () {
          try {
            var parts = Array.prototype.slice.call(arguments, 0, 4).map(function (value) {
              if (value instanceof Error) return scrubDiagnosticText(errorText(value) + "\n" + (value.stack || ""));
              if (value && typeof value === "object") return "[object omitted]";
              return scrubDiagnosticText(value);
            });
            traceEvent("console-" + level, parts.join(" "));
            queueReport(1200);
          } catch (_) {}
          return original.apply(win.console, arguments);
        };
      });
      win.addEventListener("securitypolicyviolation", function (event) {
        recordError("browser-policy", new Error(String(event.effectiveDirective || event.violatedDirective) + "; destination " + endpointCategory(event.blockedURI)));
      });
      win.addEventListener("error", function (event) {
        if (event.target && event.target !== win && event.target.tagName) {
          recordError("resource-load", new Error(event.target.tagName + " " + endpointCategory(event.target.src || event.target.href)));
        }
      }, true);
    }

    function endpointCategory(value) {
      try {
        var url = new win.URL(String(value || ""), win.location.href);
        if (url.origin === RELAY_URL) return "report-relay";
        if (url.hostname === "lambda.cloud.vkplay.ru") return "vk-telemetry";
        if (/\.(vkplay|my\.games)\.(ru|com)$/.test(url.hostname) || url.hostname === "cloud.vkplay.ru") {
          var category = /\.(js|css|wasm)$/.test(url.pathname) ? "asset" : /session|stream|play/i.test(url.pathname) ? "session" : "api";
          return "vk-" + category;
        }
        if (/^(id|oauth|login)\.vk\.(com|ru)$/.test(url.hostname)) return "vk-auth";
        return "other";
      } catch (_) { return "unknown"; }
    }

    function showLogs(force) {
      if (!isCloudHost || !doc.body) return;
      logsVisible = typeof force === "boolean" ? force : !logsVisible;
      if (!logView) {
        logView = doc.createElement("div"); logView.id = "vkplay-tizen-tv-log-view";
        logView.style.cssText = "position:fixed;inset:4vh 4vw;z-index:2147483647;background:#101820;color:#fff;padding:24px;border:2px solid #a7b4c0;font:22px/1.4 monospace;box-sizing:border-box";
        var title = doc.createElement("div"); title.textContent = "Журнал VK TV · ↑/↓ прокрутка · Назад: закрыть · Красная: отчёт";
        logText = doc.createElement("pre"); logText.style.cssText = "white-space:pre-wrap;overflow:auto;height:calc(100% - 55px);font:inherit;margin:14px 0";
        logView.appendChild(title); logView.appendChild(logText); doc.body.appendChild(logView);
      }
      logView.style.display = logsVisible ? "block" : "none";
      if (!logsVisible) { virtualCursorButtons = []; return; }
      stopStreamMouseInput();
      var lines = ["Версия " + VERSION + " · запуск " + runId,
        "Отчёт " + (state.reportId || "—") + ": " + state.reportStatus,
        "Передача: " + (state.reportError || "ошибок не записано"),
        "Хранение: " + state.reporting.storage + " · ожидают " + outbox.length,
        "\nТЕКУЩИЙ ЗАПУСК (новые сверху)"];
      function rows(entries) { return entries.slice().reverse().map(function (entry) {
        return String(entry.at || "") + " " + String(entry.type || "") + " " + scrubDiagnosticText(entry.detail) + (entry.repeats ? " ×" + entry.repeats : "");
      }); }
      function errorRows(entries) { return entries.slice().reverse().map(function (entry) {
        return String(entry.at || "") + " " + String(entry.scope || "error") + "\n" +
          scrubDiagnosticText(entry.stack || entry.error) + (entry.repeats ? " ×" + entry.repeats : "");
      }); }
      lines = lines.concat(rows(state.diagnostics.trace));
      lines.push("\nПОДРОБНОСТИ ОШИБОК");
      lines = lines.concat(errorRows(state.errors));
      lines.push("\nПРЕДЫДУЩИЙ ЗАПУСК");
      lines = lines.concat(rows(state.diagnostics.previousJournal || []));
      lines = lines.concat(errorRows(state.diagnostics.previousErrors || []));
      logText.textContent = lines.join("\n"); logText.scrollTop = 0;
    }

    vkInputBridge.onState = function (status, detail) {
      var changed = state.vkInputTransmitter !== status;
      state.vkInputTransmitter = status;
      state.vkNativeMouseEvents = vkInputBridge.sentEvents;
      if (changed || status === "ready" && vkInputBridge.sentEvents === 1) {
        addEvent("vk-native-input", status + (detail ? ": " + detail : ""));
        queueReport(300);
      }
    };
    vkInputBridge.onError = function (error) {
      recordError("vk-native-input", error);
    };

    function defineNavigatorValue(name, value) {
      var descriptor = {
        configurable: true,
        enumerable: true,
        get: function () {
          return value;
        }
      };

      try {
        Object.defineProperty(nav, name, descriptor);
        return nav[name] === value;
      } catch (_) {
        try {
          Object.defineProperty(Object.getPrototypeOf(nav), name, descriptor);
          return nav[name] === value;
        } catch (error) {
          recordError("navigator." + name, error);
          return false;
        }
      }
    }

    function configureStreamQuality() {
      if (!/Tizen/i.test(realUserAgent)) return;
      var display = state.diagnostics.display;
      var uhd = null;
      try { uhd = win.webapis.productinfo.isUdPanelSupported(); } catch (_) {}
      try { display.hdrSupported = win.webapis.avinfo.isHdrTvSupport(); } catch (_) {}
      display.uhdSupported = uhd;
      // The module targets the user-specified UHD UE55U8000FUXCE. If the TV
      // explicitly reports no UHD support, retain the known FHD envelope.
      display.panelBasis = uhd == null ? "user-specified-UE55U8000FUXCE" : "productinfo";
      try {
        var stored = win.localStorage.getItem("VKPLAY_TV_QUALITY");
        qualityProfile = stored === "1080p" || uhd === false ? "1080p" : "1440p";
        var selectedResolution = qualityProfile === "1440p" ? "7" : "5";
        if (win.localStorage.getItem("VKPLAY_TV_QUALITY_APPLIED") !== qualityProfile ||
            win.localStorage.getItem("WEB_PLAYER_VIDEO_RESOLUTION") !== selectedResolution ||
            win.localStorage.getItem("WEB_PLAYER_VIDEO_FPS") !== "3" ||
            win.localStorage.getItem("WEB_PLAYER_VIDEO_QUALITY_PRESET") !== "4") {
          // These enums are from VK's official web player Ml.loadConfig / Li / Qi.
          // Auto/high resets the FPS preference; our Chrome OS identity permits
          // 120fps there, incompatible with the 60fps Tizen decoder envelope.
          // Reconcile at module startup, not continuously in a running session.
          win.localStorage.setItem("WEB_PLAYER_VIDEO_RESOLUTION", selectedResolution);
          win.localStorage.setItem("WEB_PLAYER_VIDEO_FPS", "3");
          win.localStorage.setItem("WEB_PLAYER_VIDEO_QUALITY_PRESET", "4");
          win.localStorage.setItem("VKPLAY_TV_QUALITY_APPLIED", qualityProfile);
          addEvent("stream-quality-reconciled", qualityProfile + " / 60fps / manual restored at startup");
        }
      } catch (error) {
        qualityProfile = "1080p";
        recordError("stream-quality", error);
      }
      state.quality.active = state.quality.next = qualityProfile;
      state.quality.experimental = qualityProfile === "1440p";
      // VK mistakes Tizen's logical 1080p browser screen for the UHD panel
      // and applies it as a hardware stream limit. Keep the real CSS viewport
      // and pointer coordinates; expose only the selected decode envelope.
      var width = qualityProfile === "1440p" ? 2560 : 1920;
      var height = qualityProfile === "1440p" ? 1440 : 1080;
      var values = { width: width, availWidth: width, height: height, availHeight: height };
      var descriptors = {};
      try {
        Object.keys(values).forEach(function (key) {
          descriptors[key] = Object.getOwnPropertyDescriptor(win.screen, key);
          Object.defineProperty(win.screen, key, { configurable: true, value: values[key] / realScreen.devicePixelRatio });
        });
        state.quality.screenOverride = true;
      } catch (error) {
        Object.keys(descriptors).forEach(function (key) {
          try {
            if (descriptors[key]) Object.defineProperty(win.screen, key, descriptors[key]);
            else delete win.screen[key];
          } catch (_) {}
        });
        recordError("stream-screen-limit", error);
      }
      addEvent("stream-quality", qualityProfile + " requested; actual decode size must be measured");
    }

    function toggleNextQuality() {
      if (!/Tizen/i.test(realUserAgent)) return;
      var next = state.quality.next === "1440p" ? "1080p" : "1440p";
      try {
        win.localStorage.setItem("VKPLAY_TV_QUALITY", next);
        state.quality.next = next;
        addEvent("stream-quality-next", next + "; relaunch module to apply");
      } catch (error) { recordError("stream-quality", error); }
    }

    function installBrowserShim() {
      var brands = [
        { brand: "Not/A)Brand", version: "8" },
        { brand: "Chromium", version: "120" },
        { brand: "Google Chrome", version: "120" }
      ];
      var fullVersionList = [
        { brand: "Not/A)Brand", version: "8.0.0.0" },
        { brand: "Chromium", version: "120.0.6099.5" },
        { brand: "Google Chrome", version: "120.0.6099.5" }
      ];
      var highEntropy = {
        architecture: "x86",
        bitness: "64",
        brands: brands,
        fullVersionList: fullVersionList,
        mobile: false,
        model: "",
        platform: "Chrome OS",
        platformVersion: "14541.0.0",
        uaFullVersion: "120.0.6099.5",
        wow64: false
      };
      var userAgentData = {
        brands: brands,
        mobile: false,
        platform: "Chrome OS",
        getHighEntropyValues: function (hints) {
          var result = {
            brands: brands,
            mobile: false,
            platform: "Chrome OS"
          };
          (hints || []).forEach(function (hint) {
            if (Object.prototype.hasOwnProperty.call(highEntropy, hint)) {
              result[hint] = highEntropy[hint];
            }
          });
          return Promise.resolve(result);
        },
        toJSON: function () {
          return {
            brands: brands,
            mobile: false,
            platform: "Chrome OS"
          };
        }
      };

      var uaReady = defineNavigatorValue("userAgent", SPOOFED_UA);
      var platformReady = defineNavigatorValue("platform", "Linux x86_64");
      var uaDataReady = defineNavigatorValue("userAgentData", userAgentData);
      state.browserShim = uaReady && platformReady && uaDataReady;
      addEvent(
        "browser-shim",
        state.browserShim ? "Chrome 120 / Chrome OS" : "partial"
      );
    }

    function installVkBrowserGate() {
      var attempts = 0;
      var factoryPatched = false;
      var runtimeRequire = null;
      state.vkBrowserGate = "waiting-for-vk-runtime";

      function markPatched(detail) {
        if (factoryPatched) return;
        factoryPatched = true;
        state.vkBrowserGate = "web-player-enabled";
        addEvent("vk-browser-gate", detail);
        queueReport(300);
      }

      function patchFromWebpack(requireModule) {
        runtimeRequire = requireModule;
        try {
          if (patchVkLaunchFactory(requireModule)) {
            markPatched("launch module patched");
          }
        } catch (error) {
          recordError("vk-browser-gate", error);
        }
      }

      function hookChunkPush(chunks) {
        if (
          !chunks ||
          typeof chunks.push !== "function" ||
          chunks.push.__vkplayTizenChunkHook
        ) {
          return;
        }

        var originalPush = chunks.push;
        function hookedPush(payload) {
          try {
            if (patchVkLaunchChunk(payload)) {
              markPatched("launch chunk intercepted");
            }
          } catch (error) {
            recordError("vk-runtime-chunk", error);
          }
          return originalPush.apply(this, arguments);
        }
        Object.defineProperty(hookedPush, "__vkplayTizenChunkHook", {
          configurable: false,
          value: true
        });
        chunks.push = hookedPush;
        if (!factoryPatched) state.vkBrowserGate = "launch-hook-ready";
      }

      function attempt() {
        attempts += 1;
        var chunks = win.webpackChunkcg_frontend;
        hookChunkPush(chunks);

        if (runtimeRequire) patchFromWebpack(runtimeRequire);
        if (!runtimeRequire && chunks && typeof chunks.push === "function") {
          try {
            chunks.push([
              [920000 + attempts],
              {},
              function (requireModule) {
                patchFromWebpack(requireModule);
              }
            ]);
          } catch (error) {
            if (attempts === 1) recordError("vk-webpack-runtime", error);
          }
        }

        if (!factoryPatched && attempts < 1200) {
          win.setTimeout(attempt, 500);
        } else {
          if (!factoryPatched) {
            state.vkBrowserGate = "vk-launch-module-not-found";
            addEvent("vk-browser-gate", "VK launch module was not found");
          }
        }
      }

      attempt();
    }

    function summarizePeers() {
      state.peerConnections = peerConnections.length;
      state.peerStates = peerConnections.map(function (pc, index) {
        return {
          index: index,
          connectionState: pc.connectionState || "unknown",
          iceConnectionState: pc.iceConnectionState || "unknown",
          signalingState: pc.signalingState || "unknown"
        };
      });
    }

    function networkEvent(transport, phase, status, context) {
      // Never capture URLs, query strings, headers, SDP or message bodies.
      try {
        var entry = { at: new Date().toISOString(), transport: transport, phase: phase, status: Number(status) || 0 };
        if (context) {
          entry.endpoint = context.endpoint;
          entry.method = context.method;
          entry.elapsedMs = context.elapsedMs;
        }
        state.diagnostics.network.push(entry);
        if (state.diagnostics.network.length > 40) state.diagnostics.network.shift();
        if (phase === "failed" || phase === "error") {
          traceEvent("network-" + transport, phase + " " + entry.status + " " + (entry.endpoint || ""));
          queueReport(500);
        }
        renderOverlay();
      } catch (_) {} // Observability must not change the transport's outcome.
    }

    function installNetworkDiagnostics() {
      if (win.fetch) {
        var nativeFetch = win.fetch;
        win.fetch = function () {
          var args = arguments;
          var url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
          var endpoint = endpointCategory(url);
          var isReport = endpoint === "report-relay";
          var started = Date.now();
          var method = String(args[1] && args[1].method || args[0] && args[0].method || "GET").toUpperCase();
          var context = function () { return { endpoint: endpoint, method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method) ? method : "OTHER", elapsedMs: Date.now() - started }; };
          return nativeFetch.apply(this, args).then(function (response) {
            if (!isReport && response.status >= 400) networkEvent("fetch", "failed", response.status, context());
            return response;
          }, function (error) {
            if (!isReport) networkEvent("fetch", "error", 0, context());
            throw error;
          });
        };
      }
      if (win.XMLHttpRequest) {
        var xhrContexts = new win.WeakMap();
        var nativeOpen = win.XMLHttpRequest.prototype.open;
        win.XMLHttpRequest.prototype.open = function (method, url) {
          xhrContexts.set(this, { endpoint: endpointCategory(url), method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(method) ? String(method).toUpperCase() : "OTHER" });
          return nativeOpen.apply(this, arguments);
        };
        var nativeSend = win.XMLHttpRequest.prototype.send;
        win.XMLHttpRequest.prototype.send = function () {
          var xhr = this;
          var started = Date.now();
          function complete() {
            var context = xhrContexts.get(xhr) || {};
            context.elapsedMs = Date.now() - started;
            if (context.endpoint !== "report-relay" && (xhr.status === 0 || xhr.status >= 400)) networkEvent("xhr", "failed", xhr.status, context);
          }
          xhr.addEventListener("loadend", complete, { once: true });
          try { return nativeSend.apply(xhr, arguments); }
          catch (error) { xhr.removeEventListener("loadend", complete); throw error; }
        };
      }
      if (win.WebSocket) {
        var NativeSocket = win.WebSocket;
        function TracedSocket(url, protocols) {
          var socket = arguments.length > 1 ? new NativeSocket(url, protocols) : new NativeSocket(url);
          socket.addEventListener("open", function () { networkEvent("websocket", "open", 0); });
          socket.addEventListener("error", function () { networkEvent("websocket", "error", 0); });
          socket.addEventListener("close", function (event) { networkEvent("websocket", "close", event.code); });
          return socket;
        }
        TracedSocket.prototype = NativeSocket.prototype;
        Object.setPrototypeOf(TracedSocket, NativeSocket);
        win.WebSocket = TracedSocket;
      }
      win.addEventListener("online", function () { networkEvent("browser", "online", 0); });
      win.addEventListener("offline", function () { networkEvent("browser", "offline", 0); });
    }

    function installRtcShim() {
      var NativePeerConnection =
        win.RTCPeerConnection || win.webkitRTCPeerConnection;
      if (!NativePeerConnection) {
        recordError("webrtc", new Error("RTCPeerConnection is unavailable"));
        return;
      }

      function instrument(pc) {
        if (pc.__vkplayTizenInstrumented) return pc;
        Object.defineProperty(pc, "__vkplayTizenInstrumented", {
          configurable: false,
          value: true
        });

        peerConnections.push(pc);
        summarizePeers();
        addEvent("peer-created", "#" + peerConnections.length);

        var nativeCreateOffer = pc.createOffer.bind(pc);
        pc.createOffer = function () {
          var args = arguments;
          return nativeCreateOffer.apply(pc, args).then(function (description) {
            var patchedSdp = patchSamsungSdp(description.sdp, qualityProfile);
            var count = countSamsungImageAttrs(patchedSdp);
            state.imageAttrCount = Math.max(state.imageAttrCount, count);
            if (count > 0) addEvent("sdp-patched", count + " H.264 payload(s)");
            return { type: description.type, sdp: patchedSdp };
          });
        };

        var nativeSetLocalDescription = pc.setLocalDescription.bind(pc);
        pc.setLocalDescription = function (description) {
          var patched = description;
          if (description && description.sdp) {
            var patchedSdp = patchSamsungSdp(description.sdp, qualityProfile);
            try {
              description.sdp = patchedSdp;
            } catch (_) {}
            patched = { type: description.type, sdp: patchedSdp };
            state.imageAttrCount = Math.max(
              state.imageAttrCount,
              countSamsungImageAttrs(patchedSdp)
            );
          }
          return nativeSetLocalDescription(patched);
        };

        function onPeerState() {
          summarizePeers();
          addEvent(
            "peer-state",
            (pc.connectionState || "?") + " / " + (pc.iceConnectionState || "?")
          );
          queueReport(700);
        }

        pc.addEventListener("connectionstatechange", onPeerState);
        pc.addEventListener("iceconnectionstatechange", onPeerState);
        pc.addEventListener("icecandidateerror", function (event) {
          networkEvent("ice", "error", event.errorCode);
        });
        pc.addEventListener("track", function (event) {
          addEvent("remote-track", event.track ? event.track.kind : "unknown");
          queueReport(700);
        });
        pc.addEventListener("datachannel", function () {
          addEvent("data-channel", "remote");
        });
        return pc;
      }

      function WrappedPeerConnection(configuration, constraints) {
        return instrument(new NativePeerConnection(configuration, constraints));
      }

      WrappedPeerConnection.prototype = NativePeerConnection.prototype;
      try {
        Object.setPrototypeOf(WrappedPeerConnection, NativePeerConnection);
      } catch (_) {}

      win.RTCPeerConnection = WrappedPeerConnection;
      if (win.webkitRTCPeerConnection) {
        win.webkitRTCPeerConnection = WrappedPeerConnection;
      }
      state.rtcShim = true;
      addEvent("rtc-shim", "Samsung imageattr " + qualityProfile + " envelope @ 60 fps");
    }

    function installMediaShim() {
      if (!win.HTMLMediaElement || !win.MediaStream) {
        recordError("media", new Error("HTMLMediaElement or MediaStream is unavailable"));
        return;
      }

      var mediaPrototype = win.HTMLMediaElement.prototype;
      var srcObjectDescriptor = Object.getOwnPropertyDescriptor(
        mediaPrototype,
        "srcObject"
      );
      var mutedDescriptor = Object.getOwnPropertyDescriptor(mediaPrototype, "muted");
      if (!srcObjectDescriptor || !srcObjectDescriptor.set || !srcObjectDescriptor.get) {
        recordError("media", new Error("Native srcObject descriptor is unavailable"));
        return;
      }

      var audioElement = null;
      var videoElement = null;
      var audioStream = null;
      var videoStream = null;
      var combinedStream = null;
      var audioMuted = true;
      var watchedStreams = [];
      var videoDiagnosticsTimer = 0;
      var monitoredVideo = null;
      var videoHandlers = {};
      var videoQualityUnavailable = false;
      var lastVideoSignature = "";
      var lastVideoTotalFrames = null;
      var lastVideoDroppedFrames = null;
      var lastVideoSampleAt = null;

      function isVkAudio(element) {
        return (
          element &&
          element.tagName === "AUDIO" &&
          (element.id === "audio-player" ||
            (element.classList && element.classList.contains("audioPlayer")))
        );
      }

      function isVkVideo(element) {
        return element && element.tagName === "VIDEO" && element.id === "player";
      }

      function nativeSet(element, stream) {
        srcObjectDescriptor.set.call(element, stream);
      }

      function setNativeMuted(element, value) {
        if (mutedDescriptor && mutedDescriptor.set) {
          mutedDescriptor.set.call(element, value);
        } else {
          element.setAttribute("muted", value ? "" : null);
        }
      }

      function updateTrackState() {
        state.videoTracks = videoStream ? videoStream.getVideoTracks().length : 0;
        state.audioTracks = audioStream ? audioStream.getAudioTracks().length : 0;
        state.combinedTracks = combinedStream ? combinedStream.getTracks().length : 0;
      }

      function sampleVideoDiagnostics(reason, emitTrace) {
        try { readVideoDiagnostics(reason, emitTrace); }
        catch (error) { recordError("video-diagnostics", error); }
      }

      function readVideoDiagnostics(reason, emitTrace) {
        if (!videoElement) return;
        var rect = videoElement.getBoundingClientRect();
        var style = win.getComputedStyle(videoElement);
        var quality = null;
        if (!videoQualityUnavailable && typeof videoElement.getVideoPlaybackQuality === "function") {
          try { quality = videoElement.getVideoPlaybackQuality(); }
          catch (_) {
            videoQualityUnavailable = true;
            traceEvent("video-quality", "unavailable; continuing playback");
          }
        }
        var totalFrames = quality && typeof quality.totalVideoFrames === "number" ? quality.totalVideoFrames : null;
        var droppedFrames = quality && typeof quality.droppedVideoFrames === "number" ? quality.droppedVideoFrames : null;
        var now = Date.now();
        var sample = {
          event: reason || "sample",
          intrinsic:
            String(videoElement.videoWidth || 0) + "x" +
            String(videoElement.videoHeight || 0),
          layout:
            Math.round(rect.width) + "x" + Math.round(rect.height) +
            " @" + Math.round(rect.left) + "," + Math.round(rect.top),
          objectFit: style.objectFit || "default",
          position: style.position,
          transform: style.transform,
          cssWidth: style.width,
          cssHeight: style.height,
          viewport: { width: win.innerWidth, height: win.innerHeight },
          readyState: videoElement.readyState,
          paused: videoElement.paused,
          networkState: videoElement.networkState,
          totalFrames: totalFrames,
          droppedFrames: droppedFrames,
          framesSinceLast:
            totalFrames == null || lastVideoTotalFrames == null ? null : Math.max(0, totalFrames - lastVideoTotalFrames),
          droppedSinceLast:
            droppedFrames == null || lastVideoDroppedFrames == null
              ? null
              : Math.max(0, droppedFrames - lastVideoDroppedFrames),
          intervalMs: lastVideoSampleAt == null ? null : now - lastVideoSampleAt,
          sampledAt: new Date(now).toISOString()
        };
        state.diagnostics.video = sample;
        if (totalFrames != null) lastVideoTotalFrames = totalFrames;
        if (droppedFrames != null) lastVideoDroppedFrames = droppedFrames;
        lastVideoSampleAt = now;

        var signature = [
          sample.intrinsic,
          sample.layout,
          sample.objectFit,
          sample.readyState,
          sample.paused
        ].join("|");
        if (emitTrace || signature !== lastVideoSignature) {
          lastVideoSignature = signature;
          traceEvent(
            "video-" + sample.event,
            sample.intrinsic + " → " + sample.layout +
              " fit=" + sample.objectFit +
              " rs=" + sample.readyState +
              " frames=" + (sample.framesSinceLast == null ? "?" : sample.framesSinceLast) +
              " dropped=" + (sample.droppedSinceLast == null ? "?" : sample.droppedSinceLast)
          );
        }
      }

      function installVideoDiagnostics() {
        if (!videoElement || monitoredVideo === videoElement) return;
        if (monitoredVideo) {
          Object.keys(videoHandlers).forEach(function (name) {
            monitoredVideo.removeEventListener(name, videoHandlers[name]);
          });
        }
        monitoredVideo = videoElement;
        lastVideoTotalFrames = lastVideoDroppedFrames = lastVideoSampleAt = null;
        videoQualityUnavailable = false;
        ["loadedmetadata", "resize", "playing", "waiting", "stalled", "suspend", "error"].forEach(
          function (eventName) {
            videoHandlers[eventName] = function () {
              sampleVideoDiagnostics(eventName, true);
            };
            videoElement.addEventListener(eventName, videoHandlers[eventName]);
          }
        );
        if (!videoDiagnosticsTimer) {
          videoDiagnosticsTimer = win.setInterval(function () {
            if (!doc.hidden && videoElement && videoElement.isConnected) sampleVideoDiagnostics("sample", false);
          }, 1000);
        }
        sampleVideoDiagnostics("element-created", true);
      }

      function rebuildCombinedStream() {
        if (!videoElement || !videoStream) {
          combinedStream = null;
          if (videoElement) nativeSet(videoElement, null);
          updateTrackState();
          return;
        }

        var tracks = [];
        var videoTracks = videoStream.getVideoTracks();
        var audioTracks = audioStream ? audioStream.getAudioTracks() : [];
        if (videoTracks[0]) tracks.push(videoTracks[0]);
        if (audioTracks[0]) tracks.push(audioTracks[0]);

        combinedStream = new win.MediaStream(tracks);
        nativeSet(videoElement, combinedStream);
        installVideoDiagnostics();
        setNativeMuted(videoElement, tracks.length > 1 ? audioMuted : true);
        videoElement.setAttribute("playsinline", "");
        videoElement.setAttribute("disablepictureinpicture", "");
        if (typeof videoElement.play === "function") {
          var playResult = videoElement.play();
          if (playResult && typeof playResult.catch === "function") {
            playResult.catch(function (error) {
              addEvent("video-play-pending", errorText(error));
            });
          }
        }

        updateTrackState();
        sampleVideoDiagnostics("stream-rebuilt", true);
        addEvent(
          "media-combined",
          state.videoTracks + " video + " + state.audioTracks + " audio"
        );
        queueReport(500);
      }

      function watchStream(stream) {
        if (!stream || watchedStreams.indexOf(stream) !== -1) return;
        watchedStreams.push(stream);
        stream.addEventListener("addtrack", rebuildCombinedStream);
        stream.addEventListener("removetrack", rebuildCombinedStream);
      }

      function unwatchStream(stream) {
        if (!stream) return;
        stream.removeEventListener("addtrack", rebuildCombinedStream);
        stream.removeEventListener("removetrack", rebuildCombinedStream);
        var index = watchedStreams.indexOf(stream);
        if (index !== -1) watchedStreams.splice(index, 1);
      }

      Object.defineProperty(mediaPrototype, "srcObject", {
        configurable: srcObjectDescriptor.configurable !== false,
        enumerable: srcObjectDescriptor.enumerable,
        get: function () {
          return srcObjectDescriptor.get.call(this);
        },
        set: function (stream) {
          if (isVkAudio(this)) {
            if (audioStream !== stream) unwatchStream(audioStream);
            audioElement = this;
            audioStream = stream;
            watchStream(stream);
            nativeSet(this, new win.MediaStream());
            rebuildCombinedStream();
            return;
          }

          if (isVkVideo(this)) {
            if (videoStream !== stream) unwatchStream(videoStream);
            videoElement = this;
            videoStream = stream;
            if (!stream) {
              unwatchStream(audioStream);
              audioStream = null;
              stopStreamMouseInput();
              vkInputBridge.token = null;
              addEvent("media-cleared", "released previous session tracks");
            }
            watchStream(stream);
            rebuildCombinedStream();
            return;
          }

          srcObjectDescriptor.set.call(this, stream);
        }
      });

      if (mutedDescriptor && mutedDescriptor.set && mutedDescriptor.get) {
        Object.defineProperty(mediaPrototype, "muted", {
          configurable: mutedDescriptor.configurable !== false,
          enumerable: mutedDescriptor.enumerable,
          get: function () {
            return mutedDescriptor.get.call(this);
          },
          set: function (value) {
            if (isVkAudio(this)) {
              audioMuted = Boolean(value);
              mutedDescriptor.set.call(this, true);
              if (videoElement && combinedStream) {
                setNativeMuted(videoElement, audioMuted);
                if (!audioMuted && typeof videoElement.play === "function") {
                  var playResult = videoElement.play();
                  if (playResult && typeof playResult.catch === "function") {
                    playResult.catch(function () {});
                  }
                }
              }
              return;
            }

            if (isVkVideo(this) && combinedStream && state.audioTracks > 0) {
              mutedDescriptor.set.call(this, audioMuted);
              return;
            }

            mutedDescriptor.set.call(this, value);
          }
        });
      }

      doc.addEventListener("visibilitychange", function () {
        var enabled = !doc.hidden;
        [videoStream, audioStream].forEach(function (stream) {
          if (!stream) return;
          stream.getTracks().forEach(function (track) {
            track.enabled = enabled;
          });
        });
        addEvent("visibility", enabled ? "foreground" : "background");
      });

      state.mediaShim = true;
      addEvent("media-shim", "single video element with audio + video tracks");
    }

    function installFullscreenShim() {
      var elementPrototype = win.Element && win.Element.prototype;
      var documentPrototype = win.Document && win.Document.prototype;
      if (!elementPrototype || !documentPrototype) return;

      // VK listens to the prefixed event even if a modern browser/remote
      // action uses the standard API. Forward only if no native prefixed
      // event arrived for this transition.
      var prefixedEvents = 0;
      doc.addEventListener("webkitfullscreenchange", function () { prefixedEvents += 1; });
      doc.addEventListener("fullscreenchange", function () {
        var before = prefixedEvents;
        var fullscreen = doc.fullscreenElement;
        win.setTimeout(function () {
          if (before === prefixedEvents && fullscreen === doc.fullscreenElement) {
            doc.dispatchEvent(new win.Event("webkitfullscreenchange", { bubbles: true }));
          }
        }, 0);
      });

      function refreshFullscreenState() {
        var rootElement = doc.documentElement;
        state.fullscreenShim = Boolean(
          rootElement &&
            (rootElement.webkitRequestFullscreen || rootElement.requestFullscreen)
        );
        renderOverlay();
      }

      if (!elementPrototype.webkitRequestFullscreen && elementPrototype.requestFullscreen) {
        elementPrototype.webkitRequestFullscreen = function () {
          return this.requestFullscreen({ navigationUI: "hide" });
        };
      }
      if (!documentPrototype.webkitExitFullscreen && documentPrototype.exitFullscreen) {
        documentPrototype.webkitExitFullscreen = function () {
          return this.exitFullscreen();
        };
      }

      if (!nav.keyboard) {
        try {
          Object.defineProperty(nav, "keyboard", {
            configurable: true,
            value: {
              lock: function () {
                return Promise.resolve();
              },
              unlock: function () {}
            }
          });
        } catch (_) {}
      } else {
        if (typeof nav.keyboard.lock !== "function") {
          nav.keyboard.lock = function () {
            return Promise.resolve();
          };
        }
        if (typeof nav.keyboard.unlock !== "function") {
          nav.keyboard.unlock = function () {};
        }
      }

      refreshFullscreenState();
      if (!doc.documentElement) {
        doc.addEventListener("DOMContentLoaded", refreshFullscreenState, {
          once: true
        });
      }
      addEvent(
        "fullscreen-shim",
        state.fullscreenShim ? "ready" : "waiting for document"
      );
    }

    function normalizeActionText(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }

    function isVisibleElement(node) {
      if (!node || !node.getBoundingClientRect) return false;
      var rect = node.getBoundingClientRect();
      var style = win.getComputedStyle(node);
      return (
        rect.width > 1 &&
        rect.height > 1 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        !node.hidden
      );
    }

    function isVkIdActionText(value) {
      var text = normalizeActionText(value);
      if (!text || text.length > 100) return false;
      return (
        /^vk\s*id$/.test(text) ||
        /(войти|продолжить|авториз)[^\n]{0,45}vk\s*id/.test(text) ||
        /vk\s*id[^\n]{0,45}(войти|продолжить|авториз)/.test(text)
      );
    }

    function prepareVkIdActions() {
      var nodes = doc.querySelectorAll("button,a,div,span,[role='button']");
      var actions = [];
      Array.prototype.forEach.call(nodes, function (node) {
        if (!isVisibleElement(node) || !isVkIdActionText(node.textContent)) return;

        var childHasSameAction = Array.prototype.some.call(
          node.children || [],
          function (child) {
            return isVisibleElement(child) && isVkIdActionText(child.textContent);
          }
        );
        if (childHasSameAction) return;

        node.setAttribute("data-vkplay-tv-auth", "true");
        if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "0");
        if (!node.hasAttribute("role")) node.setAttribute("role", "button");
        actions.push(node);
      });
      return actions;
    }

    function prepareVkIdFrames() {
      var frames = doc.querySelectorAll("iframe[src]");
      var actions = [];
      Array.prototype.forEach.call(frames, function (frame) {
        var source = String(frame.getAttribute("src") || "").toLowerCase();
        if (
          !isVisibleElement(frame) ||
          (source.indexOf("id.vk.ru/") === -1 &&
            source.indexOf("id.vk.com/") === -1)
        ) {
          return;
        }
        frame.setAttribute("data-vkplay-tv-auth-frame", "true");
        frame.setAttribute("tabindex", "0");
        frame.setAttribute("aria-label", "Войти через VK ID");
        actions.push(frame);
      });
      return actions;
    }

    function findVkIdAction() {
      var prepared = prepareVkIdActions();
      if (prepared.length) return prepared[0];
      var frames = prepareVkIdFrames();
      if (frames.length) return frames[0];
      var existing = doc.querySelector("[data-vkplay-tv-auth='true']");
      return isVisibleElement(existing) ? existing : null;
    }

    function focusElement(node) {
      if (!node) return false;
      try {
        node.focus();
        node.scrollIntoView({ block: "center", inline: "center" });
        if (
          node.tagName === "IFRAME" &&
          node.contentWindow &&
          typeof node.contentWindow.focus === "function"
        ) {
          node.contentWindow.focus();
        }
        return true;
      } catch (error) {
        recordError("focus", error);
        return false;
      }
    }

    function activateVkIdAction(source) {
      var action = findVkIdAction();
      if (!action) return false;
      try {
        focusElement(action);
        addEvent("vk-id", source || "activate");
        if (action.tagName !== "IFRAME") action.click();
        return true;
      } catch (error) {
        recordError("vk-id", error);
        return false;
      }
    }

    function installVkIdNavigation() {
      function scan() {
        if (hasActiveGameStream()) return;
        win.clearTimeout(authScanTimer);
        authScanTimer = win.setTimeout(function () {
          if (hasActiveGameStream()) return;
          var actions = prepareVkIdActions().concat(prepareVkIdFrames());
          if (
            actions.length &&
            (!doc.activeElement ||
              doc.activeElement === doc.body ||
              doc.activeElement === doc.documentElement)
          ) {
            focusElement(actions[0]);
          }
        }, 100);
      }

      if (doc.body && win.MutationObserver) {
        new win.MutationObserver(scan).observe(doc.body, {
          childList: true,
          subtree: true
        });
      } else {
        doc.addEventListener(
          "DOMContentLoaded",
          function () {
            if (doc.body && win.MutationObserver) {
              new win.MutationObserver(scan).observe(doc.body, {
                childList: true,
                subtree: true
              });
            }
            scan();
          },
          { once: true }
        );
      }
      scan();
      addEvent("vk-id-navigation", "focus + Enter / gamepad Cross / blue key");
    }

    function visibleFocusableElements() {
      var selector = [
        "a[href]",
        "button:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        "iframe[data-vkplay-tv-auth-frame='true']",
        "[role='button']",
        "[tabindex]:not([tabindex='-1'])",
        "[data-vkplay-tv-auth='true']"
      ].join(",");
      return Array.prototype.filter.call(doc.querySelectorAll(selector), function (node) {
        return isVisibleElement(node);
      });
    }

    function moveFocus(direction) {
      var nodes = visibleFocusableElements();
      if (!nodes.length) return false;
      var active = doc.activeElement;
      if (nodes.indexOf(active) === -1) {
        return focusElement(nodes[0]);
      }

      var current = active.getBoundingClientRect();
      var currentX = current.left + current.width / 2;
      var currentY = current.top + current.height / 2;
      var best = null;
      var bestScore = Infinity;

      nodes.forEach(function (node) {
        if (node === active) return;
        var rect = node.getBoundingClientRect();
        var dx = rect.left + rect.width / 2 - currentX;
        var dy = rect.top + rect.height / 2 - currentY;
        var primary;
        var cross;

        if (direction === "left" && dx < -1) {
          primary = -dx;
          cross = Math.abs(dy);
        } else if (direction === "right" && dx > 1) {
          primary = dx;
          cross = Math.abs(dy);
        } else if (direction === "up" && dy < -1) {
          primary = -dy;
          cross = Math.abs(dx);
        } else if (direction === "down" && dy > 1) {
          primary = dy;
          cross = Math.abs(dx);
        } else {
          return;
        }

        var score = primary + cross * 0.35;
        if (score < bestScore) {
          best = node;
          bestScore = score;
        }
      });

      if (!best) return false;
      return focusElement(best);
    }

    function readGamepads() {
      try {
        return nativeGetGamepads ? nativeGetGamepads() || [] : [];
      } catch (error) {
        recordError("gamepad-read", error);
        return [];
      }
    }

    function gamepadButtonPressed(button) {
      return Boolean(button && (button.pressed || button.value > 0.55));
    }

    function neutralGamepadForVk(pad) {
      return {
        id: pad.id,
        index: pad.index,
        connected: pad.connected,
        mapping: pad.mapping,
        timestamp: pad.timestamp,
        axes: Array.prototype.map.call(pad.axes || [], function () { return 0; }),
        buttons: neutralGamepadButtons((pad.buttons || []).length),
        hand: pad.hand,
        pose: pad.pose,
        vibrationActuator: pad.vibrationActuator,
        hapticActuators: pad.hapticActuators
      };
    }

    function vkGamepadsForPlayer() {
      vkGamepadPollCount += 1;
      var raw = readGamepads();
      var output = Array.prototype.slice.call(raw || []);
      var menuCombo = output.some(function (pad) {
        return pad && gamepadButtonPressed(pad.buttons[8]) && gamepadButtonPressed(pad.buttons[9]);
      });
      if (logsVisible || state.streamMenuOpen || menuCombo) return output.map(function (pad) {
        return pad ? neutralGamepadForVk(pad) : pad;
      });
      if (!streamMouseMode && !vkMouseComboLatched) return output;
      if (vkInputBridge.token == null) return output;

      for (var index = 0; index < output.length; index += 1) {
        var pad = output[index];
        if (!pad) continue;
        if (
          streamMouseMode ||
          pad.index === vkMouseComboGamepadIndex
        ) {
          output[index] = neutralGamepadForVk(pad);
        }
      }
      return output;
    }

    function dispatchGamepadLifecycle(type, pad) {
      if (!pad) return false;
      var event = null;
      try {
        if (typeof win.GamepadEvent === "function") {
          event = new win.GamepadEvent(type, { gamepad: pad });
        }
      } catch (constructorError) {
        event = null;
      }
      if (!event) {
        try {
          event = new win.Event(type);
          Object.defineProperty(event, "gamepad", {
            configurable: true,
            value: pad
          });
        } catch (fallbackError) {
          recordError("vk-gamepad-event", fallbackError);
          return false;
        }
      }
      try {
        Object.defineProperty(event, "__vkplayTizenSynthetic", {
          configurable: true,
          value: true
        });
      } catch (markError) {
        recordError("vk-gamepad-mark", markError);
      }
      try {
        win.dispatchEvent(event);
        return true;
      } catch (dispatchError) {
        recordError("vk-gamepad-dispatch", dispatchError);
        return false;
      }
    }

    function installVkMouseComboShim() {
      if (!nativeGetGamepads || vkMouseComboShimInstalled) return;
      try {
        Object.defineProperty(nav, "getGamepads", {
          configurable: true,
          value: vkGamepadsForPlayer
        });
        vkMouseComboShimInstalled = nav.getGamepads === vkGamepadsForPlayer;
      } catch (error) {
        try {
          Object.defineProperty(Object.getPrototypeOf(nav), "getGamepads", {
            configurable: true,
            value: vkGamepadsForPlayer
          });
          vkMouseComboShimInstalled = nav.getGamepads === vkGamepadsForPlayer;
        } catch (prototypeError) {
          recordError("vk-mouse-combo-shim", prototypeError || error);
        }
      }
      state.vkMouseComboShim = vkMouseComboShimInstalled
        ? "ready"
        : "direct-only";
      addEvent(
        "vk-mouse-combo-shim",
        vkMouseComboShimInstalled ? "ready" : "direct mouse without neutralizer"
      );
    }

    function updateVkMouseCombo(pad, streamActive) {
      if (!pad || !streamActive) {
        if (!streamActive) {
          if (streamMouseMode) stopStreamMouseInput();
          streamMouseInputActive = false;
          vkMouseComboGamepadIndex = -1;
          vkMouseComboLatched = false;
          streamMouseMode = false;
          state.streamMouseMode = false;
        }
        return;
      }
      var shouldersPressed =
        gamepadButtonPressed(pad.buttons[4]) &&
        gamepadButtonPressed(pad.buttons[5]);
      var optionsPressed =
        gamepadButtonPressed(pad.buttons[8]) ||
        gamepadButtonPressed(pad.buttons[9]);
      var comboPressed = shouldersPressed && optionsPressed;

      if (comboPressed && !vkMouseComboLatched) {
        vkMouseComboLatched = true;
        vkMouseComboGamepadIndex = pad.index;
        streamMouseMode = !streamMouseMode;
        if (!streamMouseMode) stopStreamMouseInput();
        state.streamMouseMode = streamMouseMode;
        state.vkMouseComboCount += 1;
        state.inputMode = streamMouseMode ? "vk-virtual-mouse" : "vk-gamepad";
        addEvent(
          "vk-mouse-combo",
          streamMouseMode ? (vkInputBridge.token == null ? "mouse requested; native input not ready" : "VK native mouse enabled") : "gamepad enabled"
        );
      } else if (!comboPressed && vkMouseComboLatched) {
        vkMouseComboLatched = false;
      }
    }

    function firstConnectedGamepad() {
      var pads = readGamepads();
      for (var index = 0; index < pads.length; index += 1) {
        if (pads[index]) return pads[index];
      }
      return null;
    }

    function hasActiveGameStream() {
      var player = doc.getElementById("player");
      var stream = player && player.srcObject;
      return Boolean(
        stream &&
          typeof stream.getVideoTracks === "function" &&
          stream.getVideoTracks().some(function (track) { return track.readyState !== "ended"; })
      );
    }

    function interactiveCursorTarget(node) {
      if (!node || node === virtualCursor || node === virtualCursorHint) return null;
      if (typeof node.closest !== "function") return node;
      return (
        node.closest(
          "a[href],button,input,select,textarea,[role='button']," +
            "[onclick],[tabindex]:not([tabindex='-1'])"
        ) || node
      );
    }

    function setVirtualCursorTarget(node) {
      var target = interactiveCursorTarget(node);
      if (target === virtualCursorTarget) return target;
      if (virtualCursorTarget && virtualCursorTarget.removeAttribute) {
        virtualCursorTarget.removeAttribute("data-vkplay-tv-pointer-target");
      }
      virtualCursorTarget = target;
      if (virtualCursorTarget && virtualCursorTarget.setAttribute) {
        virtualCursorTarget.setAttribute("data-vkplay-tv-pointer-target", "true");
      }
      return target;
    }

    function targetUnderVirtualCursor() {
      return setVirtualCursorTarget(
        doc.elementFromPoint(
          Math.max(0, Math.min(win.innerWidth - 1, virtualCursorX)),
          Math.max(0, Math.min(win.innerHeight - 1, virtualCursorY))
        )
      );
    }

    function dispatchPointerEvent(target, type, button, buttons) {
      if (!target || typeof target.dispatchEvent !== "function") return false;
      var common = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: win,
        clientX: Math.round(virtualCursorX),
        clientY: Math.round(virtualCursorY),
        screenX: Math.round(virtualCursorX),
        screenY: Math.round(virtualCursorY),
        button: button || 0,
        buttons: buttons || 0
      };
      try {
        if (win.PointerEvent && type.indexOf("pointer") === 0) {
          target.dispatchEvent(
            new win.PointerEvent(type, Object.assign({}, common, {
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true
            }))
          );
        } else {
          target.dispatchEvent(new win.MouseEvent(type, common));
        }
        return true;
      } catch (error) {
        recordError("virtual-cursor-event", error);
        return false;
      }
    }

    function dispatchVirtualCursorMove() {
      var target = targetUnderVirtualCursor();
      if (!target) return;
      dispatchPointerEvent(target, "pointermove", 0, 0);
      dispatchPointerEvent(target, "mousemove", 0, 0);
    }

    function pressVirtualCursor() {
      var target = targetUnderVirtualCursor();
      if (!target) return;
      virtualCursorPressTarget = target;
      focusElement(target);
      dispatchPointerEvent(target, "pointerdown", 0, 1);
      dispatchPointerEvent(target, "mousedown", 0, 1);
    }

    function releaseVirtualCursor() {
      var target = virtualCursorPressTarget || targetUnderVirtualCursor();
      virtualCursorPressTarget = null;
      if (!target) return;
      dispatchPointerEvent(target, "pointerup", 0, 0);
      dispatchPointerEvent(target, "mouseup", 0, 0);
      if (typeof target.click === "function") target.click();
      else dispatchPointerEvent(target, "click", 0, 0);
      addEvent("virtual-cursor", "click");
    }

    function scrollVirtualCursor(deltaY) {
      var target = targetUnderVirtualCursor() || doc.body;
      if (!target) return;
      try {
        var accepted = target.dispatchEvent(
          new win.WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            view: win,
            clientX: Math.round(virtualCursorX),
            clientY: Math.round(virtualCursorY),
            deltaY: deltaY,
            deltaMode: 0
          })
        );
        if (!accepted) return; // A custom scroller consumed the wheel.
      } catch (_) {}
      // Synthetic wheels have no native scrolling default action. Walk the
      // scroll chain, including nested catalog containers, not just window.
      for (var node = target; node && node !== doc.documentElement; node = node.parentElement) {
        var style = win.getComputedStyle(node);
        if (!/(auto|scroll|overlay)/.test(style.overflowY)) continue;
        if (node.scrollHeight <= node.clientHeight) continue;
        var before = node.scrollTop;
        node.scrollTop += deltaY;
        if (node.scrollTop !== before || /contain|none/.test(style.overscrollBehaviorY)) return;
      }
      var root = doc.scrollingElement || doc.documentElement;
      if (root) root.scrollTop += deltaY;
    }

    function createStreamMouseEvent(type, button, buttons, deltaX, deltaY) {
      var event;
      var options = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: win,
        clientX: Math.round(virtualCursorX),
        clientY: Math.round(virtualCursorY),
        screenX: Math.round(virtualCursorX),
        screenY: Math.round(virtualCursorY),
        button: button == null ? 0 : button,
        buttons: buttons || 0,
        movementX: deltaX || 0,
        movementY: deltaY || 0
      };

      try {
        event = new win.MouseEvent(type, options);
      } catch (_) {
        event = doc.createEvent("MouseEvent");
        event.initMouseEvent(
          type,
          true,
          true,
          win,
          0,
          options.screenX,
          options.screenY,
          options.clientX,
          options.clientY,
          false,
          false,
          false,
          false,
          options.button,
          null
        );
      }

      try {
        Object.defineProperty(event, "movementX", {
          configurable: true,
          value: deltaX || 0
        });
        Object.defineProperty(event, "movementY", {
          configurable: true,
          value: deltaY || 0
        });
        Object.defineProperty(event, "buttons", {
          configurable: true,
          value: buttons || 0
        });
      } catch (_) {}

      return event;
    }

    function dispatchStreamMouseMove(deltaX, deltaY) {
      if (!deltaX && !deltaY) return;
      if (
        sendVkNativeMouse(vkInputBridge, "move", {
          deltaX: deltaX,
          deltaY: deltaY,
          absX: Math.round(virtualCursorX),
          absY: Math.round(virtualCursorY)
        })
      ) {
        return;
      }
      try {
        win.dispatchEvent(
          createStreamMouseEvent("mousemove", 0, 0, deltaX, deltaY)
        );
        win.dispatchEvent(
          createStreamMouseEvent("pointerrawupdate", 0, 0, deltaX, deltaY)
        );
      } catch (error) {
        recordError("stream-mouse-move", error);
      }
    }

    function dispatchStreamMouseButton(type, button, buttons) {
      if (
        sendVkNativeMouse(
          vkInputBridge,
          type === "mousedown" ? "press" : "release",
          {
            buttonID: button,
            absX: Math.round(virtualCursorX),
            absY: Math.round(virtualCursorY)
          }
        )
      ) {
        return;
      }
      try {
        win.dispatchEvent(createStreamMouseEvent(type, button, buttons, 0, 0));
      } catch (error) {
        recordError("stream-mouse-button", error);
      }
    }

    function dispatchStreamMouseWheel(deltaY) {
      var event;
      if (
        sendVkNativeMouse(vkInputBridge, "scroll", {
          deltaZ: Math.round(deltaY),
          absX: Math.round(virtualCursorX),
          absY: Math.round(virtualCursorY)
        })
      ) {
        return;
      }
      try {
        if (typeof win.WheelEvent === "function") {
          event = new win.WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            view: win,
            clientX: Math.round(virtualCursorX),
            clientY: Math.round(virtualCursorY),
            deltaY: deltaY,
            deltaMode: 0
          });
        } else {
          event = doc.createEvent("Event");
          event.initEvent("wheel", true, true);
          Object.defineProperty(event, "deltaY", {
            configurable: true,
            value: deltaY
          });
        }
        win.dispatchEvent(event);
      } catch (error) {
        recordError("stream-mouse-wheel", error);
      }
    }

    function stopStreamMouseInput() {
      var leftPressed = Boolean(virtualCursorButtons[0]);
      var rightPressed = Boolean(virtualCursorButtons[1]);
      if (leftPressed) {
        dispatchStreamMouseButton("mouseup", 0, rightPressed ? 2 : 0);
      }
      if (rightPressed) {
        dispatchStreamMouseButton("mouseup", 2, 0);
      }
      virtualCursorButtons = [];
      virtualCursorPressTarget = null;
      streamMouseLastWheelAt = 0;
    }

    function processStreamMouseInput(pad, elapsed, timestamp) {
      var axisX = normalizedCursorAxis(pad.axes[0]);
      var axisY = normalizedCursorAxis(pad.axes[1]);
      var speed = Math.max(
        900,
        Math.min(win.innerWidth, win.innerHeight) * 1.25
      );
      var deltaX = Math.round(axisX * speed * elapsed / 1000);
      var deltaY = Math.round(axisY * speed * elapsed / 1000);

      if (deltaX || deltaY) {
        virtualCursorX = Math.max(
          0,
          Math.min(win.innerWidth, virtualCursorX + deltaX)
        );
        virtualCursorY = Math.max(
          0,
          Math.min(win.innerHeight, virtualCursorY + deltaY)
        );
        dispatchStreamMouseMove(deltaX, deltaY);
      }

      var leftPressed = gamepadButtonPressed(pad.buttons[0]);
      var rightPressed = gamepadButtonPressed(pad.buttons[1]);
      var previousLeft = Boolean(virtualCursorButtons[0]);
      var previousRight = Boolean(virtualCursorButtons[1]);
      var buttons = (leftPressed ? 1 : 0) | (rightPressed ? 2 : 0);

      if (leftPressed !== previousLeft) {
        dispatchStreamMouseButton(
          leftPressed ? "mousedown" : "mouseup",
          0,
          buttons
        );
      }
      if (rightPressed !== previousRight) {
        dispatchStreamMouseButton(
          rightPressed ? "mousedown" : "mouseup",
          2,
          buttons
        );
      }

      var scrollAxis = normalizedCursorAxis(pad.axes[3]);
      if (scrollAxis && timestamp - streamMouseLastWheelAt >= 80) {
        streamMouseLastWheelAt = timestamp;
        dispatchStreamMouseWheel(scrollAxis * 34);
      }

      virtualCursorButtons = Array.prototype.map.call(
        pad.buttons,
        function (button) {
          return gamepadButtonPressed(button);
        }
      );
    }

    function normalizedCursorAxis(value) {
      var deadzone = 0.16;
      var absolute = Math.abs(value || 0);
      if (absolute <= deadzone) return 0;
      var normalized = (absolute - deadzone) / (1 - deadzone);
      return (value < 0 ? -1 : 1) * Math.pow(normalized, 1.55);
    }

    function showCursorMode(streamActive) {
      if (!virtualCursor || !virtualCursorHint) return;
      // Help is available in the yellow-key panel, never over the game.
      if (virtualCursorHint.style.display !== "none") virtualCursorHint.style.display = "none";
      if (streamActive) {
        if (virtualCursor.style.display !== "none") {
          virtualCursor.style.display = "none";
        }
        var streamHint = streamMouseMode
          ? "МЫШЬ VK: левый стик · × левый клик · ○ правый клик · правый стик прокрутка · родной канал: " +
            (vkInputBridge.token == null ? "подключается" : "готов") +
            " · L1+R1+Options — геймпад"
          : "ГЕЙМПАД VK · L1 + R1 + Options — включить мышь";
        if (lastStreamHintText !== streamHint) {
          lastStreamHintText = streamHint;
          virtualCursorHint.textContent = streamHint;
        }
        if (lastStreamHintMode !== "stream") {
          lastStreamHintMode = "stream";
          virtualCursorHint.setAttribute("data-stream", "true");
        }
        if (!streamHintVisible) {
          streamHintVisible = true;
          state.inputMode = "vk-stream";
          addEvent("input-mode", "VK stream; L1+R1+Options toggles virtual mouse");
        }
      } else {
        if (virtualCursor.style.display !== "block") {
          virtualCursor.style.display = "block";
        }
        var dashboardHint =
          "Стик: курсор · ×: нажать · правый стик: прокрутка · ○: назад";
        if (lastStreamHintText !== dashboardHint) {
          lastStreamHintText = dashboardHint;
          virtualCursorHint.textContent = dashboardHint;
        }
        if (lastStreamHintMode !== "dashboard") {
          lastStreamHintMode = "dashboard";
          virtualCursorHint.setAttribute("data-stream", "false");
        }
        if (streamHintVisible) {
          streamHintVisible = false;
          state.inputMode = "tv-cursor";
          addEvent("input-mode", "TV cursor");
        }
      }
    }

    function installVirtualCursor() {
      if (!isTopLevelContext) return;
      var shellSampleStartedAt = 0;
      var shellFrames = 0;
      var shellFrameTotal = 0;
      var shellFrameMax = 0;
      var shellLongFrames = 0;

      function sampleShellPerformance(timestamp, elapsed) {
        if (!shellSampleStartedAt) shellSampleStartedAt = timestamp;
        shellFrames += 1;
        shellFrameTotal += elapsed;
        shellFrameMax = Math.max(shellFrameMax, elapsed);
        if (elapsed > 34) shellLongFrames += 1;
        if (timestamp - shellSampleStartedAt < 1000) return;

        state.diagnostics.shell = {
          fps: Math.round(shellFrames * 1000 / (timestamp - shellSampleStartedAt)),
          averageFrameMs: Math.round(shellFrameTotal / shellFrames * 10) / 10,
          maxFrameMs: Math.round(shellFrameMax * 10) / 10,
          longFrames: shellLongFrames,
          sampledAt: new Date().toISOString()
        };
        shellSampleStartedAt = timestamp;
        shellFrames = 0;
        shellFrameTotal = 0;
        shellFrameMax = 0;
        shellLongFrames = 0;
      }

      function mount() {
        if (!doc.body || virtualCursor) return;
        virtualCursor = doc.createElement("div");
        virtualCursor.id = "vkplay-tizen-tv-cursor";
        virtualCursor.setAttribute("aria-hidden", "true");
        virtualCursorHint = doc.createElement("div");
        virtualCursorHint.id = "vkplay-tizen-tv-input-hint";
        virtualCursorHint.setAttribute("aria-hidden", "true");
        doc.body.appendChild(virtualCursor);
        doc.body.appendChild(virtualCursorHint);
        virtualCursorX = win.innerWidth / 2;
        virtualCursorY = win.innerHeight / 2;
        virtualCursor.style.left = virtualCursorX + "px";
        virtualCursor.style.top = virtualCursorY + "px";
        showCursorMode(hasActiveGameStream());
        targetUnderVirtualCursor();
      }

      function frame(timestamp) {
        if (!virtualCursor) mount();
        if (logsVisible) {
          if (virtualCursor) virtualCursor.style.display = "none";
          virtualCursorLastFrame = timestamp;
          win.requestAnimationFrame(frame);
          return;
        }
        var streamActive = hasActiveGameStream();
        var elapsed = virtualCursorLastFrame
          ? timestamp - virtualCursorLastFrame
          : 16;
        sampleShellPerformance(timestamp, elapsed);

        var pad = firstConnectedGamepad();
        var menuCombo = Boolean(pad && gamepadButtonPressed(pad.buttons[8]) && gamepadButtonPressed(pad.buttons[9]));
        if (menuCombo && !streamMenuComboLatched && streamActive) openStreamMenu("Create+Options");
        streamMenuComboLatched = menuCombo;
        if (!streamActive) state.streamMenuOpen = false;
        if (!state.streamMenuOpen) updateVkMouseCombo(pad, streamActive);
        if (vkGamepadRegistrar) {
          vkGamepadRegistrar.update(pad, streamActive, timestamp);
          state.vkGamepadRegistration = vkGamepadRegistrar.status();
          state.vkGamepadAnnounces = vkGamepadRegistrar.announces();
          state.vkGamepadPollRate = vkGamepadRegistrar.pollRate();
        }
        var streamInput = streamActive && !state.streamMenuOpen;
        showCursorMode(streamInput);

        elapsed = Math.min(50, elapsed);

        if (!streamInput && pad && virtualCursor) {
          var axisX = normalizedCursorAxis(pad.axes[0]);
          var axisY = normalizedCursorAxis(pad.axes[1]);
          var speed = Math.max(900, Math.min(win.innerWidth, win.innerHeight) * 1.25);
          var moved = axisX !== 0 || axisY !== 0;

          if (moved) {
            virtualCursorX = Math.max(
              8,
              Math.min(win.innerWidth - 8, virtualCursorX + axisX * speed * elapsed / 1000)
            );
            virtualCursorY = Math.max(
              8,
              Math.min(win.innerHeight - 8, virtualCursorY + axisY * speed * elapsed / 1000)
            );
            virtualCursor.style.left = virtualCursorX + "px";
            virtualCursor.style.top = virtualCursorY + "px";
            dispatchVirtualCursorMove();
          }

          var confirmPressed = Boolean(
            pad.buttons[0] && (pad.buttons[0].pressed || pad.buttons[0].value > 0.55)
          );
          var backPressed = Boolean(
            pad.buttons[1] && (pad.buttons[1].pressed || pad.buttons[1].value > 0.55)
          );

          if (confirmPressed && !virtualCursorButtons[0]) pressVirtualCursor();
          if (!confirmPressed && virtualCursorButtons[0]) releaseVirtualCursor();
          if (backPressed && !virtualCursorButtons[1] && !state.streamMenuOpen) goBack();

          var scrollAxis = normalizedCursorAxis(pad.axes[3]);
          if (scrollAxis) scrollVirtualCursor(scrollAxis * 2040 * elapsed / 1000);
          virtualCursorButtons = Array.prototype.map.call(
            pad.buttons,
            function (button) {
              return Boolean(button && (button.pressed || button.value > 0.55));
            }
          );
        } else if (streamInput && streamMouseMode && pad) {
          streamMouseInputActive = true;
          processStreamMouseInput(pad, elapsed, timestamp);
        } else if (streamActive && streamMouseInputActive) {
          stopStreamMouseInput();
          streamMouseInputActive = false;
        }

        virtualCursorLastFrame = timestamp;
        win.requestAnimationFrame(frame);
      }

      if (doc.body) mount();
      else doc.addEventListener("DOMContentLoaded", mount, { once: true });
      win.addEventListener("resize", function () {
        virtualCursorX = Math.max(8, Math.min(win.innerWidth - 8, virtualCursorX));
        virtualCursorY = Math.max(8, Math.min(win.innerHeight - 8, virtualCursorY));
      });
      win.requestAnimationFrame(frame);
      addEvent("virtual-cursor", "left stick + Cross; right stick scroll");
    }

    function activateFocusedElement(source) {
      var active = doc.activeElement;
      if (!active || active === doc.body || active === doc.documentElement) {
        return false;
      }

      if (active.tagName === "IFRAME") {
        focusElement(active);
        addEvent("auth-frame", source || "focus");
        return true;
      }

      if (typeof active.click !== "function") return false;
      try {
        active.click();
        addEvent("activate", source || active.tagName);
        return true;
      } catch (error) {
        recordError("activate", error);
        return false;
      }
    }

    function goBack() {
      var exit = doc.webkitExitFullscreen || doc.exitFullscreen;
      if (doc.webkitFullscreenElement || doc.fullscreenElement) {
        if (exit) exit.call(doc);
      } else if (win.history.length > 1) {
        win.history.back();
      }
    }

    function openStreamMenu(source) {
      if (!hasActiveGameStream()) return false;
      if (state.streamMenuOpen) return true;
      stopStreamMouseInput();
      streamMouseInputActive = false;
      virtualCursorButtons = [];
      state.streamMenuOpen = true;
      // VK's InputLockToggler opens PlayerNoErrorMenuOverlay on fullscreen
      // exit. A fabricated Escape cannot perform the browser's default exit.
      try {
        if (doc.pointerLockElement && doc.exitPointerLock) doc.exitPointerLock();
        var exit = doc.exitFullscreen || doc.webkitExitFullscreen;
        if ((doc.fullscreenElement || doc.webkitFullscreenElement) && exit) {
          var result = exit.call(doc);
          if (result && result.catch) result.catch(function (error) {
            state.streamMenuOpen = false;
            recordError("stream-menu", error);
          });
        } else {
          doc.dispatchEvent(new win.Event("webkitfullscreenchange", { bubbles: true }));
        }
        addEvent("stream-menu", source);
      } catch (error) {
        state.streamMenuOpen = false;
        recordError("stream-menu", error);
        return false;
      }
      return true;
    }

    function isGameFullscreen() {
      var fullscreen = doc.webkitFullscreenElement || doc.fullscreenElement;
      return Boolean(fullscreen && hasActiveGameStream());
    }

    function requestFullscreen() {
      if (state.streamMenuOpen && hasActiveGameStream()) {
        // VK's Continue handler hides Fl/kl before entering fullscreen. A raw
        // fullscreen request leaves its menu open and makes Continue a no-op.
        // Use only the observed menu/button contract, never a catalog action.
        var buttons = doc.querySelectorAll("[class*='Menu_container'] button[class*='Item_button']");
        for (var index = 0; index < buttons.length; index += 1) {
          var button = buttons[index];
          var label = normalizeActionText(button.textContent);
          if (!button.disabled && isVisibleElement(button) &&
              (label === "продолжить сессию" || label === "continue session")) {
            button.click();
            addEvent("stream-menu", "continue-action");
            return;
          }
        }
        // A nested settings menu or changed VK markup must remain navigable.
        // Do not guess an action or falsely restore game input.
        addEvent("stream-menu", "continue-action-unavailable");
        return;
      }
      var target = doc.documentElement;
      var request = target.webkitRequestFullscreen || target.requestFullscreen;
      if (!request) return;
      try {
        var result = request.call(target, { navigationUI: "hide" });
        if (result && typeof result.catch === "function") {
          result.catch(function (error) {
            recordError("fullscreen", error);
          });
        }
      } catch (error) {
        recordError("fullscreen", error);
      }
    }

    function installRemoteNavigation() {
      var greenPressedAt = 0;
      var redPressedAt = 0;
      var directions = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down"
      };

      win.addEventListener(
        "keydown",
        function (event) {
          var keyCode = event.keyCode || event.which;

          if (logsVisible && keyCode !== 403) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (keyCode === 10009 || keyCode === 27 || keyCode === 405) showLogs(false);
            else if (keyCode === 38 || keyCode === 40) logText.scrollTop += keyCode === 38 ? -220 : 220;
            return;
          }

          if (keyCode === 403) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!redPressedAt) redPressedAt = Date.now();
            return;
          }
          if (keyCode === 404) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!greenPressedAt) greenPressedAt = Date.now();
            return;
          }
          if (keyCode === 405) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.repeat) return;
            overlayVisible = !overlayVisible;
            renderOverlay();
            return;
          }
          if (keyCode === 406) {
            if (hasActiveGameStream()) {
              event.preventDefault();
              event.stopImmediatePropagation();
              if (!event.repeat) openStreamMenu("blue-key");
              return;
            }
            if (activateVkIdAction("blue-key")) {
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }
          if (keyCode === 10009) {
            event.preventDefault();
            event.stopPropagation();
            if (!openStreamMenu("back-key")) goBack();
            return;
          }

          if (hasActiveGameStream()) return; // VK handles arrows in its own menu.

          var direction = directions[event.key] || {
            37: "left",
            38: "up",
            39: "right",
            40: "down"
          }[keyCode];
          if (direction && moveFocus(direction)) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }

          if ((event.key === "Enter" || keyCode === 13) && doc.activeElement) {
            if (activateFocusedElement("remote-enter")) event.preventDefault();
          }
        },
        true
      );
      win.addEventListener("keyup", function (event) {
        var keyCode = event.keyCode || event.which;
        if (logsVisible && keyCode !== 403) {
          event.preventDefault(); event.stopImmediatePropagation(); return;
        }
        if (keyCode >= 403 && keyCode <= 405 || keyCode === 406 && hasActiveGameStream()) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        if (keyCode === 404 && greenPressedAt) {
          var held = Date.now() - greenPressedAt;
          greenPressedAt = 0;
          if (held >= 1200) toggleNextQuality();
          else requestFullscreen();
        }
        if (keyCode === 403 && redPressedAt) {
          var redHeld = Date.now() - redPressedAt; redPressedAt = 0;
          if (redHeld >= 1200) showLogs();
          else sendReport("red-key");
        }
      }, true);
      win.addEventListener("blur", function () { greenPressedAt = 0; redPressedAt = 0; });
      function onFullscreenChange() {
        if (!hasActiveGameStream()) return;
        var fullscreen = Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
        if (fullscreen && state.streamMenuOpen) {
          state.streamMenuOpen = false;
          virtualCursorButtons = [];
          addEvent("stream-menu", "resumed");
        } else if (!fullscreen && !state.streamMenuOpen) {
          stopStreamMouseInput();
          streamMouseInputActive = false;
          state.streamMenuOpen = true;
        }
      }
      doc.addEventListener("fullscreenchange", onFullscreenChange);
      doc.addEventListener("webkitfullscreenchange", onFullscreenChange);
      addEvent("remote-navigation", "arrows / Enter / Back / color keys");
    }

    function updateGamepads() {
      var pads = [];
      try {
        var raw = readGamepads();
        for (var index = 0; index < raw.length; index += 1) {
          var pad = raw[index];
          if (!pad) continue;
          pads.push({
            index: pad.index,
            id: pad.id,
            mapping: pad.mapping,
            axes: pad.axes.length,
            buttons: pad.buttons.length,
            pressedButtons: Array.prototype.reduce.call(
              pad.buttons,
              function (pressed, button, buttonIndex) {
                if (gamepadButtonPressed(button)) pressed.push(buttonIndex);
                return pressed;
              },
              []
            )
          });
        }
      } catch (error) {
        recordError("gamepad", error);
      }
      state.gamepads = pads;
      renderOverlay();
    }

    function installGamepadMonitor() {
      function buttonPressed(button) {
        return Boolean(button && (button.pressed || button.value > 0.55));
      }

      function gamepadDirection(pad) {
        if (buttonPressed(pad.buttons[12])) return "up";
        if (buttonPressed(pad.buttons[13])) return "down";
        if (buttonPressed(pad.buttons[14])) return "left";
        if (buttonPressed(pad.buttons[15])) return "right";
        if (pad.axes[1] < -0.55) return "up";
        if (pad.axes[1] > 0.55) return "down";
        if (pad.axes[0] < -0.55) return "left";
        if (pad.axes[0] > 0.55) return "right";
        return "";
      }

      function navigateFromGamepad(pad, key) {
        var now = Date.now();
        var direction = gamepadDirection(pad);
        var navState = gamepadNavigationState[key] || {
          direction: "",
          startedAt: 0,
          lastMoveAt: 0
        };

        if (!direction) {
          navState.direction = "";
          navState.startedAt = 0;
          navState.lastMoveAt = 0;
          gamepadNavigationState[key] = navState;
          return;
        }

        var shouldMove = false;
        if (direction !== navState.direction) {
          navState.direction = direction;
          navState.startedAt = now;
          shouldMove = true;
        } else if (
          now - navState.startedAt >= 420 &&
          now - navState.lastMoveAt >= 140
        ) {
          shouldMove = true;
        }

        if (shouldMove && moveFocus(direction)) {
          navState.lastMoveAt = now;
          addEvent("gamepad-nav", direction);
        }
        gamepadNavigationState[key] = navState;
      }

      function pollGamepadActions() {
        if (hasActiveGameStream()) return;
        if (isTopLevelContext) return;
        var raw = readGamepads();
        for (var index = 0; index < raw.length; index += 1) {
          var pad = raw[index];
          if (!pad) continue;
          var key = String(pad.index);
          var previous = previousGamepadButtons[key] || [];
          var confirmPressed = buttonPressed(pad.buttons[0]);
          var backPressed = buttonPressed(pad.buttons[1]);
          var shortcutPressed = buttonPressed(pad.buttons[3]);

          navigateFromGamepad(pad, key);

          if (confirmPressed && !previous[0]) {
            if (!activateFocusedElement("gamepad-a")) {
              if (!activateVkIdAction("gamepad-a")) moveFocus("down");
            }
          }
          if (backPressed && !previous[1]) {
            goBack();
          }
          if (shortcutPressed && !previous[3]) {
            activateVkIdAction("gamepad-y");
          }

          previousGamepadButtons[key] = pad.buttons.map(buttonPressed);
        }
      }

      win.addEventListener("gamepadconnected", function (event) {
        if (event.__vkplayTizenSynthetic) return;
        addEvent("gamepad-connected", event.gamepad.id);
        updateGamepads();
        queueReport(500);
      });
      win.addEventListener("gamepaddisconnected", function (event) {
        if (event.__vkplayTizenSynthetic) return;
        addEvent("gamepad-disconnected", event.gamepad.id);
        updateGamepads();
      });
      win.setInterval(updateGamepads, 1000);
      win.setInterval(pollGamepadActions, 80);
      updateGamepads();
    }

    function installStyles() {
      function apply() {
        if (!doc.head) return;
        var style = doc.createElement("style");
        style.id = "vkplay-tizen-tv-style";
        style.textContent =
          "html,body{width:100%;height:100%;margin:0;overscroll-behavior:none}" +
          "body{overflow-x:hidden}" +
          "#vkplay-tizen-tv-cursor{position:fixed;z-index:2147483647;width:28px;" +
          "height:28px;transform:translate3d(-50%,-50%,0);border:4px solid #fff;" +
          "border-radius:50%;background:#b6e824;pointer-events:none;" +
          "box-shadow:0 2px 12px rgba(0,0,0,.9)}" +
          "#vkplay-tizen-tv-cursor:after{content:'';position:absolute;left:7px;" +
          "top:7px;width:6px;height:6px;border-radius:50%;background:#10151d}" +
          "#vkplay-tizen-tv-input-hint{position:fixed;z-index:2147483646;" +
          "left:50%;bottom:28px;transform:translateX(-50%);max-width:90vw;" +
          "padding:10px 18px;border-radius:12px;background:rgba(8,12,18,.88);" +
          "color:#fff;font:20px/1.3 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;" +
          "white-space:nowrap;pointer-events:none;box-shadow:0 6px 26px rgba(0,0,0,.4)}" +
          "#vkplay-tizen-tv-input-hint[data-stream=true]{border:2px solid #b6e824}" +
          "#vkplay-tizen-tv-overlay{position:fixed;z-index:2147483647;right:24px;" +
          "top:24px;max-width:620px;padding:12px 16px;border:2px solid #b6e824;" +
          "border-radius:12px;background:rgba(8,12,18,.94);color:#fff;" +
          "font:22px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;" +
          "pointer-events:none;box-shadow:0 10px 40px rgba(0,0,0,.45)}" +
          "#vkplay-tizen-tv-overlay small{display:block;color:#b9c2cf;font-size:16px;" +
          "margin-top:5px;white-space:pre-wrap}" +
          "#vkplay-tizen-tv-overlay[data-open=false] small{display:none}";
        doc.head.appendChild(style);
      }

      if (doc.head) apply();
      else doc.addEventListener("DOMContentLoaded", apply, { once: true });
    }

    function renderOverlay() {
      if (!doc.body) return;
      if (!overlay) {
        overlay = doc.createElement("div");
        overlay.id = "vkplay-tizen-tv-overlay";
        overlayDetails = doc.createElement("small");
        overlay.appendChild(overlayDetails);
        doc.body.appendChild(overlay);
      }
      overlay.style.display = overlayVisible ? "block" : "none";
      if (!overlayVisible) return;

      var connected = state.peerStates.some(function (peer) {
        return peer.connectionState === "connected";
      });
      var status = connected
        ? "поток подключён"
        : state.peerConnections
          ? "подключение к игре"
          : "обёртка готова";
      overlay.firstChild &&
        overlay.firstChild.nodeType === 3 &&
        overlay.removeChild(overlay.firstChild);
      overlay.insertBefore(
        doc.createTextNode("VK TV " + VERSION + " · " + status),
        overlayDetails
      );
      overlay.setAttribute("data-open", overlayVisible ? "true" : "false");
      var stream = state.diagnostics.stream;
      function metric(value) { return value == null ? "?" : String(value); }
      var network = state.diagnostics.network;
      var lastNetwork = network[network.length - 1];
      overlayDetails.textContent =
        "SDP: " +
        state.imageAttrCount +
        " · A/V: " +
        state.audioTracks +
        "+" +
        state.videoTracks +
        " → " +
        state.combinedTracks +
        "\nГеймпады: " +
        state.gamepads.length +
        " · Ошибки: " +
        state.errors.length +
        " · Отчёт: " +
        state.reportStatus +
        " · в очереди " + state.reporting.pending +
        "\nСервис: " + state.reporting.service + " · хранение: " + state.reporting.storage +
        "\nПередача: " + (state.reportError || state.reporting.lastDeliveredId || "—") +
        "\nПоследняя ошибка: " + (state.errors.length ? state.errors[state.errors.length - 1].scope + ": " + state.errors[state.errors.length - 1].error.slice(0, 150) : "—") +
        "\nVK browser: " +
        state.vkBrowserGate +
        " · VK input: " +
        state.vkInputTransmitter +
        " (" +
        state.vkNativeMouseEvents +
        ")" +
        "\nVK pad: " +
        state.vkGamepadRegistration +
        " (анонсов " +
        state.vkGamepadAnnounces +
        ", опрос " +
        state.vkGamepadPollRate +
        ")" +
        "\nВидео: " +
        state.diagnostics.video.intrinsic +
        " → " +
        state.diagnostics.video.layout +
        " · drop " +
        (state.diagnostics.video.droppedSinceLast == null
          ? "?"
          : state.diagnostics.video.droppedSinceLast) +
        "\nОболочка: " +
        state.diagnostics.shell.fps +
        " fps · avg " +
        state.diagnostics.shell.averageFrameMs +
        " ms · long " +
        state.diagnostics.shell.longFrames +
        "\nДекодирование" + (stream.stale ? " (старый замер)" : "") + ": " + metric(stream.decodedFps) + " fps (не FPS игры) · " + metric(stream.bitrateMbps) + " Mbps · " + stream.codec +
        "\nDecode: " + metric(stream.decodeMs) + " ms · буфер " + metric(stream.jitterBufferMs) + " ms" +
        "\nRTT: " + metric(stream.rttMs) + " ms · потери " + metric(stream.lossPercent) + "%" +
        "\nСеть: " + (lastNetwork ? lastNetwork.transport + " " + lastNetwork.phase + " " + lastNetwork.status : "ошибок не записано") +
        "\nЗапрошено: " + state.quality.active + " · после перезапуска: " + state.quality.next +
        "\nHDR потока: неизвестно · HDR ТВ: " + (state.diagnostics.display.hdrSupported == null ? "?" : state.diagnostics.display.hdrSupported ? "поддерживается" : "нет") +
        "\nL1+R1+Options = мышь · Create+Options = меню VK" +
        "\nКрасная: отчёт / держать 2 с: журнал · Синяя/Назад: меню · Жёлтая: скрыть" +
        "\nЗелёная: полный экран · держать 2 с: 1080p/1440p на следующий запуск";
    }

    function installOverlay() {
      function mount() {
        renderOverlay();
      }
      if (doc.body) mount();
      else doc.addEventListener("DOMContentLoaded", mount, { once: true });
    }

    function collectStats() {
      return Promise.all(
        peerConnections.map(function (pc, index) {
          if (!pc.getStats || pc.connectionState === "closed") return Promise.resolve({ index: index, stats: [] });
          return withTimeout(Promise.resolve().then(function () { return pc.getStats(); }), 1500, "RTC getStats timeout")
            .then(function (report) {
              var stats = [];
              report.forEach(function (item) {
                if (
                  item.type === "inbound-rtp" ||
                  item.type === "candidate-pair" ||
                  item.type === "transport" ||
                  item.type === "codec" ||
                  item.type === "data-channel"
                ) {
                  stats.push({
                    id: item.id,
                    type: item.type,
                    timestamp: item.timestamp,
                    kind: item.kind || item.mediaType,
                    codecId: item.codecId,
                    mimeType: item.mimeType,
                    clockRate: item.clockRate,
                    decoderImplementation: item.decoderImplementation,
                    powerEfficientDecoder: item.powerEfficientDecoder,
                    state: item.state,
                    nominated: item.nominated,
                    selectedCandidatePairId: item.selectedCandidatePairId,
                    bytesReceived: item.bytesReceived,
                    packetsReceived: item.packetsReceived,
                    packetsLost: item.packetsLost,
                    jitter: item.jitter,
                    framesDecoded: item.framesDecoded,
                    framesDropped: item.framesDropped,
                    freezeCount: item.freezeCount,
                    totalFreezesDuration: item.totalFreezesDuration,
                    framesPerSecond: item.framesPerSecond,
                    frameWidth: item.frameWidth,
                    frameHeight: item.frameHeight,
                    totalDecodeTime: item.totalDecodeTime,
                    jitterBufferDelay: item.jitterBufferDelay,
                    jitterBufferEmittedCount: item.jitterBufferEmittedCount,
                    messagesSent: item.messagesSent,
                    messagesReceived: item.messagesReceived,
                    bytesSent: item.bytesSent,
                    concealedSamples: item.concealedSamples,
                    totalSamplesReceived: item.totalSamplesReceived,
                    currentRoundTripTime: item.currentRoundTripTime,
                    availableIncomingBitrate: item.availableIncomingBitrate
                  });
                }
              });
              return { index: index, stats: stats };
            })
            .catch(function (error) {
              return { index: index, error: scrubDiagnosticText(errorText(error)), stats: [] };
            });
        })
      );
    }

    function installDiagnosticsSampler() {
      if (!isTopLevelContext || !isCloudHost) return;
      var pending = false;
      var previousStats = [];
      var nextSaveAt = 0;
      var nextPeriodicReportAt = Date.now() + 60000;
      try {
        var saved = win.localStorage.getItem("VKPLAY_TV_LAST_DIAGNOSTICS");
        if (saved && saved.length <= 64000) {
          var parsed = JSON.parse(saved);
          if (parsed && parsed.schema === 1) state.diagnostics.previousRun = parsed;
        }
      } catch (_) {}

      function saveCompactDiagnostics() {
        if (!state.diagnostics.history.length && !state.diagnostics.network.length) return;
        try {
          // Small, bounded summary; no auth state, raw socket messages or recursion.
          var summary = {
            schema: 1, at: new Date().toISOString(), version: VERSION,
            stream: state.diagnostics.stream, shell: state.diagnostics.shell,
            network: state.diagnostics.network.slice(-12),
            samples: state.diagnostics.history.slice(-30).map(function (sample) {
              return { at: sample.at, stream: sample.stream, shellFps: sample.shell.fps,
                intrinsic: sample.video.intrinsic, layout: sample.video.layout };
            })
          };
          win.localStorage.setItem("VKPLAY_TV_LAST_DIAGNOSTICS", JSON.stringify(summary));
        } catch (_) {} // Storage failure must never interrupt a session.
      }
      win.addEventListener("pagehide", saveCompactDiagnostics);
      doc.addEventListener("visibilitychange", function () { if (doc.hidden) saveCompactDiagnostics(); });
      win.setInterval(function () {
        if (pending || doc.hidden) return;
        pending = true;
        collectStats().then(function (stats) {
          var failedSample = stats.filter(function (peer) { return Boolean(peer.error); });
          if (failedSample.length) {
            state.diagnostics.stream.stale = true;
            state.diagnostics.stream.sampleError = failedSample[0].error;
            recordError("rtc-stats", failedSample[0].error);
          } else {
            state.diagnostics.stream = summarizeStreamMetrics(stats, previousStats);
            state.diagnostics.stream.stale = false;
            previousStats = stats;
          }
          state.diagnostics.history.push({
            at: new Date().toISOString(),
            shell: Object.assign({}, state.diagnostics.shell),
            video: Object.assign({}, state.diagnostics.video),
            stream: Object.assign({}, state.diagnostics.stream),
            inputMode: streamMouseMode ? "mouse" : "gamepad",
            registration: state.vkGamepadRegistration,
            announces: state.vkGamepadAnnounces,
            vkPolls: vkGamepadPollCount,
            mouseEvents: vkInputBridge.sentEvents,
            rtcStats: stats
          });
          if (state.diagnostics.history.length > 60) state.diagnostics.history.shift();
          renderOverlay();
          var now = Date.now();
          if (now >= nextSaveAt) { nextSaveAt = now + 15000; saveCompactDiagnostics(); }
          if (hasActiveGameStream() && now >= nextPeriodicReportAt) {
            nextPeriodicReportAt = now + 60000;
            queueReport(0);
          }
          pending = false;
        }, function (error) {
          pending = false;
          recordError("stats-sampler", error);
        });
      }, 2000);
    }

    function playerVideoSettings() {
      // Only numeric video preferences, never enumerate auth/session storage.
      var settings = {};
      ["RESOLUTION", "FPS", "QUALITY_PRESET", "CODEC", "PROFILE", "MIN_BITRATE", "MAX_BITRATE", "START_BITRATE", "SLICES", "REF_FRAMES"].forEach(function (name) {
        try {
          var value = win.localStorage.getItem("WEB_PLAYER_VIDEO_" + name);
          settings[name.toLowerCase()] = value != null && /^\d{1,9}$/.test(value) ? Number(value) : null;
        } catch (_) { settings[name.toLowerCase()] = null; }
      });
      return settings;
    }

    function buildReport(reason) {
      summarizePeers();
      updateGamepads();
      return collectStats().then(function (rtcStats) {
        return scrubReport({
          schema: "vkplay-tizen-live/1",
          reportId: runId + "-r" + (++reportSequence),
          runId: runId,
          version: VERSION,
          generatedAt: new Date().toISOString(),
          reason: reason,
          device: {
            modelCode: TARGET_MODEL,
            realUserAgent: realUserAgent,
            effectiveUserAgent: nav.userAgent,
            screen: realScreen.width + "x" + realScreen.height,
            effectiveScreen: win.screen.width + "x" + win.screen.height,
            devicePixelRatio: win.devicePixelRatio
          },
          viewport: {
            width: win.innerWidth,
            height: win.innerHeight,
            fullscreen: Boolean(doc.fullscreenElement || doc.webkitFullscreenElement)
          },
          page: {
            origin: win.location.origin,
            pathname: endpointCategory(win.location.href)
          },
          patches: {
            browserShim: state.browserShim,
            rtcShim: state.rtcShim,
            mediaShim: state.mediaShim,
            fullscreenShim: state.fullscreenShim,
            imageAttrCount: state.imageAttrCount,
            vkBrowserGate: state.vkBrowserGate,
            vkInputTransmitter: state.vkInputTransmitter,
            vkNativeMouseEvents: state.vkNativeMouseEvents
          },
          media: {
            sourceVideoTracks: state.videoTracks,
            sourceAudioTracks: state.audioTracks,
            combinedTracks: state.combinedTracks
          },
          diagnostics: state.diagnostics,
          reporting: Object.assign({}, state.reporting, { status: state.reportStatus, error: state.reportError }),
          quality: Object.assign({}, state.quality, { playerSettings: playerVideoSettings() }),
          input: {
            mode: streamMouseMode ? "mouse" : "gamepad",
            nativeMouseReady: Boolean(vkInputBridge.transmitter && vkInputBridge.token != null),
            wasmModuleHeld: Boolean(vkInputBridge.module),
            nativeMouseError: vkInputBridge.lastError == null ? null : scrubDiagnosticText(vkInputBridge.lastError),
            registration: state.vkGamepadRegistration,
            announces: state.vkGamepadAnnounces,
            pollCount: vkGamepadPollCount,
            switches: state.vkMouseComboCount
          },
          gamepads: state.gamepads,
          peers: state.peerStates,
          rtcStats: rtcStats,
          recentEvents: recentEvents.slice(-40),
          errors: state.errors.slice(-20)
        });
      });
    }

    function withTimeout(promise, milliseconds, message) {
      return new Promise(function (resolve, reject) {
        var timer = win.setTimeout(function () { reject(new Error(message)); }, milliseconds);
        Promise.resolve(promise).then(function (value) { win.clearTimeout(timer); resolve(value); }, function (error) { win.clearTimeout(timer); reject(error); });
      });
    }

    function relayRequest(path, report) {
      if (!reportFetch) return Promise.reject(new Error("fetch unavailable"));
      var controller = win.AbortController ? new win.AbortController() : null;
      var timer = win.setTimeout(function () { if (controller) controller.abort(); }, 7000);
      var request = Promise.resolve().then(function () {
        return reportFetch(RELAY_URL + path, {
          method: report ? "POST" : "GET", mode: "cors", cache: "no-store", credentials: "omit",
          headers: report ? { "Content-Type": "application/json" } : undefined,
          body: report ? JSON.stringify(report) : undefined,
          signal: controller ? controller.signal : undefined
        });
      }).then(function (response) {
        if (!response.ok) throw new Error("Relay HTTP " + response.status);
        return response.json();
      });
      return withTimeout(request, 7500, "Relay timeout (service or local network unavailable)").then(function (value) {
        win.clearTimeout(timer); return value;
      }, function (error) { win.clearTimeout(timer); throw error; });
    }

    function acceptDelivery(ack, reportId) {
      if (!ack || ack.ok !== true || ack.reportId !== reportId || ["delivered", "queued"].indexOf(ack.delivery) === -1) throw new Error("Invalid report delivery acknowledgement");
      state.reporting.service = "ready";
      if (ack.delivery === "delivered") {
        outbox = outbox.filter(function (pending) { return pending.reportId !== reportId; });
        persistOutbox();
        state.reporting.lastDeliveredId = reportId;
        if (reportId === state.reportId) { state.reportStatus = "sent"; state.reportError = null; }
        traceEvent("report-delivered", reportId);
      } else {
        if (reportId === state.reportId) {
          state.reportStatus = "queued";
          state.reportError = "Сохранён сервисом ТВ; Мак пока не подтвердил" + (ack.upstreamFailure ? ": " + scrubDiagnosticText(ack.upstreamFailure) : "");
        }
        traceEvent("report-queued", reportId);
      }
    }

    function flushOutbox() {
      var pending = outbox.slice();
      return pending.reduce(function (promise, report) {
        return promise.then(function () {
          return relayRequest("/report", report).then(function (ack) { acceptDelivery(ack, report.reportId); return ack; });
        });
      }, Promise.resolve(null));
    }

    function probeReportService() {
      return relayRequest("/health").then(function (health) {
        if (!health || health.service !== "vkplay-tv-report-relay") throw new Error("Unexpected report service");
        state.reporting.service = "ready " + String(health.version || "");
        state.reporting.serviceStorage = health.storage;
        state.reporting.serviceQueued = health.queued == null ? health.queue : health.queued;
      }).catch(function (error) {
        state.reporting.service = "unavailable";
        state.reportError = "Сервис ТВ: " + scrubDiagnosticText(errorText(error));
      }).then(function () { renderOverlay(); });
    }

    function sendReport(reason) {
      if (!isCloudHost || !isTopLevelContext) return Promise.resolve(null);
      if (reportInFlight) return reportInFlight;
      if (reason === "automatic" && Date.now() < nextAutomaticReportAt) return Promise.resolve(null);
      nextAutomaticReportAt = Date.now() + 30000;
      state.reportStatus = "sending";
      state.reportError = null;
      renderOverlay();
      reportInFlight = buildReport(reason || "manual")
        .then(function (report) {
          // Bound disk use and serialization on the TV; this still retains
          // recent raw RTC counters and the complete bounded error journal.
          while (JSON.stringify(report).length > 240000 && report.diagnostics.history.length) report.diagnostics.history.shift();
          if (JSON.stringify(report).length > 300000) throw new Error("Report too large to retain safely");
          state.reportId = report.reportId;
          outbox.push(report);
          if (outbox.length > 3) { outbox.shift(); state.reporting.evicted += 1; }
          persistOutbox(); persistJournal();
          return flushOutbox();
        })
        .catch(function (error) {
          state.reportStatus = "failed";
          state.reportError = scrubDiagnosticText(errorText(error)) + (state.reporting.storage === "saved" ? "; сохранено на ТВ: " : "; только в памяти: ") + outbox.length;
          addEvent("report-failed", state.reportError);
          return null;
        }).then(function (result) {
          reportInFlight = null;
          persistJournal(); renderOverlay();
          if (logsVisible) showLogs(true);
          return result;
        });
      return reportInFlight;
    }

    function queueReport(delay) {
      if (!isCloudHost || !isTopLevelContext) return;
      win.clearTimeout(reportTimer);
      reportTimer = win.setTimeout(function () {
        sendReport("automatic");
      }, delay == null ? 1200 : delay);
    }

    win.addEventListener("error", function (event) {
      if (isCloudHost && isTopLevelContext) recordError("window", event.error || event.message);
    });
    win.addEventListener("unhandledrejection", function (event) {
      if (isCloudHost && isTopLevelContext) recordError("promise", event.reason);
    });

    var publicApi = {
      installed: true,
      version: VERSION,
      state: state,
      patchSamsungSdp: patchSamsungSdp,
      sendReport: sendReport,
      buildReport: buildReport,
      showLogs: function () { showLogs(true); },
      showDiagnostics: function () {
        overlayVisible = true;
        if (overlay) overlay.style.opacity = "1";
        renderOverlay();
      }
    };
    win.__VKPLAY_TIZEN__ = publicApi;

    restoreReportStorage();
    installErrorJournal();
    installBrowserShim();
    if (isBootstrapPage) {
      state.inputMode = "bootstrap";
      addEvent("bootstrap", "opening VK after module cache warm-up");
      win.location.replace("https://cloud.vkplay.ru/dashboard");
      return publicApi;
    }
    if (
      win.location.hostname === "cloud.vkplay.ru" &&
      (win.location.pathname === "/" || win.location.pathname === "")
    ) {
      addEvent("route", "/dashboard");
      win.location.replace("https://cloud.vkplay.ru/dashboard");
      return publicApi;
    }
    if (isCloudHost) {
      configureStreamQuality();
      installNetworkDiagnostics();
      installVkMouseComboShim();
      if (!installVkInputPromiseHook(win, vkInputBridge)) {
        state.vkInputTransmitter = "input-observer-unavailable";
        addEvent("vk-native-input", "input observer could not be installed");
      }
      installVkBrowserGate();
      installRtcShim();
      installMediaShim();
      installFullscreenShim();
    }
    if (isLocalTestHost) installVkMouseComboShim();
    installStyles();
    installOverlay();
    installVkIdNavigation();
    installRemoteNavigation();
    vkGamepadRegistrar = createVkGamepadRegistrar({
      dispatch: dispatchGamepadLifecycle,
      pollCount: vkMouseComboShimInstalled
        ? function () { return vkGamepadPollCount; }
        : null,
      log: function (message) { addEvent("vk-gamepad", message); }
    });
    installVirtualCursor();
    installGamepadMonitor();
    installDiagnosticsSampler();
    if (isCloudHost && isTopLevelContext) {
      win.setTimeout(probeReportService, 1000);
      queueReport(2500);
      win.setInterval(function () { if (outbox.length && !reportInFlight && !doc.hidden) sendReport("automatic"); }, 30000);
    }

    addEvent("installed", VERSION);
    return publicApi;
  }

  return {
    version: VERSION,
    imageAttr: IMAGE_ATTR,
    patchSamsungSdp: patchSamsungSdp,
    countSamsungImageAttrs: countSamsungImageAttrs,
    summarizeStreamMetrics: summarizeStreamMetrics,
    neutralGamepadButtons: neutralGamepadButtons,
    wrapVkLaunchFactory: wrapVkLaunchFactory,
    patchVkLaunchFactory: patchVkLaunchFactory,
    patchVkLaunchChunk: patchVkLaunchChunk,
    createVkInputBridge: createVkInputBridge,
    createVkGamepadRegistrar: createVkGamepadRegistrar,
    wrapVkInputFactory: wrapVkInputFactory,
    patchVkInputFactory: patchVkInputFactory,
    patchVkInputChunk: patchVkInputChunk,
    patchVkInputModule: patchVkInputModule,
    installVkInputPromiseHook: installVkInputPromiseHook,
    sendVkNativeMouse: sendVkNativeMouse,
    install: install
  };
});
