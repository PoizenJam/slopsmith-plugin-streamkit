/* current-song-8bit (Arcade) — faithful port of PoizenJam's Arcade_v1_LaS.
 * Same layered ladder bar as the advanced overlay (shared SK.renderLadderBar),
 * with the pixel-font scoreboard HIT/STR displays (zero-padded, arcade-style). */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const popup = $("popup"), bar = $("bar"), marquee = $("marquee"), info = marquee.parentNode;
  let chart = { phrases: [], sections: [] }, loadedSong = null;
  let feedback = [], feedIdx = 0, feedTimer = null, wasResults = false, marqTimer = null;

  const pad4 = (v) => ("0000" + v).slice(-4);   // arcade-style 4-wide field
  function fmtTimer(t) {
    if (t == null || t < 0) return "";
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return [m, s].map((x) => ("0" + x).slice(-2)).join(":");
  }
  function tuningOf(s) { return s.tuningName || (s.instrument && SK.tuningLabel(s.instrument.tuning)) || ""; }

  function loadChart() { SK.fetchSong().then((c) => { chart = { phrases: (c && c.phrases) || [], sections: (c && c.sections) || [] }; bar._sig = null; }); }
  function setupMarquee() {
    if (marqTimer) { clearInterval(marqTimer); marqTimer = null; }
    marquee.style.transform = "translateX(0)";
    setTimeout(() => {
      const over = marquee.scrollWidth - info.clientWidth;
      if (over > 4) { let out = false; marqTimer = setInterval(() => { out = !out; marquee.style.transform = out ? "translateX(-" + over + "px)" : "translateX(0)"; }, 4000); }
    }, 200);
  }

  function buildFeedback(s) {
    const L = (s.ladder && s.ladder.sections) || [];
    const fb = []; let greens = 0;
    L.forEach((sec) => { if (sec.best == null || sec.accuracy == null) return; const rel = sec.accuracy - sec.best; if (rel >= 0) greens++; if (rel >= 1) fb.push("GOT " + rel.toFixed(1) + "% BETTER IN " + (sec.name || "").toUpperCase()); });
    if (greens > 0) fb.push(greens + " GREEN SECTIONS");
    fb.sort(() => Math.random() - 0.5);
    if (s.ladder && s.ladder.overall && s.ladder.overall.accuracy === 100) fb.push("HIT ALL THE NOTES");
    if (fb.length === 0) fb.push("YOU TRIED!");
    return fb;
  }
  function startFeed() { if (feedTimer) return; const tick = () => { feedIdx = (feedIdx + 1) % Math.max(1, feedback.length); $("feedMsg").textContent = feedback[feedIdx] || ""; feedTimer = setTimeout(tick, 5000); }; feedTimer = setTimeout(tick, 5000); }
  function stopFeed() { if (feedTimer) { clearTimeout(feedTimer); feedTimer = null; } }

  SK.onState(function (s) {
    if (s.songId !== loadedSong) { loadedSong = s.songId; loadChart(); }
    const results = s.phase === "results", active = SK.songActive(s);
    if (!active && !results) { popup.classList.remove("show"); stopFeed(); wasResults = false; return; }
    popup.classList.add("show");

    if (marquee.dataset.song !== s.songId) {
      marquee.dataset.song = s.songId;
      $("artist").textContent = (s.artist || "").toUpperCase();
      $("song").textContent = (s.title || "").toUpperCase();
      setupMarquee();
      const art = $("art"), u = SK.artUrl(s.songId);
      if (u) { art.src = u; art.classList.remove("hide"); }
      art.onerror = () => art.classList.add("hide");
    }
    $("tuning").textContent = tuningOf(s);

    const st = s.stats || {}, total = s.totalNotes != null ? s.totalNotes : (st.hits + st.misses);
    const acc = (s.ladder && s.ladder.overall && s.ladder.overall.accuracy != null) ? s.ladder.overall.accuracy : st.accuracy;
    const playing = s.time > 1 || results;
    // Arcade scoreboard: acc% hits/total  ·  cur/max streak (zero-padded).
    if (playing) {
      $("hit").textContent = pad4(acc != null ? acc.toFixed(1) : "0.0") + "% " + pad4(st.hits || 0) + "/" + pad4(total || 0);
      $("str").textContent = pad4(st.streak || 0) + "/" + pad4(st.bestStreak || 0);
    } else {
      $("hit").textContent = pad4("0.0") + "% " + pad4(0) + "/" + pad4(0);
      $("str").textContent = pad4(0) + "/" + pad4(0);
    }

    if (results) {
      const ov = s.ladder && s.ladder.overall;
      if (ov && ov.relative != null) {
        $("resultWrap").style.display = "";
        $("bestLine").textContent = Math.abs(ov.relative).toFixed(1) + "% " + (ov.relative >= 0 ? "BETTER" : "WORSE") + " THAN BEST";
        $("feedPrefix").textContent = ov.relative >= 0 ? "ALSO..." : "... BUT";
        if (!wasResults) { feedback = buildFeedback(s); feedIdx = 0; $("feedMsg").textContent = feedback[0] || ""; startFeed(); }
      } else { $("resultWrap").style.display = "none"; stopFeed(); }
      wasResults = true;
    } else {
      wasResults = false; stopFeed(); $("resultWrap").style.display = "none";
    }

    SK.renderLadderBar(bar, {
      phrases: chart.phrases, sections: chart.sections,
      lp: s.ladder && s.ladder.phrases, ls: s.ladder && s.ladder.sections,
      time: s.time || 0, duration: s.duration || 0,
    });
    $("cur").textContent = fmtTimer(s.time);
    $("tot").textContent = fmtTimer(s.duration);
  });
})();
