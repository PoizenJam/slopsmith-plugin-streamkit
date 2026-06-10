/* current-song (minimal) — faithful port of RockSniffer's current_song behavior,
 * rewired from the sniffer poller to stream_kit's SSE feed. Vanilla JS.
 *
 * Original config flags preserved so the look matches and stays tweakable. */
(function () {
  "use strict";

  // ── Config (same knobs as the original addon) ───────────────────────────
  const SHOW_ACCURACY = true;     // show the accuracy % in the header
  const SHOW_PROGRESS = true;     // show the bottom progress bar
  const ANIMATE = true;           // tween the accuracy number
  const ANIMATE_COLOR = true;     // lerp the accuracy color red→yellow→green
  const COLOR_0 = "#FF0000", COLOR_50 = "#FFFF00", COLOR_100 = "#00FF00";
  const COLOR_MIDPOINT = 0.8;     // where the 50% color sits in the gradient
  const COLOR_EXPONENT = 2;       // steepness toward 100%

  const $ = (id) => document.getElementById(id);
  const popup = $("popup");
  if (!SHOW_ACCURACY) $("accuracy").style.display = "none";
  if (!SHOW_PROGRESS) document.querySelector(".progress_bar").style.display = "none";

  let visible = false, lastArt = null, prevAcc = 0, animRAF = null;

  function strokeText(el, text) {
    el.textContent = text;
    el.classList.add("stroke");
    el.setAttribute("data-stroke", text);
  }

  function durationString(t) {
    t = Math.max(0, Math.floor(t || 0));
    const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return hh > 0 ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
  }

  // ── Accuracy color lerp (ported verbatim from the original) ──────────────
  function lerpColor(a, b, amount) {
    amount = Math.min(1, Math.max(0, amount));
    const ah = parseInt(a.replace(/#/g, ""), 16), ar = ah >> 16, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
    const bh = parseInt(b.replace(/#/g, ""), 16), br = bh >> 16, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
    const rr = ar + amount * (br - ar), rg = ag + amount * (bg - ag), rb = ab + amount * (bb - ab);
    return "#" + ((1 << 24) + (rr << 16) + (rg << 8) + rb | 0).toString(16).slice(1);
  }
  function lerpColors(p) {
    p = Math.pow(p, COLOR_EXPONENT);
    return p <= COLOR_MIDPOINT
      ? lerpColor(COLOR_0, COLOR_50, p / COLOR_MIDPOINT)
      : lerpColor(COLOR_50, COLOR_100, (p - COLOR_MIDPOINT) / (1 - COLOR_MIDPOINT));
  }

  function setAccuracy(acc) {
    const el = $("accuracy");
    if (!ANIMATE) {
      strokeText(el, acc.toFixed(2) + "%");
      if (ANIMATE_COLOR) el.style.color = lerpColors(acc / 100);
      prevAcc = acc;
      return;
    }
    // Lightweight rAF tween from prevAcc → acc (replaces jQuery.animateNumber).
    if (animRAF) cancelAnimationFrame(animRAF);
    const from = prevAcc, to = acc, t0 = performance.now(), dur = 800;
    function step(now) {
      const k = Math.min(1, (now - t0) / dur), v = from + (to - from) * k;
      strokeText(el, v.toFixed(2) + "%");
      if (ANIMATE_COLOR) el.style.color = lerpColors(v / 100);
      if (k < 1) animRAF = requestAnimationFrame(step);
    }
    animRAF = requestAnimationFrame(step);
    prevAcc = acc;
  }

  function show() { if (!visible) { popup.classList.add("show"); visible = true; } }
  function hide() { if (visible) { popup.classList.remove("show"); visible = false; prevAcc = 0; } }

  SK.onState(function (s) {
    // "Playing a song" ≈ RockSniffer's songTimer > 1.
    if (!SK.songActive(s) || !(s.time > 1 || s.phase === "playing" || s.phase === "loaded")) {
      hide();
      return;
    }
    strokeText($("artist"), s.artist || "");
    strokeText($("song"), s.title || "");
    const yr = s.year ? " (" + s.year + ")" : "";
    strokeText($("albumname"), (s.album || "") + yr);

    if (SHOW_ACCURACY) {
      if (s.scored && s.stats && s.stats.accuracy != null) {
        $("accuracy").style.display = "";
        setAccuracy(s.stats.accuracy);
      } else {
        $("accuracy").style.display = "none";
      }
    }

    if (SHOW_PROGRESS && s.duration) {
      $("progress_fill").style.width = (100 * (s.time || 0) / s.duration) + "%";
      strokeText($("progress_text"), durationString(s.time) + "/" + durationString(s.duration));
    }

    if (s.songId && s.songId !== lastArt) {
      lastArt = s.songId;
      const u = SK.artUrl(s.songId);
      const img = $("album");
      if (u) { img.src = u; img.style.visibility = "visible"; }
      img.onerror = function () { img.style.visibility = "hidden"; };
    }
    show();
  });
})();
