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

  var VERSION = "0.1.5";
  var REPORT_URL = "http://192.168.0.149:8787/report";
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

  function patchSamsungSdp(sdp) {
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
        output.push("a=imageattr:" + h264[1] + " " + IMAGE_ATTR);
        imageAttrPayloads[h264[1]] = true;
      }
    }

    return output.join(newline);
  }

  function countSamsungImageAttrs(sdp) {
    var matches = String(sdp || "").match(/^a=imageattr:\d+\s+send\s+/gim);
    return matches ? matches.length : 0;
  }

  function install(win) {
    var currentHostname =
      win && win.location ? String(win.location.hostname || "").toLowerCase() : "";
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

    if (!isCloudHost && !isVkPlayAccountHost && !isVkAuthHost) {
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
    var realUserAgent = nav.userAgent;
    var peerConnections = [];
    var recentEvents = [];
    var reportTimer = 0;
    var overlay = null;
    var overlayDetails = null;
    var overlayVisible = false;
    var previousGamepadButtons = Object.create(null);
    var gamepadNavigationState = Object.create(null);
    var authScanTimer = 0;

    var state = {
      installed: true,
      version: VERSION,
      startedAt: new Date().toISOString(),
      targetModel: TARGET_MODEL,
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
      reportStatus: "not-sent",
      reportError: null,
      errors: []
    };

    function addEvent(type, detail) {
      var entry = {
        at: new Date().toISOString(),
        type: type,
        detail: detail == null ? "" : String(detail)
      };
      recentEvents.push(entry);
      if (recentEvents.length > 60) recentEvents.shift();
      try {
        win.console.info("[VK TV] " + type, detail == null ? "" : detail);
      } catch (_) {}
      renderOverlay();
    }

    function recordError(scope, error) {
      var entry = {
        at: new Date().toISOString(),
        scope: scope,
        error: errorText(error)
      };
      state.errors.push(entry);
      if (state.errors.length > 30) state.errors.shift();
      addEvent("error:" + scope, entry.error);
      queueReport(500);
    }

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
            var patchedSdp = patchSamsungSdp(description.sdp);
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
            var patchedSdp = patchSamsungSdp(description.sdp);
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
      addEvent("rtc-shim", "Samsung imageattr 960-1920 × 540-1080 @ 60 fps");
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

      function rebuildCombinedStream() {
        if (!videoElement || !videoStream) {
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

      Object.defineProperty(mediaPrototype, "srcObject", {
        configurable: srcObjectDescriptor.configurable !== false,
        enumerable: srcObjectDescriptor.enumerable,
        get: function () {
          return srcObjectDescriptor.get.call(this);
        },
        set: function (stream) {
          if (isVkAudio(this)) {
            audioElement = this;
            audioStream = stream;
            watchStream(stream);
            nativeSet(this, new win.MediaStream());
            rebuildCombinedStream();
            return;
          }

          if (isVkVideo(this)) {
            videoElement = this;
            videoStream = stream;
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
        win.clearTimeout(authScanTimer);
        authScanTimer = win.setTimeout(function () {
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
      addEvent("vk-id-navigation", "focus + Enter / gamepad A / blue key");
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

    function isGameFullscreen() {
      var fullscreen = doc.webkitFullscreenElement || doc.fullscreenElement;
      var player = doc.getElementById("player");
      var stream = player && player.srcObject;
      return Boolean(
        fullscreen &&
          stream &&
          typeof stream.getVideoTracks === "function" &&
          stream.getVideoTracks().length
      );
    }

    function requestFullscreen() {
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
      var directions = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down"
      };

      doc.addEventListener(
        "keydown",
        function (event) {
          var keyCode = event.keyCode || event.which;

          if (keyCode === 403) {
            event.preventDefault();
            sendReport("red-key");
            return;
          }
          if (keyCode === 404) {
            event.preventDefault();
            requestFullscreen();
            return;
          }
          if (keyCode === 405) {
            event.preventDefault();
            overlayVisible = !overlayVisible;
            if (overlay) overlay.style.opacity = overlayVisible ? "1" : "0.3";
            renderOverlay();
            return;
          }
          if (keyCode === 406) {
            if (activateVkIdAction("blue-key")) {
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }
          if (keyCode === 10009) {
            event.preventDefault();
            event.stopPropagation();
            goBack();
            return;
          }

          if (isGameFullscreen()) return;

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
      addEvent("remote-navigation", "arrows / Enter / Back / color keys");
    }

    function updateGamepads() {
      var pads = [];
      try {
        var raw = nav.getGamepads ? nav.getGamepads() : [];
        for (var index = 0; index < raw.length; index += 1) {
          var pad = raw[index];
          if (!pad) continue;
          pads.push({
            index: pad.index,
            id: pad.id,
            mapping: pad.mapping,
            axes: pad.axes.length,
            buttons: pad.buttons.length
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
        if (isGameFullscreen()) return;
        var raw = nav.getGamepads ? nav.getGamepads() : [];
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
        addEvent("gamepad-connected", event.gamepad.id);
        updateGamepads();
        queueReport(500);
      });
      win.addEventListener("gamepaddisconnected", function (event) {
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
          "a:focus,button:focus,input:focus,select:focus,textarea:focus," +
          "iframe:focus,[role=button]:focus,[tabindex]:focus{" +
          "outline:4px solid #b6e824!important;outline-offset:4px!important;" +
          "box-shadow:0 0 0 8px rgba(182,232,36,.25)!important}" +
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
        "\nПульт/стик: навигация · A/OK: выбрать · B/Back: назад · Y/синяя: VK ID";
    }

    function installOverlay() {
      function mount() {
        renderOverlay();
        win.setTimeout(function () {
          if (!overlayVisible && overlay) overlay.style.opacity = "0.3";
        }, 7000);
      }
      if (doc.body) mount();
      else doc.addEventListener("DOMContentLoaded", mount, { once: true });
    }

    function collectStats() {
      return Promise.all(
        peerConnections.map(function (pc, index) {
          if (!pc.getStats) return Promise.resolve({ index: index, stats: [] });
          return pc
            .getStats()
            .then(function (report) {
              var stats = [];
              report.forEach(function (item) {
                if (
                  item.type === "inbound-rtp" ||
                  item.type === "candidate-pair" ||
                  item.type === "transport"
                ) {
                  stats.push({
                    id: item.id,
                    type: item.type,
                    kind: item.kind || item.mediaType,
                    state: item.state,
                    nominated: item.nominated,
                    bytesReceived: item.bytesReceived,
                    packetsReceived: item.packetsReceived,
                    packetsLost: item.packetsLost,
                    jitter: item.jitter,
                    framesDecoded: item.framesDecoded,
                    framesDropped: item.framesDropped,
                    framesPerSecond: item.framesPerSecond,
                    frameWidth: item.frameWidth,
                    frameHeight: item.frameHeight,
                    totalDecodeTime: item.totalDecodeTime,
                    jitterBufferDelay: item.jitterBufferDelay,
                    jitterBufferEmittedCount: item.jitterBufferEmittedCount,
                    currentRoundTripTime: item.currentRoundTripTime,
                    availableIncomingBitrate: item.availableIncomingBitrate
                  });
                }
              });
              return { index: index, stats: stats };
            })
            .catch(function (error) {
              return { index: index, error: errorText(error), stats: [] };
            });
        })
      );
    }

    function buildReport(reason) {
      summarizePeers();
      updateGamepads();
      return collectStats().then(function (rtcStats) {
        return {
          schema: "vkplay-tizen-live/1",
          generatedAt: new Date().toISOString(),
          reason: reason,
          device: {
            modelCode: TARGET_MODEL,
            realUserAgent: realUserAgent,
            effectiveUserAgent: nav.userAgent,
            screen: win.screen.width + "x" + win.screen.height,
            devicePixelRatio: win.devicePixelRatio
          },
          page: {
            origin: win.location.origin,
            pathname: win.location.pathname
          },
          patches: {
            browserShim: state.browserShim,
            rtcShim: state.rtcShim,
            mediaShim: state.mediaShim,
            fullscreenShim: state.fullscreenShim,
            imageAttrCount: state.imageAttrCount
          },
          media: {
            sourceVideoTracks: state.videoTracks,
            sourceAudioTracks: state.audioTracks,
            combinedTracks: state.combinedTracks
          },
          gamepads: state.gamepads,
          peers: state.peerStates,
          rtcStats: rtcStats,
          recentEvents: recentEvents.slice(-40),
          errors: state.errors.slice(-20)
        };
      });
    }

    function sendReport(reason) {
      state.reportStatus = "sending";
      state.reportError = null;
      renderOverlay();
      return buildReport(reason || "manual")
        .then(function (report) {
          var controller = win.AbortController ? new win.AbortController() : null;
          var timeout = win.setTimeout(function () {
            if (controller) controller.abort();
          }, 8000);
          return win.fetch(REPORT_URL, {
            method: "POST",
            mode: "cors",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(report),
            signal: controller ? controller.signal : undefined
          }).then(function (response) {
            win.clearTimeout(timeout);
            return response;
          }, function (error) {
            win.clearTimeout(timeout);
            throw error;
          });
        })
        .then(function (response) {
          if (!response.ok) throw new Error("Report server HTTP " + response.status);
          state.reportStatus = "sent";
          addEvent("report", "sent to Mac");
          return response.json();
        })
        .catch(function (error) {
          state.reportStatus = "failed";
          state.reportError = errorText(error);
          addEvent("report-failed", state.reportError);
          return null;
        });
    }

    function queueReport(delay) {
      win.clearTimeout(reportTimer);
      reportTimer = win.setTimeout(function () {
        sendReport("automatic");
      }, delay == null ? 1200 : delay);
    }

    win.addEventListener("error", function (event) {
      recordError("window", event.error || event.message);
    });
    win.addEventListener("unhandledrejection", function (event) {
      recordError("promise", event.reason);
    });

    var publicApi = {
      installed: true,
      version: VERSION,
      state: state,
      patchSamsungSdp: patchSamsungSdp,
      sendReport: sendReport,
      showDiagnostics: function () {
        overlayVisible = true;
        if (overlay) overlay.style.opacity = "1";
        renderOverlay();
      }
    };
    win.__VKPLAY_TIZEN__ = publicApi;

    installBrowserShim();
    if (
      win.location.hostname === "cloud.vkplay.ru" &&
      (win.location.pathname === "/" || win.location.pathname === "")
    ) {
      addEvent("route", "/dashboard");
      win.location.replace("https://cloud.vkplay.ru/dashboard");
      return publicApi;
    }
    if (isCloudHost) {
      installRtcShim();
      installMediaShim();
      installFullscreenShim();
    }
    installStyles();
    installOverlay();
    installVkIdNavigation();
    installRemoteNavigation();
    installGamepadMonitor();
    if (isCloudHost) queueReport(2500);

    addEvent("installed", VERSION);
    return publicApi;
  }

  return {
    version: VERSION,
    imageAttr: IMAGE_ATTR,
    patchSamsungSdp: patchSamsungSdp,
    countSamsungImageAttrs: countSamsungImageAttrs,
    install: install
  };
});
