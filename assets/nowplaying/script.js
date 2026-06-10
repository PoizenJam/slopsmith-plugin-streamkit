/* now-playing overlay renderer — built on SK (sk-overlay-core.js). */
(function () {
  "use strict";
  const el = (id) => document.getElementById(id);
  const set = (id, t) => { const n = el(id); if (n) n.textContent = t; };

  SK.onState(function render(s) {
    const wrap = el("sk-nowplaying");
    if (!wrap) return;
    const show = SK.songActive(s);
    wrap.classList.toggle("sk-hidden", !show);
    if (!show) return;

    set("sk-title", s.title || "");
    set("sk-artist", s.artist || "");
    set("sk-arrangement", s.arrangement || (s.instrument && s.instrument.label) || "");
    set("sk-instrument-detail", SK.instrumentDetail(s.instrument));

    const statsEl = el("sk-stats");
    if (statsEl) {
      if (s.scored && s.stats) {
        statsEl.classList.remove("sk-hidden");
        set("sk-accuracy", s.stats.accuracy != null ? s.stats.accuracy + "%" : "\u2014");
        set("sk-streak", "streak " + (s.stats.streak || 0));
      } else {
        statsEl.classList.add("sk-hidden");
      }
    }

    const bar = el("sk-progress-fill");
    if (bar && s.duration) {
      bar.style.width = Math.max(0, Math.min(100, 100 * (s.time || 0) / s.duration)) + "%";
    }
    set("sk-phase", s.phase === "paused" ? "Paused" : "");
  });
})();
