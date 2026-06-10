/* current-song-basic (v2) — faithful port of RockSniffer current_song_v2.
 * Section segments color green/red by accuracy-vs-previous-best (from
 * state.ladder), the timestamp row shows live accuracy, and the results screen
 * shows the better/worse-than-best line + cycling feedback. Vanilla JS. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const popup = $("popup"), bar = $("bar"), fill = $("fill");
  let sections = [], loadedSong = null, builtFor = null;
  let feedback = [], feedIdx = 0, feedTimer = null, lastResults = false;

  function fmtTimer(t) {
    if (t == null || t < 0) return "";
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return [m, s].map((x) => ("0" + x).slice(-2)).join(":");
  }
  function loadSections() {
    SK.fetchSong().then((c) => { sections = (c && c.sections) || []; builtFor = null; });
  }
  // ladder.sections[i] aligns with /song sections[i] (both from the arrangement).
  function ladderSection(s, i) {
    const L = s.ladder && s.ladder.sections;
    return (L && L[i]) || null;
  }

  function buildBar(dur) {
    Array.prototype.slice.call(bar.querySelectorAll(".timerBarSection")).forEach((n) => n.remove());
    if (!dur || !sections.length) { builtFor = dur; return; }
    for (let i = 0; i < sections.length; i++) {
      const start = i === 0 ? 0 : (sections[i].time || 0);
      const end = (i + 1 < sections.length) ? (sections[i + 1].time || dur) : dur;
      const seg = document.createElement("div");
      seg.className = "timerBarSection transparent";
      seg.dataset.idx = i; seg.dataset.end = end;
      seg.style.left = (100 * start / dur) + "%";
      seg.style.width = (100 * Math.max(0, end - start) / dur) + "%";
      bar.insertBefore(seg, fill);
    }
    builtFor = dur;
  }

  // Green when this run beats the previous best in the section, red when worse;
  // only on sections already played (data present) and only if a best exists.
  function colorSections(s, t) {
    Array.prototype.slice.call(bar.querySelectorAll(".timerBarSection")).forEach((seg) => {
      const i = parseInt(seg.dataset.idx, 10), ls = ladderSection(s, i);
      seg.classList.remove("green");
      if (parseFloat(seg.dataset.end) <= t && ls && ls.best != null && ls.accuracy != null) {
        seg.classList.remove("transparent");
        seg.classList.toggle("green", ls.accuracy >= ls.best);
      } else {
        seg.classList.add("transparent");
      }
    });
  }

  function buildFeedback(s) {
    const L = (s.ladder && s.ladder.sections) || [];
    const fb = []; let greens = 0;
    L.forEach((sec) => {
      if (sec.best == null || sec.accuracy == null) return;
      const rel = sec.accuracy - sec.best;
      if (rel >= 0) greens++;
      if (rel >= 1) fb.push("got " + rel.toFixed(2) + "% better accuracy in " + sec.name);
    });
    if (greens > 0) fb.push(greens + " green sections");
    fb.sort(() => Math.random() - 0.5);
    if (s.ladder && s.ladder.overall && s.ladder.overall.accuracy === 100) fb.push("hit all the notes");
    if (fb.length === 0) fb.push("you tried!");
    return fb;
  }
  function startFeedbackCycle() {
    if (feedTimer) return;
    const tick = () => { feedIdx = (feedIdx + 1) % Math.max(1, feedback.length); $("feedMsg").textContent = feedback[feedIdx] || ""; feedTimer = setTimeout(tick, 5000); };
    feedTimer = setTimeout(tick, 5000);
  }
  function stopFeedbackCycle() { if (feedTimer) { clearTimeout(feedTimer); feedTimer = null; } }

  SK.onState(function (s) {
    if (s.songId !== loadedSong) { loadedSong = s.songId; loadSections(); }
    const results = s.phase === "results", active = SK.songActive(s);
    if (!active && !results) { popup.classList.remove("show"); stopFeedbackCycle(); lastResults = false; return; }
    popup.classList.add("show");

    if (results) {
      $("mode0").style.display = "none";
      $("mode1").style.display = "";
      $("pSong").textContent = s.title || "";
      $("pArtist").textContent = s.artist || "";
      const acc = s.ladder && s.ladder.overall && s.ladder.overall.accuracy;
      $("pAcc").textContent = (acc != null ? acc.toFixed(2) : "0.00") + "% (" + (s.arrangement || "") + ")";

      // prev section markers (white boundaries)
      const pBar = $("pBar");
      if (pBar.dataset.song !== s.songId) {
        pBar.dataset.song = s.songId; pBar.innerHTML = "";
        const dur = s.duration || 0;
        sections.forEach((sec, i) => {
          const start = i === 0 ? 0 : (sec.time || 0);
          const end = (i + 1 < sections.length) ? (sections[i + 1].time || dur) : dur;
          if (!dur) return;
          const d = document.createElement("div");
          d.className = "section";
          d.style.left = (100 * start / dur) + "%";
          d.style.width = (100 * Math.max(0, end - start) / dur) + "%";
          d.style.backgroundColor = "white"; d.style.opacity = "0.5";
          pBar.appendChild(d);
        });
      }

      const ov = s.ladder && s.ladder.overall;
      if (ov && ov.relative != null) {
        $("bestWrap").style.display = "";
        $("bestLine").textContent = Math.abs(ov.relative).toFixed(2) + "% " + (ov.relative >= 0 ? "better" : "worse") + " than previous best";
        $("feedPrefix").textContent = ov.relative >= 0 ? "also" : "...but";
        if (!lastResults) { feedback = buildFeedback(s); feedIdx = 0; $("feedMsg").textContent = feedback[0] || ""; startFeedbackCycle(); }
      } else {
        $("bestWrap").style.display = "none";
        stopFeedbackCycle();
      }
      lastResults = true;
      return;
    }

    lastResults = false; stopFeedbackCycle();
    $("mode1").style.display = "none";
    $("mode0").style.display = "";
    $("song").textContent = s.title || "";
    $("artist").textContent = s.artist || "";

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
    colorSections(s, t);
    if (dur) fill.style.width = Math.max(0, Math.min(100, 100 * t / dur)) + "%";
    $("cur").textContent = fmtTimer(t);
    $("tot").textContent = fmtTimer(dur);
    const a = s.scored && s.stats && s.stats.accuracy != null ? s.stats.accuracy : null;
    $("acc").textContent = a != null ? a.toFixed(2) + "%" : "";
  });
})();
