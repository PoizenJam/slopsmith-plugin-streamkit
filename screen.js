/* stream_kit — producer + in-app dashboard.
 *
 * Loaded once per session as a global <script> (see app.js loadPlugins). The
 * PRODUCER must capture window.slopsmith events whenever the user plays —
 * which is on the *player* screen, not this plugin's screen — so it binds at
 * top level and persists for the whole session, guarded against double-bind.
 *
 * Forward-compatibility: nothing here hardcodes guitar. The instrument family
 * table is fetched from the backend (single source of truth, instruments.py),
 * classification + the instrument block + scorer wiring are all driven off it.
 * Adding drums/keys/vocals/etc. later is a data edit in instruments.py.
 *
 * Two assumptions, both isolated and flagged for M1 validation:
 *   1. window.highway.getSongInfo() returns the song_info fields (title/artist/
 *      duration/arrangement/index/tuning/stringCount/capo). The exact key names
 *      are read defensively in readSongInfo(); a mismatch is a one-function fix.
 *   2. note_detect emits global 'notedetect:hit'/'notedetect:miss' DOM events
 *      (verified in its source). We tally those ourselves rather than calling
 *      its instance-scoped getStats(), which isn't exposed globally.
 */
(function () {
  "use strict";

  const PLUGIN_ID = "stream_kit";
  const api = (p) => `/api/plugins/${PLUGIN_ID}/${p}`;

  // ── Scorer registry — keyed by the descriptor's `scorer` *kind* ───────────
  // "pitch" is what slopsmith-plugin-notedetect provides today. A future drum
  // scorer would register an "onset" entry here and drums would gain accuracy
  // with no other change. present() probes without importing (soft dependency).
  const SCORERS = {
    pitch: {
      present: () => typeof window.createNoteDetector === "function",
      hitEvent: "notedetect:hit",
      missEvent: "notedetect:miss",
    },
    // onset: { present: () => typeof window.createDrumDetector === "function",
    //          hitEvent: "drumdetect:hit", missEvent: "drumdetect:miss" },
  };

  // ── Producer singleton ────────────────────────────────────────────────────
  if (!window.__streamKitProducer) {
    window.__streamKitProducer = new Producer();
    window.__streamKitProducer.start();
  }
  // The dashboard re-binds whenever the screen DOM is (re)injected.
  bindDashboard(window.__streamKitProducer);

  // ══════════════════════════════════════════════════════════════════════════
  function Producer() {
    this.families = null;        // fetched instrument table
    this.state = { phase: "idle" };
    this.song = null;            // metadata captured at song:ready
    this.tally = freshTally();
    this.scorerKind = null;      // active scorer kind for the current family, or null
    // Per-phrase / per-section accuracy ladder (current attempt) + previous best.
    this.sections = [];          // [{name, time}] window starts
    this.phrases = [];           // [{start_time, end_time, ...}]
    this.sectionTally = [];      // parallel to sections: {hits, misses}
    this.phraseTally = [];       // parallel to phrases:  {hits, misses}
    this.best = null;            // previous-best for the current arrangement
    this.playAccum = 0;          // seconds played (paused time excluded)
    this.lastPlayStart = null;
    this.clean = true;
    // RockSniffer-parity playthrough timestamps (yyyy-MM-dd HH:mm:ss, local):
    this.metadataTs = null;      // song:ready  (metadata loaded)
    this.startTs = null;         // first song:play (actual start)
    this.paused = false;         // any pause during the run
    this.clientId = clientId();
    this._lastPosPush = 0;
  }

  Producer.prototype.start = async function () {
    try {
      const r = await fetch(api("instruments"));
      this.families = await r.json();
    } catch (e) {
      // Degrade to an empty table: classify() falls back to "unknown".
      this.families = { default: "unknown", families: {} };
    }
    this.bindBus();
    this.bindScorerEvents();
  };

  Producer.prototype.bindBus = function () {
    const sm = window.slopsmith;
    if (!sm || typeof sm.on !== "function") return;

    sm.on("song:ready", () => {
      this.song = readSongInfo();
      this.reclassify();
      this.tally = freshTally();
      this.playAccum = 0;
      this.lastPlayStart = null;
      this.clean = true;
      this.metadataTs = tsNow();   // metadata loaded
      this.startTs = null;         // set on first play
      this.paused = false;
      this.sectionTally = []; this.phraseTally = []; this.best = null;
      this.set({ phase: "loaded" });
      this.captureChart();         // beats/sections/phrases (once per song)
      this.fetchBest();            // previous-best for this arrangement
    });

    // An arrangement change can change the *family* (Lead → Drums), so
    // re-derive the whole instrument block, don't just patch an index.
    sm.on("song:arrangement-changed", (e) => {
      if (!this.song) return;
      const idx = e && e.detail && e.detail.index;
      if (typeof idx === "number") this.song.arrangementIndex = idx;
      const fresh = readSongInfo();
      if (fresh) { this.song.arrangement = fresh.arrangement; this.song.raw = fresh.raw; }
      this.reclassify();
      this.set({});
      this.captureChart();
      this.fetchBest();
    });

    const onStart = () => { if (!this.startTs) this.startTs = tsNow(); this.lastPlayStart = now(); this.set({ phase: "playing" }); };
    sm.on("song:play", onStart);
    sm.on("song:resume", onStart);
    sm.on("song:pause", () => { this.paused = true; this.accumPlay(); this.set({ phase: "paused" }); });
    sm.on("song:seek", () => { this.clean = false; });

    sm.on("song:position-changed", (e) => {
      const d = (e && e.detail) || {};
      this.state.time = d.time;
      this.state.duration = d.duration;
      const t = now();
      if (t - this._lastPosPush > 200) { this._lastPosPush = t; this.publish(); } // ~5 Hz
    });

    sm.on("song:ended", () => this.finalize());
    sm.on("song:stop", () => { this.accumPlay(); this.set({ phase: "idle" }); this.song = null; });
    sm.on("screen:changed", (e) => {
      const id = e && e.detail && e.detail.id;
      if (id && id !== "player" && this.state.phase !== "playing") this.set({ phase: "browsing" });
    });
  };

  // Tally note_detect (or any registered scorer) hit/miss events globally.
  // We only count while a song with a present scorer for its family is active.
  Producer.prototype.bindScorerEvents = function () {
    const inc = (delta) => {
      if (!this.scorerKind || !this.song) return;
      const hit = delta === "hit";
      if (hit) { this.tally.hits++; this.tally.streak++; this.tally.best = Math.max(this.tally.best, this.tally.streak); }
      else { this.tally.misses++; this.tally.streak = 0; }
      // Attribute to the current section + phrase window by playhead time.
      const t = this.state.time || 0, key = hit ? "hits" : "misses";
      const si = windowIndexAt(this.sections, t, true);
      if (si >= 0 && this.sectionTally[si]) this.sectionTally[si][key]++;
      const pi = windowIndexAt(this.phrases, t, false);
      if (pi >= 0 && this.phraseTally[pi]) this.phraseTally[pi][key]++;
    };
    for (const kind of Object.keys(SCORERS)) {
      const s = SCORERS[kind];
      document.addEventListener(s.hitEvent, () => inc("hit"));
      document.addEventListener(s.missEvent, () => inc("miss"));
    }
  };

  Producer.prototype.reclassify = function () {
    const fam = classify(this.families, this.song);
    const desc = familyDesc(this.families, fam);
    this.song.family = fam;
    this.song.instrument = buildInstrumentBlock(fam, desc, this.song);
    // Attach a scorer only if its kind exists AND is installed (soft dep).
    const kind = desc.scorer;
    this.scorerKind = (kind && SCORERS[kind] && SCORERS[kind].present()) ? kind : null;
  };

  // Read the chart's timed structures (beats/sections/phrases) from the highway
  // and POST them once per song to the separate /song channel. They arrive over
  // the highway WS shortly after song:ready, so retry until beats populate (or
  // a short timeout), and only post for the song that's still current.
  Producer.prototype.captureChart = function (attempt) {
    attempt = attempt || 0;
    const song = this.song;
    if (!song) return;
    const hw = window.highway;
    const beats = (hw && hw.getBeats && hw.getBeats()) || [];
    const sections = (hw && hw.getSections && hw.getSections()) || [];
    // Phrases: the existing getPracticePhrases() already returns lean, timed
    // iterations [{index, start_time, end_time, max_difficulty}] — exactly what
    // the per-phrase accuracy ladder needs, so no extra core accessor required.
    const phrases = (hw && hw.getPracticePhrases && hw.getPracticePhrases()) || [];
    const lyrics = (hw && hw.getLyrics && hw.getLyrics()) || [];
    if (beats.length === 0 && attempt < 12) {
      // Not arrived yet — retry ~every 300ms up to ~3.6s.
      setTimeout(() => { if (this.song === song) this.captureChart(attempt + 1); }, 300);
      return;
    }
    post("song", { songId: song.songKey || null, beats: beats, sections: sections,
                   phrases: phrases, lyrics: lyrics });
    // Keep local copies for live ladder attribution + size the tallies to match.
    this.sections = sections;
    this.phrases = phrases;
    this.sectionTally = sections.map(() => ({ hits: 0, misses: 0 }));
    this.phraseTally = phrases.map(() => ({ hits: 0, misses: 0 }));
  };

  // Previous-best for the current arrangement (for the ladder's relative-to-best
  // coloring). Per-arrangement because tuning/notes differ across arrangements.
  Producer.prototype.fetchBest = function () {
    const song = this.song;
    if (!song || !song.songKey) return;
    const q = `tracker?song_id=${encodeURIComponent(song.songKey)}&arrangement=${encodeURIComponent(song.arrangement || "")}`;
    fetch(api(q)).then((r) => r.json())
      .then((b) => { if (this.song === song) this.best = (b && b.accuracy != null) ? b : null; })
      .catch(() => {});
  };

  // Build the live ladder: per-section + per-phrase current accuracy, the
  // derived phrase grade, and the previous-best for relative coloring.
  Producer.prototype.buildLadder = function () {
    const best = this.best || {}, bSec = best.sections || {}, bPhr = best.phrases || {};
    const acc = (t) => { const n = (t.hits + t.misses); return n ? (100 * t.hits / n) : null; };
    const sections = this.sections.map((s, i) => {
      const a = acc(this.sectionTally[i] || { hits: 0, misses: 0 });
      return { name: s.name, accuracy: a, best: bSec[s.name] != null ? bSec[s.name] : null };
    });
    const phrases = this.phrases.map((p, i) => {
      const a = acc(this.phraseTally[i] || { hits: 0, misses: 0 });
      return { index: i, accuracy: a, grade: gradeFromAccuracy(a), best: bPhr[i] != null ? bPhr[i] : null };
    });
    const cur = computeStats(this.tally).accuracy;
    const bOver = best.accuracy != null ? best.accuracy : null;
    return {
      sections, phrases,
      overall: { accuracy: cur, best: bOver,
                 relative: (bOver != null && cur != null) ? Math.round((cur - bOver) * 10) / 10 : null },
    };
  };

  // Persist this run as the new best if it beat the stored one (backend gates).
  Producer.prototype.postBest = function () {
    if (!this.scorerKind || !this.song || !this.song.songKey) return;
    const ladder = this.buildLadder();
    const sections = {}, phrases = {};
    ladder.sections.forEach((s) => { if (s.accuracy != null) sections[s.name] = Math.round(s.accuracy * 10) / 10; });
    ladder.phrases.forEach((p) => { if (p.accuracy != null) phrases[p.index] = Math.round(p.accuracy * 10) / 10; });
    post("tracker", { song_id: this.song.songKey, arrangement: this.song.arrangement || "",
                      accuracy: ladder.overall.accuracy, sections, phrases });
  };

  Producer.prototype.accumPlay = function () {
    if (this.lastPlayStart != null) { this.playAccum += (now() - this.lastPlayStart) / 1000; this.lastPlayStart = null; }
  };

  Producer.prototype.set = function (patch) {
    Object.assign(this.state, patch);
    if (this.song) {
      this.state.songId = this.song.songKey;
      this.state.title = this.song.title;
      this.state.artist = this.song.artist;
      this.state.arrangement = this.song.arrangement;
      this.state.arrangementIndex = this.song.arrangementIndex;
      this.state.instrument = this.song.instrument; // namespaced, family-discriminated
    }
    this.state.scored = !!this.scorerKind;
    if (this.scorerKind) {
      this.state.stats = computeStats(this.tally);
      this.state.totalNotes = arrangementNoteCount(this.song);
      this.state.ladder = this.buildLadder();   // per-section/phrase + best
    } else {
      this.state.ladder = null;
    }
    this.publish();
  };

  Producer.prototype.publish = function () {
    this.state.v = 1;
    post("state", this.state);
    renderDashboard(this); // keep the in-app dashboard live too
  };

  Producer.prototype.finalize = function () {
    this.accumPlay();
    const song = this.song || {};
    const dur = this.state.duration || song.duration || 0;
    const completed = dur ? (this.state.time || 0) / dur > 0.95 : false;
    const stats = this.scorerKind ? computeStats(this.tally) : null;
    // RockSniffer-parity record (column names map 1:1 to playthrough_history).
    // arrangement_path uses the Slopsmith arrangement name, which already is the
    // Lead/Rhythm/Bass/Drums/… "path" RockSniffer stored. capo lets the backend
    // build the "<tuning> (Capo Fret N)" string from the meta DB's tuning_name.
    const rec = {
      timestamp: this.metadataTs,
      timestamp_start: this.startTs || this.metadataTs,
      timestamp_end: tsNow(),
      song_id: song.songKey || "",
      song_name: song.title || "",
      artist_name: song.artist || "",
      song_length: dur || null,
      arrangement_id: song.arrangementIndex != null ? song.arrangementIndex : "",
      arrangement_path: song.arrangement || (song.instrument && song.instrument.label) || "",
      capo: (song.instrument && song.instrument.capo) || 0,
      game_mode: "LEARNASONG",          // Slopsmith free-play ≈ RockSniffer LaS
      author: "",                        // not in Slopsmith meta; blank like RS LaS
      total_notes: arrangementNoteCount(song),
      notes_hit: stats ? this.tally.hits : null,
      notes_missed: stats ? this.tally.misses : null,
      highest_hit_streak: stats ? this.tally.best : null,
      accuracy: stats ? stats.accuracy : null,
      completed: completed,
      paused: this.paused,
    };
    post("playthrough", rec);
    this.postBest();              // update previous-best if this run beat it
    this.set({ phase: "results" });
  };

  // Active arrangement's authored note count, from song_info.arrangements[].
  function arrangementNoteCount(song) {
    try {
      const arrs = song.raw && (song.raw.arrangements || song.raw.arrangement_list);
      const idx = song.arrangementIndex || 0;
      if (arrs && arrs[idx] && arrs[idx].notes != null) return arrs[idx].notes;
    } catch (e) {}
    return null;
  }

  // ── Instrument classification + block, driven by the fetched table ─────────
  function classify(table, song) {
    if (!song) return (table && table.default) || "unknown";
    const fams = (table && table.families) || {};
    if (song.hasDrumTab) {
      for (const k in fams) if (fams[k].match_drum_tab) return k;
    }
    const name = (song.arrangement || "").toLowerCase();
    // Drums-by-name first, then the rest, mirroring instruments.py precedence.
    const order = ["drums", "bass", "keys", "vocals", "guitar"];
    for (const k of order) {
      if (!fams[k]) continue;
      for (const kw of (fams[k].match_names || [])) if (name.includes(kw)) return k;
    }
    // Any family not in the explicit order (future additions) still gets a shot.
    for (const k in fams) {
      if (order.includes(k)) continue;
      for (const kw of (fams[k].match_names || [])) if (name.includes(kw)) return k;
    }
    return (table && table.default) || "unknown";
  }

  function familyDesc(table, fam) {
    const fams = (table && table.families) || {};
    return fams[fam] || { label: "", fields: {}, scorer: null, accuracy_unit: null };
  }

  // Only copy present-and-true fields, so a drum block never carries tuning/capo.
  function buildInstrumentBlock(fam, desc, song) {
    const f = desc.fields || {};
    const b = { family: fam, label: desc.label || "" };
    if (f.tuning && song.tuning != null) b.tuning = song.tuning;
    if (f.string_count && song.stringCount != null) b.stringCount = song.stringCount;
    if (f.capo && song.capo != null) b.capo = song.capo;
    if (f.kit && song.kit != null) b.kit = song.kit; // drum kit arrives on the drum_tab WS msg (later milestone)
    if (f.reference_pitch && song.centOffset != null) b.centOffset = song.centOffset;
    return b;
  }

  // ── song_info reader (ASSUMPTION: getSongInfo() shape) ─────────────────────
  function readSongInfo() {
    let info = {};
    try { info = (window.highway && window.highway.getSongInfo && window.highway.getSongInfo()) || {}; } catch (e) { info = {}; }
    const pick = (...keys) => { for (const k of keys) if (info[k] != null) return info[k]; return null; };
    return {
      title: pick("title"),
      artist: pick("artist"),
      duration: pick("duration", "song_length", "songLength"),
      arrangement: pick("arrangement", "arrangement_name", "arrangementName"),
      arrangementIndex: pick("arrangement_index", "arrangementIndex"),
      tuning: pick("tuning"),
      stringCount: pick("stringCount", "string_count"),
      capo: pick("capo"),
      centOffset: pick("centOffset", "cent_offset"),
      hasDrumTab: !!pick("has_drum_tab", "hasDrumTab"),
      songKey: pick("filename", "song_key", "songKey"),
      raw: info,
    };
  }

  // ── Stats from the tally ───────────────────────────────────────────────────
  function freshTally() { return { hits: 0, misses: 0, streak: 0, best: 0 }; }
  function computeStats(t) {
    const total = t.hits + t.misses;
    return { hits: t.hits, misses: t.misses, streak: t.streak, bestStreak: t.best,
             accuracy: total ? +(100 * t.hits / total).toFixed(1) : null };
  }

  // Index of the section/phrase window containing time `t`.
  //  - sections (startOnly=true): list of {name, time}; window i = [time_i, time_{i+1})
  //  - phrases  (startOnly=false): list of {start_time, end_time}; t in [start, end)
  function windowIndexAt(list, t, startOnly) {
    if (!list || !list.length) return -1;
    if (startOnly) {
      let idx = -1;
      for (let i = 0; i < list.length; i++) { if ((list[i].time || 0) <= t) idx = i; else break; }
      return idx;
    }
    for (let i = 0; i < list.length; i++) {
      const s = list[i].start_time != null ? list[i].start_time : 0;
      const e = list[i].end_time != null ? list[i].end_time : Infinity;
      if (t >= s && t < e) return i;
    }
    return -1;
  }

  // Derive a RockSniffer-style phrase grade from accuracy. Slopsmith has no
  // engine phrase grading, so these thresholds are stream_kit's own rubric.
  function gradeFromAccuracy(a) {
    if (a == null) return null;
    if (a >= 100) return "Perfect";
    if (a >= 90) return "Good";
    if (a >= 50) return "Passed";
    return "Failed";
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function now() { return performance.now(); }
  function round1(n) { return Math.round(n * 10) / 10; }
  // RockSniffer's timestamp format: "yyyy-MM-dd HH:mm:ss" in local time.
  function tsNow() {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
           `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function clientId() {
    let id = null;
    try { id = localStorage.getItem("streamkit_client"); if (!id) { id = "c-" + Math.random().toString(36).slice(2, 10); localStorage.setItem("streamkit_client", id); } } catch (e) { id = "c-anon"; }
    return id;
  }
  function post(path, body) {
    try { fetch(api(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }); } catch (e) {}
  }

  // ── In-app dashboard (rendered into #plugin-stream_kit) ────────────────────
  function bindDashboard(producer) {
    renderDashboard(producer);
    // Light periodic refresh of the history table while the screen is visible.
    if (!window.__streamKitDashTimer) {
      window.__streamKitDashTimer = setInterval(() => {
        const root = document.getElementById("plugin-stream_kit");
        if (root && root.offsetParent !== null) refreshHistory(root);
      }, 5000);
    }
  }

  function renderDashboard(producer) {
    const root = document.getElementById("plugin-stream_kit");
    if (!root) return;
    const live = root.querySelector("[data-sk-live]");
    if (live) {
      const s = producer.state;
      const inst = s.instrument || {};
      live.innerHTML =
        `<div class="sk-kv"><span>Phase</span><b>${esc(s.phase || "idle")}</b></div>` +
        `<div class="sk-kv"><span>Song</span><b>${esc(s.title || "—")}${s.artist ? " — " + esc(s.artist) : ""}</b></div>` +
        `<div class="sk-kv"><span>Instrument</span><b>${esc(inst.label || inst.family || "—")}${formatInstrumentDetail(inst)}</b></div>` +
        `<div class="sk-kv"><span>Scored</span><b>${s.scored ? "yes" : "no (no detector for this instrument)"}</b></div>` +
        (s.stats ? `<div class="sk-kv"><span>Accuracy</span><b>${s.stats.accuracy != null ? s.stats.accuracy + "%" : "—"} · streak ${s.stats.streak} (best ${s.stats.bestStreak})</b></div>` : "");
    }
    const root2 = document.getElementById("plugin-stream_kit");
    if (root2 && !root2.dataset.skHist) { root2.dataset.skHist = "1"; refreshHistory(root2); }
    if (root2 && !root2.dataset.skVer) {
      root2.dataset.skVer = "1";
      const v = root2.querySelector("[data-sk-version]");
      if (v) fetch(api("version")).then(r => r.json())
        .then(d => { v.textContent = "stream_kit v" + (d.version || "?"); })
        .catch(() => { v.textContent = "stream_kit (version unknown)"; });
    }
  }

  function refreshHistory(root) {
    const tbody = root.querySelector("[data-sk-history]");
    if (!tbody) return;
    fetch(api("history?limit=25")).then(r => r.json()).then(rows => {
      tbody.innerHTML = rows.map(r =>
        `<tr><td>${esc(r.song_name || "—")}</td><td>${esc(r.artist_name || "")}</td>` +
        `<td>${esc(r.arrangement_path || "")}</td>` +
        `<td>${r.accuracy != null ? r.accuracy + "%" : "—"}</td>` +
        `<td>${r.completed ? "✓" : "·"}${r.paused ? " (paused)" : ""}</td></tr>`
      ).join("") || `<tr><td colspan="5" class="sk-empty">No playthroughs yet.</td></tr>`;
    }).catch(() => {});
  }

  function formatInstrumentDetail(inst) {
    const bits = [];
    if (inst.tuning) bits.push(Array.isArray(inst.tuning) ? "tuning " + inst.tuning.join(",") : String(inst.tuning));
    if (inst.stringCount != null) bits.push(inst.stringCount + "-string");
    if (inst.capo) bits.push("capo " + inst.capo);
    if (inst.centOffset) bits.push(fmtCents(inst.centOffset));
    if (inst.kit) bits.push("kit");
    return bits.length ? ` <span class="sk-dim">· ${esc(bits.join(" · "))}</span>` : "";
  }

  // Reference-pitch hint. centOffset is cents from A440 (0 = standard, omitted).
  function fmtCents(c) {
    if (!c) return "";
    const sign = c > 0 ? "+" : "\u2212"; // − for negative
    const hz = (440 * Math.pow(2, c / 1200)).toFixed(1);
    return `${sign}${Math.abs(c).toFixed(1)}\u00A2 (A${hz})`;
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
})();
