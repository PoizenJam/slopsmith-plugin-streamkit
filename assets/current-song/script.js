/* current-song (v4 default) — faithful port of RockSniffer current_song_v4,
 * rewired to the stream_kit SSE feed + /song chart channel. Vanilla JS.
 *
 * Mode 0 (playing): song / artist / album art / arrangement+tuning, a timer
 * bar with section-boundary segments (passed ones go transparent so the
 * progress fill shows through) + current/total timestamps.
 * Mode 1 (results): the just-played song recap, held until the next song loads. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const popup = $("popup"), bar = $("bar"), fill = $("fill");
  let sections = [], loadedSong = null, builtFor = null;

  function fmtTimer(t) {
    if (t == null || t < 0) return "";
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return [m, s].map((x) => ("0" + x).slice(-2)).join(":");
  }
  function tuningOf(s) { return s.tuningName || (s.instrument && SK.tuningLabel(s.instrument.tuning)) || ""; }

  function loadSections() {
    SK.fetchSong().then((c) => { sections = (c && c.sections) || []; builtFor = null; });
  }
  // Build the section-boundary segments across 0..duration.
  function buildBar(dur) {
    Array.prototype.slice.call(bar.querySelectorAll(".timerBarSection")).forEach((n) => n.remove());
    if (!dur || !sections.length) { builtFor = dur; return; }
    for (let i = 0; i < sections.length; i++) {
      const start = i === 0 ? 0 : (sections[i].time || 0);
      const end = (i + 1 < sections.length) ? (sections[i + 1].time || dur) : dur;
      const seg = document.createElement("div");
      seg.className = "timerBarSection";
      seg.dataset.end = end;
      seg.style.left = (100 * start / dur) + "%";
      seg.style.width = (100 * Math.max(0, end - start) / dur) + "%";
      bar.insertBefore(seg, fill);
    }
    builtFor = dur;
  }

  SK.onState(function (s) {
    if (s.songId !== loadedSong) { loadedSong = s.songId; loadSections(); }

    const results = s.phase === "results";
    const active = SK.songActive(s);
    if (!active && !results) { popup.classList.remove("show"); return; }
    popup.classList.add("show");

    if (results) {
      $("mode0").style.display = "none";
      $("mode1").style.display = "";
      $("pSong").textContent = s.title || "";
      $("pArtist").textContent = s.artist || "";
      $("pArr").textContent = s.arrangement || "";
      $("pTuning").textContent = tuningOf(s);
      return;
    }

    $("mode1").style.display = "none";
    $("mode0").style.display = "";
    $("song").textContent = s.title || "";
    $("artist").textContent = s.artist || "";
    $("arrType").textContent = s.arrangement || "";
    $("tuning").textContent = tuningOf(s);

    if (s.songId) {
      const art = $("art"), u = SK.artUrl(s.songId);
      if (art.dataset.song !== s.songId) {
        art.dataset.song = s.songId;
        if (u) { art.src = u; art.classList.remove("hide"); }
        art.onerror = () => art.classList.add("hide");
      }
    }

    const dur = s.duration || 0, t = s.time || 0;
    if (builtFor !== dur) buildBar(dur);
    if (dur) fill.style.width = Math.max(0, Math.min(100, 100 * t / dur)) + "%";
    // Passed sections go transparent (so the progress fill is the only fill there).
    Array.prototype.slice.call(bar.querySelectorAll(".timerBarSection")).forEach((seg) => {
      seg.classList.toggle("passed", parseFloat(seg.dataset.end) <= t);
    });
    $("cur").textContent = fmtTimer(t);
    $("tot").textContent = fmtTimer(dur);
  });
})();
