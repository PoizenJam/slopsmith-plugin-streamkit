/* Stream Kit OBS scene controller.
 *
 * Subscribes to the producer phase feed (via SK) and drives OBS scene changes
 * over obs-websocket v5 — raw WebSocket + crypto.subtle, no library/CDN, so it
 * works offline as an OBS browser source/dock. Because it loads the http
 * Slopsmith host and connects to a local ws:// endpoint, there's no
 * mixed-content barrier and it doesn't depend on a focused tab.
 *
 * v5 flow: Hello(op0) → [compute auth] → Identify(op1) → Identified(op2) →
 * Request(op6 SetCurrentProgramScene). Config (connection + phase→scene map)
 * is fetched from the backend and re-polled so settings changes propagate. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let cfg = null, ws = null, identified = false;
  let lastScene = null, currentScene = null, lastPhase = null, reconnectT = null, reqId = 0, manualClose = false;

  // Distinct non-empty scenes referenced by the phase map — the set the
  // controller "manages". With the guard on, it only switches while OBS is
  // already on one of these, leaving Intro/Outro/Just-Chatting etc. untouched.
  function managedScenes() {
    const set = new Set();
    if (cfg && cfg.map) for (const k in cfg.map) { const v = cfg.map[k]; if (v) set.add(v); }
    return set;
  }
  function isManaged(scene) { return scene != null && managedScenes().has(scene); }

  function setObs(text, cls) { const e = $("obs"); e.textContent = text; e.className = "sc-v" + (cls ? " " + cls : ""); }
  function note(msg) { $("note").textContent = msg || ""; }

  async function sha256b64(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    const arr = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  }

  function disconnect() {
    manualClose = true;
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
    identified = false; currentScene = null;
  }
  function scheduleReconnect() {
    if (reconnectT || !cfg || !cfg.enabled) return;
    reconnectT = setTimeout(() => { reconnectT = null; connect(); }, 3000);
  }

  function connect() {
    if (!cfg || !cfg.enabled) { setObs("disabled", "warn"); note("automation off"); return; }
    disconnect();
    manualClose = false;
    const url = "ws://" + cfg.host + ":" + cfg.port;
    setObs("connecting…", "warn"); note(url);
    let sock;
    try { sock = new WebSocket(url, "obswebsocket.json"); }
    catch (e) { setObs("error", "err"); note(String(e)); scheduleReconnect(); return; }
    ws = sock;

    sock.onmessage = async (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.op === 0) {                       // Hello
        // eventSubscriptions: 4 == Scenes — we need CurrentProgramSceneChanged
        // to know which scene OBS is on (for the guard).
        const d = { rpcVersion: 1, eventSubscriptions: 4 };
        const a = m.d && m.d.authentication;
        if (a) {
          if (!cfg.password) { setObs("auth required", "err"); note("set the obs-websocket password"); return; }
          const secret = await sha256b64(cfg.password + a.salt);
          d.authentication = await sha256b64(secret + a.challenge);
        }
        sock.send(JSON.stringify({ op: 1, d }));
      } else if (m.op === 2) {                // Identified
        identified = true; setObs("connected", "ok"); note("");
        lastScene = null;
        request("GetCurrentProgramScene");    // learn the current scene first
      } else if (m.op === 5) {                // Event
        if (m.d && m.d.eventType === "CurrentProgramSceneChanged") {
          currentScene = (m.d.eventData && m.d.eventData.sceneName) || currentScene;
          updateSceneStatus();
        }
      } else if (m.op === 7) {                // RequestResponse
        const d = m.d || {}, st = d.requestStatus;
        if (d.requestType === "GetCurrentProgramScene" && d.responseData) {
          currentScene = d.responseData.currentProgramSceneName || d.responseData.sceneName || currentScene;
          updateSceneStatus();
          applyPhase(lastPhase);              // sync once we know where OBS is
        } else if (st && !st.result) {
          note("OBS: " + (st.comment || st.code || "request failed"));
        }
      }
    };
    sock.onerror = () => { setObs("error", "err"); };
    sock.onclose = () => {
      identified = false;
      if (!manualClose) { setObs("disconnected", "err"); note("retrying…"); scheduleReconnect(); }
    };
  }

  function request(requestType, requestData) {
    if (!ws || !identified) return;
    reqId++;
    ws.send(JSON.stringify({ op: 6, d: { requestType, requestId: "sk" + reqId, requestData: requestData || {} } }));
  }

  function updateSceneStatus() {
    const cur = currentScene || "—";
    const guarded = cfg && cfg.guard && currentScene != null && !isManaged(currentScene);
    $("scene").textContent = cur + (guarded ? "  ·  holding" : "");
    $("scene").className = "sc-v" + (guarded ? " warn" : "");
  }

  function setScene(name) {
    if (!ws || !identified || !name || name === lastScene) return;
    // Guard: don't take over while OBS is on an unmanaged scene (Intro/Outro/
    // Just Chatting). If we don't yet know the current scene, hold off too.
    if (cfg && cfg.guard) {
      if (currentScene == null) { note("waiting for current scene…"); return; }
      if (!isManaged(currentScene)) { note("holding — on unmanaged scene “" + currentScene + "”"); updateSceneStatus(); return; }
    }
    request("SetCurrentProgramScene", { sceneName: name });
    lastScene = name; currentScene = name; updateSceneStatus(); note("");
  }
  function applyPhase(phase) {
    if (!phase) return;
    const name = cfg && cfg.enabled && cfg.map ? cfg.map[phase] : "";
    $("phase").textContent = phase + (cfg && cfg.enabled ? (name ? " → " + name : " (unmapped)") : "");
    if (name) setScene(name);
  }

  async function loadConfig() {
    try {
      const r = await fetch(SK.api("scene-config"));
      const next = await r.json();
      const connChanged = !cfg || cfg.host !== next.host || cfg.port !== next.port ||
                          cfg.password !== next.password || cfg.enabled !== next.enabled;
      cfg = next;
      if (connChanged) {
        lastScene = null;
        if (cfg.enabled) connect();
        else { disconnect(); setObs("disabled", "warn"); note("automation off"); }
      }
    } catch (e) { /* keep last good config */ }
  }

  SK.onState((s) => { lastPhase = s.phase; applyPhase(s.phase); });
  loadConfig();
  setInterval(loadConfig, 10000);   // pick up settings changes without a reload
})();
