/* stream_kit overlay core — shared by every OBS browser-source overlay.
 *
 * Each overlay page defines a render(state) function and calls SK.onState(render);
 * the core owns the SSE subscription (auto-reconnecting), the instrument family
 * table fetch, and the common formatters. Overlays never re-implement these.
 *
 * Runs in an OBS browser-source context (CEF), a separate context from the
 * player tab — so everything here is fed over the backend, not window.slopsmith.
 */
window.SK = (function () {
  "use strict";
  const PLUGIN_ID = "stream_kit";
  const api = (p) => `/api/plugins/${PLUGIN_ID}/${p}`;

  let families = null;
  fetch(api("instruments")).then((r) => r.json()).then((t) => { families = t; }).catch(() => {});

  // Subscribe to the live state feed. cb(state) is called on every frame.
  function onState(cb) {
    const es = new EventSource(api("events"));
    es.onmessage = (e) => { try { cb(JSON.parse(e.data)); } catch (_) {} };
    es.onerror = () => {}; // EventSource auto-retries
    return es;
  }

  // Album art for a song lives at the core route, not under the plugin.
  function artUrl(songId) {
    return songId ? `/api/song/${encodeURIComponent(songId)}/art` : "";
  }

  // Fetch the per-song chart structures (beats/sections/phrases). Overlays call
  // this when the SSE state's songId changes — not every frame.
  function fetchSong() {
    return fetch(api("song")).then((r) => r.json()).catch(() => null);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // Reference-pitch hint. centOffset is cents from A440 (0 = standard, omitted).
  function fmtCents(c) {
    if (!c) return "";
    const sign = c > 0 ? "+" : "\u2212";
    const hz = (440 * Math.pow(2, c / 1200)).toFixed(1);
    return `A${hz} (${sign}${Math.abs(c).toFixed(1)}\u00A2)`;
  }

  // Per-string offsets -> compact tuning label.
  function tuningLabel(offsets) {
    if (!Array.isArray(offsets)) return String(offsets);
    if (offsets.every((o) => o === 0)) return "Standard";
    if (offsets.length && offsets.every((o) => o === offsets[0])) return (offsets[0] > 0 ? "+" : "") + offsets[0] + " all";
    return offsets.join(",");
  }

  // Instrument-specific detail line, family-aware (drums show kit, fretted show
  // tuning/strings/capo/reference-pitch). Driven by whatever the block carries.
  function instrumentDetail(inst) {
    inst = inst || {};
    const bits = [];
    if (inst.tuning) bits.push(tuningLabel(inst.tuning));
    if (inst.stringCount != null) bits.push(inst.stringCount + "-string");
    if (inst.capo) bits.push("Capo " + inst.capo);
    if (inst.centOffset) bits.push(fmtCents(inst.centOffset));
    if (inst.kit) bits.push(typeof inst.kit === "object" ? "Drum kit" : String(inst.kit));
    return bits.join("  \u00B7  ");
  }

  function fmtClock(sec) {
    if (sec == null || !isFinite(sec)) return "";
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  // True while a song is loaded/playing/paused/results (overlays hide otherwise).
  function songActive(s) {
    return !!(s && s.title && (s.phase === "playing" || s.phase === "paused" ||
              s.phase === "loaded" || s.phase === "results"));
  }

  // ── Phrase/section ladder rendering (shared by the full-ladder overlays) ──
  // RockSniffer's gradeCode palette + accuracy gradient, ported verbatim.
  function gradeColor(g) {
    return ({ Perfect: "lime", Good: "gold", Passed: "indigo", Failed: "red" })[g] || "grey";
  }
  function accuracyGradient(a) {
    if (a == null) return "grey";
    if (a < 50) return "rgb(255,0,0)";
    const r = Math.min((100 - a) / 25, 1) * 255, g = Math.min((a - 50) / 25, 1) * 255;
    return "rgb(" + (r | 0) + "," + (g | 0) + ",0)";
  }

  // Render the layered timer bar: per-phrase segments (height = relative DD,
  // color = grade once passed), a current-phrase overlay, section ticks
  // (lime/red vs best once passed), and the playhead. Segments are (re)built
  // only when the chart changes; colors/positions update each frame.
  // `d` = { phrases, sections, lp (ladder.phrases), ls (ladder.sections), time, duration }.
  function renderLadderBar(bar, d) {
    const dur = d.duration || 0, t = d.time || 0;
    if (!dur) return;
    const phrases = d.phrases || [], sections = d.sections || [];
    const sig = dur + "/" + phrases.length + "/" + sections.length;
    if (bar._sig !== sig) {
      bar.innerHTML = "";
      bar._pSeg = []; bar._sSeg = [];
      const maxDif = phrases.reduce((m, p) => Math.max(m, p.max_difficulty || 0), 0) || 1;
      phrases.forEach((p, i) => {
        const start = i === 0 ? 0 : (p.start_time || 0);
        const end = p.end_time != null ? p.end_time : dur;
        const seg = document.createElement("div");
        seg.className = "timerBarPhrase";
        seg.style.left = (100 * start / dur) + "%";
        seg.style.width = (100 * Math.max(0, end - start) / dur) + "%";
        seg.style.height = Math.round(((p.max_difficulty || 0) / maxDif) * 100) + "%";
        seg.dataset.start = start; seg.dataset.end = end; seg.dataset.idx = i;
        bar.appendChild(seg); bar._pSeg.push(seg);
      });
      const cur = document.createElement("div");
      cur.className = "timerBarCurrentPhrase"; cur.style.display = "none";
      bar.appendChild(cur); bar._cur = cur;
      sections.forEach((s, i) => {
        const start = i === 0 ? 0 : (s.time || 0);
        const end = (i + 1 < sections.length) ? (sections[i + 1].time || dur) : dur;
        const seg = document.createElement("div");
        seg.className = "timerBarSection";
        seg.style.left = (100 * start / dur) + "%";
        seg.style.width = (100 * Math.max(0, end - start) / dur) + "%";
        seg.dataset.end = end; seg.dataset.idx = i;
        bar.appendChild(seg); bar._sSeg.push(seg);
      });
      const pm = document.createElement("div");
      pm.className = "playMarker"; bar.appendChild(pm); bar._pm = pm;
      bar._sig = sig;
    }
    const lp = d.lp || [], ls = d.ls || [], prog = 100 * t / dur;
    // Phrase colors: once passed, grade color (or default until played).
    let curIdx = -1;
    bar._pSeg.forEach((seg) => {
      const i = +seg.dataset.idx, end = +seg.dataset.end, start = +seg.dataset.start, l = lp[i];
      if (end <= t && l && l.accuracy != null) seg.style.backgroundColor = gradeColor(l.grade);
      else seg.style.backgroundColor = "";
      if (t >= start && t < end) curIdx = i;
    });
    // Current-phrase overlay: from its start to the playhead.
    if (curIdx >= 0) {
      const seg = bar._pSeg[curIdx], start = +seg.dataset.start;
      bar._cur.style.display = "";
      bar._cur.style.left = (100 * start / dur) + "%";
      bar._cur.style.width = Math.max(0, prog - 100 * start / dur) + "%";
      bar._cur.style.height = seg.style.height;
    } else { bar._cur.style.display = "none"; }
    // Section ticks: lime/red vs best once passed.
    bar._sSeg.forEach((seg) => {
      const i = +seg.dataset.idx, end = +seg.dataset.end, l = ls[i];
      if (end <= t && l && l.best != null && l.accuracy != null) seg.style.backgroundColor = (l.accuracy >= l.best ? "lime" : "red");
      else seg.style.backgroundColor = "";
    });
    bar._pm.style.width = Math.max(0, Math.min(100, prog)) + "%";
  }

  return { api, onState, fetchSong, artUrl, esc, fmtCents, tuningLabel, instrumentDetail, fmtClock, songActive,
           gradeColor, accuracyGradient, renderLadderBar, families: () => families };
})();
