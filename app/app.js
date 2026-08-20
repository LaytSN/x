(function () {
  "use strict";

  var REPORT_SCHEMA = "vkplay-tizen-diagnostics/1";
  var REPORT_URL = "http://192.168.0.149:8787/report";
  var WSS_ECHO_URL = "wss://ws.postman-echo.com/raw";
  var report = createEmptyReport();
  var gamepadAutoReportQueued = false;
  var inputEvents = [];
  var lastGamepadPaint = 0;
  var gamepadActivitySeen = false;

  var el = {
    cards: document.getElementById("cards"),
    summary: document.getElementById("summary"),
    runState: document.getElementById("run-state"),
    verdict: document.getElementById("verdict"),
    verdictDetail: document.getElementById("verdict-detail"),
    gamepadStatus: document.getElementById("gamepad-status"),
    gamepads: document.getElementById("gamepads"),
    inputLog: document.getElementById("input-log"),
    detailsPanel: document.getElementById("details-panel"),
    details: document.getElementById("details"),
    reportTarget: document.getElementById("report-target"),
    clock: document.getElementById("clock")
  };

  function createEmptyReport() {
    return {
      schema: REPORT_SCHEMA,
      generatedAt: new Date().toISOString(),
      device: {},
      features: {},
      media: {},
      webrtc: {},
      network: {},
      storage: {},
      fullscreen: {
        attempted: false,
        entered: false,
        active: false,
        error: null
      },
      gamepads: [],
      inputEvents: [],
      vkCompatibility: {
        inspectedFrontendVersion: "v1.36.03",
        inspectedPlayerBundleDate: "2026-08-17",
        browserGate: "Chromium 90+ on Windows/macOS/Linux/ChromeOS; Tizen is not listed",
        transport: "WebRTC media + unordered RTCDataChannel (maxPacketLifeTime=1)",
        gamepadReader: "navigator.getGamepads() + gamepadconnected/gamepaddisconnected",
        videoCodecRequestedByPlayer: "H.264",
        samsungImageAttrInVkOffer: false,
        samsungSingleVideoElementLayoutInVkPlayer: false,
        requiredAdaptations: [
          "Chromium userAgentData compatibility shim before VK scripts",
          "Samsung a=imageattr SDP insertion",
          "Combine remote audio and video tracks into one video element",
          "Keyboard Lock / fullscreen compatibility shim if APIs are absent",
          "Remote-control navigation and Back-key handling"
        ]
      },
      errors: []
    };
  }

  function nowLabel() {
    return new Date().toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function errorText(error) {
    if (!error) return "Unknown error";
    return String(error.name ? error.name + ": " + error.message : error);
  }

  function safe(label, fn, fallback) {
    try {
      return fn();
    } catch (error) {
      report.errors.push({ test: label, error: errorText(error) });
      return fallback;
    }
  }

  function bool(value) {
    return value ? "да" : "нет";
  }

  function displayValue(value) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "boolean") return bool(value);
    if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function escapeHtml(value) {
    return displayValue(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");
  }

  function badge(status, text) {
    return '<span class="badge ' + status + '">' + escapeHtml(text) + "</span>";
  }

  function card(title, status, statusText, rows) {
    var items = rows
      .map(function (row) {
        return (
          '<li><span class="label">' +
          escapeHtml(row[0]) +
          '</span><span class="value ' +
          (row[2] || "") +
          '">' +
          escapeHtml(row[1]) +
          "</span></li>"
        );
      })
      .join("");
    return (
      '<article class="card"><div class="card-head"><h3>' +
      escapeHtml(title) +
      "</h3>" +
      badge(status, statusText) +
      "</div><ul>" +
      items +
      "</ul></article>"
    );
  }

  function feature(path) {
    var current = report.features;
    path.split(".").forEach(function (key) {
      current = current && current[key];
    });
    return !!current;
  }

  function classForBoolean(value, optional) {
    if (value) return "good";
    return optional ? "warn" : "bad";
  }

  function render() {
    var device = report.device;
    var media = report.media;
    var rtc = report.webrtc;
    var network = report.network;
    var storage = report.storage;
    var standard = rtc.standardOffer || {};
    var patched = rtc.samsungPatchedOffer || {};
    var requiredFeatures = [
      feature("performanceNow"),
      feature("bigInt"),
      feature("replaceAll"),
      feature("mediaStream"),
      feature("requestAnimationFrame")
    ];
    var requiredCount = requiredFeatures.filter(Boolean).length;
    var webrtcCore = !!(
      rtc.available &&
      standard.created &&
      standard.setLocalDescription &&
      standard.hasH264 &&
      standard.hasOpus &&
      standard.hasDataChannel
    );
    var patchedSdpReady = !!(
      patched.created &&
      patched.setLocalDescription &&
      patched.imageAttrCount > 0
    );
    var gamepadApi = feature("gamepadApi");
    var hardBlock = !webrtcCore || !gamepadApi || requiredCount !== requiredFeatures.length;
    var warnings = [
      !feature("userAgentData"),
      !feature("keyboardLock"),
      !feature("webkitFullscreen"),
      !patchedSdpReady,
      network.webSocketRoundTrip !== true
    ].filter(Boolean).length;

    if (hardBlock) {
      el.verdict.textContent = "Есть технический блокер";
      el.verdict.className = "verdict bad";
      el.verdictDetail.textContent =
        "Смотри красные пункты: без них текущий WebRTC-плеер VK не сможет дать полноценную игровую сессию.";
      el.summary.textContent = "Базовая совместимость не подтверждена";
    } else if (warnings > 0) {
      el.verdict.textContent = "База совместима, нужны адаптации";
      el.verdict.className = "verdict warn";
      el.verdictDetail.textContent =
        "Можно переходить к тестовой VK-обёртке. Жёлтые пункты патчатся модулем, но живой запуск ещё обязан подтвердить аппаратный декодер и звук.";
      el.summary.textContent = "Критические API на месте; предупреждений: " + warnings;
    } else {
      el.verdict.textContent = "База совместима с VK WebRTC";
      el.verdict.className = "verdict good";
      el.verdictDetail.textContent =
        "Следующий этап — авторизация и одна реальная игровая сессия с замером декодера, звука, потерь кадров и ввода.";
      el.summary.textContent = "Критические проверки пройдены";
    }

    el.cards.innerHTML = [
      card("Телевизор и движок", device.tizenVersion ? "good" : "warn", device.tizenVersion ? "ОПРЕДЕЛЁН" : "ЧАСТИЧНО", [
        ["Модель", device.modelCode || "не отдана API"],
        ["Tizen", device.tizenVersion || "не определён", classForBoolean(device.tizenVersion, true)],
        ["Firmware", device.firmware || "не определён"],
        ["UHD-панель", displayValue(device.isUdPanelSupported)],
        ["Экран Web Runtime", (device.screenWidth || "?") + " × " + (device.screenHeight || "?")],
        ["User-Agent", device.userAgent || "—"]
      ]),
      card("JavaScript и окружение", requiredCount === requiredFeatures.length ? "good" : "bad", requiredCount + "/" + requiredFeatures.length, [
        ["performance.now", bool(feature("performanceNow")), classForBoolean(feature("performanceNow"))],
        ["BigInt", bool(feature("bigInt")), classForBoolean(feature("bigInt"))],
        ["String.replaceAll", bool(feature("replaceAll")), classForBoolean(feature("replaceAll"))],
        ["userAgentData", bool(feature("userAgentData")), classForBoolean(feature("userAgentData"), true)],
        ["Keyboard Lock", bool(feature("keyboardLock")), classForBoolean(feature("keyboardLock"), true)],
        ["webkit Fullscreen", bool(feature("webkitFullscreen")), classForBoolean(feature("webkitFullscreen"), true)],
        ["Fullscreen реально открыт", report.fullscreen.attempted ? bool(report.fullscreen.entered) : "нажми синюю", report.fullscreen.entered ? "good" : "warn"],
        ["Pointer Lock", bool(feature("pointerLock")), classForBoolean(feature("pointerLock"), true)]
      ]),
      card("WebRTC как у VK", webrtcCore ? "good" : "bad", webrtcCore ? "ГОТОВ" : "БЛОКЕР", [
        ["RTCPeerConnection", bool(rtc.available), classForBoolean(rtc.available)],
        ["Offer + setLocalDescription", bool(standard.setLocalDescription), classForBoolean(standard.setLocalDescription)],
        ["H.264 в SDP", bool(standard.hasH264), classForBoolean(standard.hasH264)],
        ["Opus в SDP", bool(standard.hasOpus), classForBoolean(standard.hasOpus)],
        ["DataChannel VK-профиля", bool(standard.hasDataChannel), classForBoolean(standard.hasDataChannel)],
        ["H.264 payloads", standard.h264Payloads || []],
        ["SDP bytes", standard.sdpLength || 0]
      ]),
      card("Samsung game mode SDP", patchedSdpReady ? "good" : "warn", patchedSdpReady ? "ПАТЧ ПРИНЯТ" : "НУЖЕН ПАТЧ", [
        ["VK сам добавляет imageattr", "нет", "warn"],
        ["Диагностический imageattr", patched.imageAttrCount || 0, classForBoolean(patched.imageAttrCount, true)],
        ["Tizen принял patched SDP", bool(patched.setLocalDescription), classForBoolean(patched.setLocalDescription, true)],
        ["Целевой режим", device.isUdPanelSupported === false ? "1080p60" : "2160p60"],
        ["Один video с 2 tracks", "VK сейчас делит audio/video", "warn"]
      ]),
      card("Медиа и кодеки", standard.hasH264 && standard.hasOpus ? "good" : "bad", standard.hasH264 && standard.hasOpus ? "СОВМЕСТИМО" : "ПРОБЛЕМА", [
        ["WebRTC video codecs", (media.rtcVideoCodecs || []).join(", ") || "не получены"],
        ["WebRTC audio codecs", (media.rtcAudioCodecs || []).join(", ") || "не получены"],
        ["HTML5 H.264 High", media.canPlayType && media.canPlayType.h264High || "нет"],
        ["HTML5 HEVC", media.canPlayType && media.canPlayType.hevc || "нет"],
        ["HTML5 VP9", media.canPlayType && media.canPlayType.vp9 || "нет"],
        ["MSE", bool(feature("mediaSource")), classForBoolean(feature("mediaSource"), true)],
        ["EME", bool(feature("eme")), classForBoolean(feature("eme"), true)]
      ]),
      card("Сеть, хранение и ввод", network.webSocketRoundTrip && gamepadApi ? "good" : "warn", network.webSocketRoundTrip && gamepadApi ? "ГОТОВО" : "ПРОВЕРИТЬ", [
        ["WebSocket API", bool(network.webSocketApi), classForBoolean(network.webSocketApi)],
        ["WSS round-trip", displayValue(network.webSocketRoundTrip), classForBoolean(network.webSocketRoundTrip, true)],
        ["localStorage", bool(storage.localStorage), classForBoolean(storage.localStorage)],
        ["IndexedDB", bool(storage.indexedDB), classForBoolean(storage.indexedDB, true)],
        ["Cookies", bool(storage.cookies), classForBoolean(storage.cookies, true)],
        ["Gamepad API", bool(gamepadApi), classForBoolean(gamepadApi)],
        ["Геймпадов сейчас", report.gamepads.length]
      ])
    ].join("");

    report.generatedAt = new Date().toISOString();
    report.inputEvents = inputEvents.slice(-60);
    el.details.textContent = JSON.stringify(report, null, 2);
  }

  async function collectDeviceInfo() {
    var uaData = null;
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      try {
        uaData = await navigator.userAgentData.getHighEntropyValues([
          "architecture",
          "bitness",
          "model",
          "platform",
          "platformVersion",
          "uaFullVersion",
          "fullVersionList"
        ]);
      } catch (error) {
        report.errors.push({ test: "userAgentData", error: errorText(error) });
      }
    }

    report.device = {
      userAgent: navigator.userAgent,
      appVersion: navigator.appVersion,
      platform: navigator.platform,
      language: navigator.language,
      userAgentData: uaData,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      online: navigator.onLine,
      screenWidth: window.screen && window.screen.width,
      screenHeight: window.screen && window.screen.height,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      tizenVersion: safe("tizen.platform.version", function () {
        return tizen.systeminfo.getCapability("http://tizen.org/feature/platform.version");
      }, null),
      modelCode: safe("productinfo.modelCode", function () {
        return webapis.productinfo.getModelCode();
      }, null),
      firmware: safe("productinfo.firmware", function () {
        return webapis.productinfo.getFirmware();
      }, null),
      isUdPanelSupported: safe("productinfo.udPanel", function () {
        return webapis.productinfo.isUdPanelSupported();
      }, null)
    };
  }

  function collectFeatureInfo() {
    var video = document.createElement("video");
    var root = document.documentElement;
    report.features = {
      tizenApi: typeof window.tizen !== "undefined",
      samsungProductInfoApi: !!(window.webapis && webapis.productinfo),
      performanceNow: !!(window.performance && typeof performance.now === "function"),
      bigInt: typeof window.BigInt === "function",
      replaceAll: typeof String.prototype.replaceAll === "function",
      requestAnimationFrame: typeof window.requestAnimationFrame === "function",
      mediaStream: typeof window.MediaStream === "function",
      webSocket: typeof window.WebSocket === "function",
      mediaSource: typeof window.MediaSource === "function",
      eme: typeof navigator.requestMediaKeySystemAccess === "function",
      indexedDB: typeof window.indexedDB !== "undefined",
      webCrypto: !!(window.crypto && window.crypto.subtle),
      webAssembly: typeof window.WebAssembly === "object",
      fetch: typeof window.fetch === "function",
      sendBeacon: typeof navigator.sendBeacon === "function",
      userAgentData: !!navigator.userAgentData,
      userAgentDataHighEntropy: !!(
        navigator.userAgentData && navigator.userAgentData.getHighEntropyValues
      ),
      gamepadApi: typeof navigator.getGamepads === "function",
      mediaDevices: !!navigator.mediaDevices,
      enumerateDevices: !!(
        navigator.mediaDevices && navigator.mediaDevices.enumerateDevices
      ),
      permissionsApi: !!navigator.permissions,
      clipboardApi: !!navigator.clipboard,
      keyboardLock: !!(
        navigator.keyboard &&
        typeof navigator.keyboard.lock === "function" &&
        typeof navigator.keyboard.unlock === "function"
      ),
      standardFullscreen: !!(
        document.fullscreenEnabled && root.requestFullscreen
      ),
      webkitFullscreen: !!(
        document.webkitFullscreenEnabled && root.webkitRequestFullscreen
      ),
      pointerLock: typeof root.requestPointerLock === "function",
      videoSrcObject: "srcObject" in video,
      requestVideoFrameCallback: typeof video.requestVideoFrameCallback === "function",
      videoDecoder: typeof window.VideoDecoder === "function"
    };
  }

  function uniqueCodecNames(capabilities) {
    if (!capabilities || !capabilities.codecs) return [];
    return capabilities.codecs
      .map(function (codec) {
        return codec.mimeType + (codec.sdpFmtpLine ? " (" + codec.sdpFmtpLine + ")" : "");
      })
      .filter(function (value, index, all) {
        return all.indexOf(value) === index;
      });
  }

  function collectMediaInfo() {
    var video = document.createElement("video");
    var audio = document.createElement("audio");
    var videoCaps = safe("RTCRtpReceiver.videoCapabilities", function () {
      return RTCRtpReceiver.getCapabilities("video");
    }, null);
    var audioCaps = safe("RTCRtpReceiver.audioCapabilities", function () {
      return RTCRtpReceiver.getCapabilities("audio");
    }, null);
    var mseTypes = {
      h264Baseline: 'video/mp4; codecs="avc1.42E01E"',
      h264Main: 'video/mp4; codecs="avc1.4D401F"',
      h264High: 'video/mp4; codecs="avc1.640028"',
      hevc: 'video/mp4; codecs="hvc1.1.6.L120.B0"',
      vp9: 'video/webm; codecs="vp09.00.51.08"',
      av1: 'video/mp4; codecs="av01.0.08M.08"'
    };
    var mse = {};
    Object.keys(mseTypes).forEach(function (key) {
      mse[key] = !!(
        window.MediaSource &&
        MediaSource.isTypeSupported &&
        MediaSource.isTypeSupported(mseTypes[key])
      );
    });
    report.media = {
      rtcVideoCodecs: uniqueCodecNames(videoCaps),
      rtcAudioCodecs: uniqueCodecNames(audioCaps),
      canPlayType: {
        h264Baseline: video.canPlayType(mseTypes.h264Baseline) || "",
        h264Main: video.canPlayType(mseTypes.h264Main) || "",
        h264High: video.canPlayType(mseTypes.h264High) || "",
        hevc: video.canPlayType(mseTypes.hevc) || "",
        vp9: video.canPlayType(mseTypes.vp9) || "",
        av1: video.canPlayType(mseTypes.av1) || "",
        opus: audio.canPlayType('audio/webm; codecs="opus"') || ""
      },
      mediaSourceTypes: mse,
      note: "canPlayType/MSE describe format acceptance, not guaranteed hardware WebRTC decoding. Hardware decode is proven only by a live session and RTC stats."
    };
  }

  function h264PayloadsFromSdp(sdp) {
    var payloads = [];
    String(sdp || "")
      .split(/\r?\n/)
      .forEach(function (line) {
        var match = line.match(/^a=rtpmap:(\d+)\s+H264\/90000/i);
        if (match && payloads.indexOf(match[1]) === -1) payloads.push(match[1]);
      });
    return payloads;
  }

  function addSamsungImageAttributes(sdp, isUhd) {
    var lines = String(sdp || "").split(/\r?\n/);
    var payloads = h264PayloadsFromSdp(sdp);
    if (!payloads.length) return { sdp: sdp, count: 0, payloads: [] };
    var maxWidth = isUhd === false ? 1920 : 3840;
    var maxHeight = isUhd === false ? 1080 : 2160;
    var videoStart = lines.findIndex(function (line) {
      return line.indexOf("m=video ") === 0;
    });
    if (videoStart < 0) return { sdp: sdp, count: 0, payloads: payloads };
    var videoEnd = lines.length;
    for (var i = videoStart + 1; i < lines.length; i += 1) {
      if (lines[i].indexOf("m=") === 0) {
        videoEnd = i;
        break;
      }
    }
    var attributes = payloads.map(function (payload) {
      return (
        "a=imageattr:" +
        payload +
        " send [x=[960:" +
        maxWidth +
        "],y=[540:" +
        maxHeight +
        "],fps=[60:60]]"
      );
    });
    lines.splice.apply(lines, [videoEnd, 0].concat(attributes));
    return { sdp: lines.join("\r\n"), count: attributes.length, payloads: payloads };
  }

  async function createVkStyleOffer(withSamsungPatch) {
    var result = {
      created: false,
      setLocalDescription: false,
      hasH264: false,
      hasOpus: false,
      hasDataChannel: false,
      imageAttrCount: 0,
      h264Payloads: [],
      sdpLength: 0,
      error: null
    };
    var pc = null;
    var dataChannel = null;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      dataChannel = pc.createDataChannel("InputStream", {
        ordered: false,
        maxPacketLifeTime: 1
      });
      var offer = await pc.createOffer();
      result.created = true;
      if (withSamsungPatch) {
        var patched = addSamsungImageAttributes(
          offer.sdp,
          report.device.isUdPanelSupported
        );
        offer.sdp = patched.sdp;
        result.imageAttrCount = patched.count;
      }
      result.sdpLength = offer.sdp ? offer.sdp.length : 0;
      result.h264Payloads = h264PayloadsFromSdp(offer.sdp);
      result.hasH264 = /H264\/90000/i.test(offer.sdp || "");
      result.hasOpus = /opus\/48000/i.test(offer.sdp || "");
      result.hasDataChannel = /m=application|webrtc-datachannel/i.test(offer.sdp || "");
      result.imageAttrCount = (offer.sdp.match(/^a=imageattr:/gm) || []).length;
      await pc.setLocalDescription(offer);
      result.setLocalDescription = true;
      result.dataChannel = {
        ordered: dataChannel.ordered,
        maxPacketLifeTime: dataChannel.maxPacketLifeTime,
        protocol: dataChannel.protocol,
        readyState: dataChannel.readyState
      };
    } catch (error) {
      result.error = errorText(error);
      report.errors.push({
        test: withSamsungPatch ? "webrtc.samsungPatchedOffer" : "webrtc.standardOffer",
        error: result.error
      });
    } finally {
      if (dataChannel) safe("dataChannel.close", function () { dataChannel.close(); });
      if (pc) safe("peerConnection.close", function () { pc.close(); });
    }
    return result;
  }

  async function collectWebRtcInfo() {
    report.webrtc = {
      available: typeof window.RTCPeerConnection === "function",
      receiverCapabilities: !!(
        window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities
      ),
      senderCapabilities: !!(
        window.RTCRtpSender && RTCRtpSender.getCapabilities
      )
    };
    if (!report.webrtc.available) return;
    report.webrtc.standardOffer = await createVkStyleOffer(false);
    report.webrtc.samsungPatchedOffer = await createVkStyleOffer(true);
  }

  function testLocalStorage() {
    var key = "vkplay-tizen-diag";
    try {
      localStorage.setItem(key, "ok");
      var ok = localStorage.getItem(key) === "ok";
      localStorage.removeItem(key);
      return ok;
    } catch (error) {
      report.errors.push({ test: "localStorage", error: errorText(error) });
      return false;
    }
  }

  function testCookies() {
    try {
      document.cookie = "vkplay_tizen_diag=ok; SameSite=Lax; path=/";
      var ok = document.cookie.indexOf("vkplay_tizen_diag=ok") >= 0;
      document.cookie = "vkplay_tizen_diag=; Max-Age=0; path=/";
      return ok;
    } catch (error) {
      report.errors.push({ test: "cookies", error: errorText(error) });
      return false;
    }
  }

  function testIndexedDb() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) return resolve(false);
      var request;
      try {
        request = indexedDB.open("vkplay-tizen-diag", 1);
      } catch (error) {
        report.errors.push({ test: "indexedDB.open", error: errorText(error) });
        return resolve(false);
      }
      var timer = setTimeout(function () {
        resolve(false);
      }, 4000);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains("probe")) {
          request.result.createObjectStore("probe");
        }
      };
      request.onerror = function () {
        clearTimeout(timer);
        report.errors.push({
          test: "indexedDB",
          error: request.error ? errorText(request.error) : "open failed"
        });
        resolve(false);
      };
      request.onsuccess = function () {
        clearTimeout(timer);
        var database = request.result;
        try {
          var transaction = database.transaction("probe", "readwrite");
          transaction.objectStore("probe").put("ok", "status");
          transaction.oncomplete = function () {
            database.close();
            resolve(true);
          };
          transaction.onerror = function () {
            database.close();
            resolve(false);
          };
        } catch (error) {
          database.close();
          report.errors.push({ test: "indexedDB.transaction", error: errorText(error) });
          resolve(false);
        }
      };
    });
  }

  async function collectStorageInfo() {
    report.storage = {
      localStorage: testLocalStorage(),
      cookies: testCookies(),
      indexedDB: await testIndexedDb(),
      origin: location.origin
    };
  }

  function testWebSocketRoundTrip() {
    return new Promise(function (resolve) {
      if (typeof window.WebSocket !== "function") return resolve(false);
      var settled = false;
      var socket;
      var payload = "vkplay-tizen-diag-" + Date.now();
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        if (socket) safe("websocket.timeout.close", function () { socket.close(); });
        resolve(false);
      }, 8000);
      try {
        socket = new WebSocket(WSS_ECHO_URL);
        socket.onopen = function () {
          socket.send(payload);
        };
        socket.onmessage = function (event) {
          if (String(event.data).indexOf(payload) >= 0 && !settled) {
            settled = true;
            clearTimeout(timer);
            socket.close();
            resolve(true);
          }
        };
        socket.onerror = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(false);
        };
        socket.onclose = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(false);
        };
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        report.errors.push({ test: "websocket", error: errorText(error) });
        resolve(false);
      }
    });
  }

  async function collectNetworkInfo() {
    report.network = {
      webSocketApi: typeof window.WebSocket === "function",
      webSocketUrl: WSS_ECHO_URL,
      webSocketRoundTrip: await testWebSocketRoundTrip()
    };
  }

  function gamepadSnapshot(gamepad) {
    return {
      index: gamepad.index,
      id: gamepad.id,
      mapping: gamepad.mapping,
      connected: gamepad.connected,
      axes: Array.prototype.map.call(gamepad.axes || [], function (value) {
        return Math.round(value * 1000) / 1000;
      }),
      buttons: Array.prototype.map.call(gamepad.buttons || [], function (button) {
        return {
          pressed: button.pressed,
          touched: button.touched,
          value: Math.round(button.value * 1000) / 1000
        };
      })
    };
  }

  function activeInputSummary(gamepad) {
    var pressed = [];
    var axes = [];
    Array.prototype.forEach.call(gamepad.buttons || [], function (button, index) {
      if (button.pressed || button.value > 0.05) {
        pressed.push(index + ":" + Math.round(button.value * 100) / 100);
      }
    });
    Array.prototype.forEach.call(gamepad.axes || [], function (value, index) {
      if (Math.abs(value) > 0.08) axes.push(index + ":" + Math.round(value * 100) / 100);
    });
    return { pressed: pressed, axes: axes };
  }

  function recordInput(type, text) {
    inputEvents.push({ at: new Date().toISOString(), type: type, value: text });
    if (inputEvents.length > 100) inputEvents.shift();
    el.inputLog.textContent = inputEvents
      .slice(-12)
      .reverse()
      .map(function (event) {
        return event.at.slice(11, 19) + "  " + event.type + "  " + event.value;
      })
      .join("\n");
  }

  function paintGamepads(gamepads) {
    if (!gamepads.length) {
      el.gamepads.className = "gamepads empty";
      el.gamepads.textContent = "Подключённые геймпады пока не обнаружены.";
      el.gamepadStatus.textContent = "ЖДУ ВВОД";
      el.gamepadStatus.className = "badge pending";
      return;
    }
    el.gamepads.className = "gamepads";
    el.gamepads.innerHTML = gamepads
      .map(function (gamepad) {
        var active = activeInputSummary(gamepad);
        return (
          '<div class="gamepad"><strong>#' +
          gamepad.index +
          " · " +
          escapeHtml(gamepad.id) +
          "</strong><code>mapping=" +
          escapeHtml(gamepad.mapping || "non-standard") +
          " · axes=[" +
          escapeHtml(active.axes.join(", ") || "neutral") +
          "] · buttons=[" +
          escapeHtml(active.pressed.join(", ") || "none") +
          "]</code></div>"
        );
      })
      .join("");
    el.gamepadStatus.textContent = gamepadActivitySeen ? "ВВОД ИДЁТ" : "ОБНАРУЖЕН";
    el.gamepadStatus.className = "badge " + (gamepadActivitySeen ? "good" : "warn");
  }

  function pollGamepads(timestamp) {
    var gamepads = [];
    if (typeof navigator.getGamepads === "function") {
      gamepads = Array.prototype.filter.call(navigator.getGamepads() || [], Boolean);
    }
    var activeParts = [];
    gamepads.forEach(function (gamepad) {
      var active = activeInputSummary(gamepad);
      if (active.pressed.length || active.axes.length) {
        gamepadActivitySeen = true;
        activeParts.push(
          "#" + gamepad.index + " buttons=" + active.pressed.join(",") + " axes=" + active.axes.join(",")
        );
      }
    });
    if (activeParts.length) {
      var latest = inputEvents[inputEvents.length - 1];
      var value = activeParts.join(" | ");
      if (!latest || latest.type !== "gamepad" || latest.value !== value) {
        recordInput("gamepad", value);
      }
      if (!gamepadAutoReportQueued) {
        gamepadAutoReportQueued = true;
        setTimeout(sendReportToMac, 1800);
      }
    }
    if (timestamp - lastGamepadPaint > 120) {
      report.gamepads = gamepads.map(gamepadSnapshot);
      paintGamepads(gamepads);
      if (!el.detailsPanel.classList.contains("hidden")) {
        report.inputEvents = inputEvents.slice(-60);
        el.details.textContent = JSON.stringify(report, null, 2);
      }
      lastGamepadPaint = timestamp;
    }
    requestAnimationFrame(pollGamepads);
  }

  function installGamepadListeners() {
    window.addEventListener("gamepadconnected", function (event) {
      recordInput("connected", event.gamepad.id + " (#" + event.gamepad.index + ")");
    });
    window.addEventListener("gamepaddisconnected", function (event) {
      recordInput("disconnected", event.gamepad.id + " (#" + event.gamepad.index + ")");
    });
    requestAnimationFrame(pollGamepads);
  }

  async function sendReportToMac() {
    report.generatedAt = new Date().toISOString();
    report.inputEvents = inputEvents.slice(-60);
    el.runState.textContent = "ОТПРАВКА";
    el.runState.className = "badge pending";
    try {
      var response = await fetch(REPORT_URL, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(report)
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      el.runState.textContent = "НА MAC";
      el.runState.className = "badge good";
      recordInput("report", "Отправлен на " + REPORT_URL);
    } catch (error) {
      el.runState.textContent = "НЕ УШЁЛ";
      el.runState.className = "badge bad";
      recordInput("report-error", errorText(error));
    }
  }

  function toggleDetails() {
    el.detailsPanel.classList.toggle("hidden");
    if (!el.detailsPanel.classList.contains("hidden")) {
      el.details.textContent = JSON.stringify(report, null, 2);
      el.detailsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  async function toggleFullscreenTest() {
    var root = document.documentElement;
    report.fullscreen.attempted = true;
    try {
      if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
        await document.webkitExitFullscreen();
      } else if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (root.webkitRequestFullscreen) {
        await root.webkitRequestFullscreen({ navigationUI: "hide" });
      } else if (root.requestFullscreen) {
        await root.requestFullscreen({ navigationUI: "hide" });
      } else {
        throw new Error("No fullscreen request method");
      }
      report.fullscreen.error = null;
    } catch (error) {
      report.fullscreen.error = errorText(error);
      recordInput("fullscreen-error", report.fullscreen.error);
    }
    render();
  }

  function installFullscreenListeners() {
    function updateFullscreenState() {
      var active = !!(document.webkitFullscreenElement || document.fullscreenElement);
      report.fullscreen.active = active;
      report.fullscreen.entered = report.fullscreen.entered || active;
      recordInput("fullscreen", active ? "entered" : "exited");
      render();
    }
    document.addEventListener("webkitfullscreenchange", updateFullscreenState);
    document.addEventListener("fullscreenchange", updateFullscreenState);
    document.addEventListener("webkitfullscreenerror", function () {
      report.fullscreen.error = "webkitfullscreenerror";
      recordInput("fullscreen-error", "webkitfullscreenerror");
      render();
    });
    document.addEventListener("fullscreenerror", function () {
      report.fullscreen.error = "fullscreenerror";
      recordInput("fullscreen-error", "fullscreenerror");
      render();
    });
  }

  function installRemoteHandlers() {
    document.addEventListener("keydown", function (event) {
      var code = event.keyCode;
      if (code === 38) {
        window.scrollBy({ top: -180, behavior: "smooth" });
        event.preventDefault();
      } else if (code === 40) {
        window.scrollBy({ top: 180, behavior: "smooth" });
        event.preventDefault();
      } else if (code === 403) {
        runAllTests();
        event.preventDefault();
      } else if (code === 404) {
        sendReportToMac();
        event.preventDefault();
      } else if (code === 405) {
        toggleDetails();
        event.preventDefault();
      } else if (code === 406) {
        toggleFullscreenTest();
        event.preventDefault();
      } else if (code === 10009) {
        if (!el.detailsPanel.classList.contains("hidden")) {
          el.detailsPanel.classList.add("hidden");
        } else if (history.length > 1) {
          history.back();
        } else if (
          window.tizen &&
          tizen.application &&
          typeof tizen.application.getCurrentApplication === "function"
        ) {
          tizen.application.getCurrentApplication().exit();
        }
        event.preventDefault();
      }
      if ([38, 40, 403, 404, 405, 406, 10009].indexOf(code) === -1) {
        recordInput("remote-key", "keyCode=" + code + " key=" + event.key + " code=" + event.code);
      }
    });
  }

  function registerRemoteKeys() {
    if (!window.tizen || !tizen.tvinputdevice || typeof tizen.tvinputdevice.registerKey !== "function") {
      return;
    }

    [
      "ColorF0Red",
      "ColorF1Green",
      "ColorF2Yellow",
      "ColorF3Blue",
      "MediaPlayPause",
      "MediaPlay",
      "MediaPause",
      "MediaStop"
    ].forEach(function (keyName) {
      try {
        tizen.tvinputdevice.registerKey(keyName);
      } catch (error) {
        report.errors.push({ test: "tvinputdevice.registerKey." + keyName, error: errorText(error) });
      }
    });
  }

  async function runAllTests() {
    report = createEmptyReport();
    el.runState.textContent = "ПРОВЕРКА";
    el.runState.className = "badge pending";
    el.summary.textContent = "Собираю API и создаю локальный WebRTC offer…";
    el.cards.innerHTML = card("Диагностика", "pending", "В РАБОТЕ", [
      ["Этап", "Device → Web APIs → WebRTC → WSS → Storage"]
    ]);
    await collectDeviceInfo();
    collectFeatureInfo();
    collectMediaInfo();
    render();
    await collectWebRtcInfo();
    render();
    await Promise.all([collectStorageInfo(), collectNetworkInfo()]);
    render();
    el.runState.textContent = "ГОТОВО";
    el.runState.className = "badge good";
    setTimeout(sendReportToMac, 1200);
  }

  el.reportTarget.textContent = "Mac: " + REPORT_URL;
  setInterval(function () {
    el.clock.textContent = nowLabel();
  }, 1000);
  el.clock.textContent = nowLabel();
  registerRemoteKeys();
  installGamepadListeners();
  installFullscreenListeners();
  installRemoteHandlers();
  runAllTests();
})();
