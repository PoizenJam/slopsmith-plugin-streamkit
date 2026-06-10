(function () {
    "use strict";
    // Tunables mirror RockSniffer's vocals addon defaults.
    var LAT = 0.3, PRE = 2, LINES = 2, MAXNOTE = 2.5, ANIM = 0.5, GAP = 1.2;
    var container = document.getElementById("sk-vocal");
    container.style.height = "calc(" + LINES + " * 1.2em)";

    var vocals = [];        // [{Time, Length, Lyric}]
    var lineStruct = [];    // [{idx:[..], startTime, endTime}]
    var displayed = {};     // lineIdx -> {el, slot, timer}
    var loadedSong = null;

    function clearAll() {
      for (var k in displayed) {
        if (displayed[k].timer) clearTimeout(displayed[k].timer);
        if (displayed[k].el && displayed[k].el.parentNode) displayed[k].el.remove();
      }
      displayed = {};
    }

    function loadLyrics(songId) {
      clearAll(); lineStruct = []; vocals = [];
      SK.fetchSong().then(function (c) {
        var raw = (c && c.lyrics) || [];
        // Normalize {t,d,w} -> RockSniffer-shaped {Time,Length,Lyric}.
        vocals = raw.map(function (v) {
          return { Time: v.t != null ? v.t : v.Time,
                   Length: v.d != null ? v.d : v.Length,
                   Lyric: v.w != null ? v.w : (v.Lyric || "") };
        });
        lineStruct = buildLines(vocals);
      });
    }

    // Primary: break on a '+' suffix (Rocksmith convention). Fallback: if no
    // '+' markers exist (a chart that strips them), break on time gaps.
    function buildLines(vs) {
      if (!vs.length) return [];
      var hasPlus = vs.some(function (v) { return /\+$/.test(v.Lyric); });
      var lines = [], cur = { idx: [], startTime: 0, endTime: 0 }, starting = true, prevEnd = 0;
      for (var i = 0; i < vs.length; i++) {
        var v = vs[i], len = Math.min(v.Length || 0, MAXNOTE);
        var gapBreak = !hasPlus && !starting && (v.Time - prevEnd > GAP);
        if (gapBreak) { lines.push(cur); cur = { idx: [], startTime: 0, endTime: 0 }; starting = true; }
        if (starting) { cur.startTime = v.Time; starting = false; }
        cur.endTime = Math.max(cur.endTime, v.Time + len);
        cur.idx.push(i);
        prevEnd = v.Time + len;
        if (hasPlus && /\+$/.test(v.Lyric)) {
          lines.push(cur); cur = { idx: [], startTime: 0, endTime: 0 }; starting = true;
        }
      }
      if (cur.idx.length) lines.push(cur);
      return lines;
    }

    function stripMark(lyric) {
      return /[+\-]$/.test(lyric) ? lyric.slice(0, -1) : lyric;
    }
    function setSlot(el, slot) {
      var y;
      if (slot === "incoming") y = LINES * 100;
      else if (slot === "active") y = 0;
      else if (slot === "outgoing") y = -100;
      else if (slot === "preview") y = 100;
      else if (slot.indexOf("preview") === 0) y = parseInt(slot.slice(7), 10) * 100;
      else y = 0;
      el.style.transform = "translateY(" + y + "%)";
    }

    function createLine(lineIdx, slot) {
      var ld = lineStruct[lineIdx];
      var div = document.createElement("div");
      div.className = "lyric-line";
      div.style.transition = "transform " + ANIM + "s ease";
      div.style.transform = "translateY(" + (LINES * 100) + "%)";
      for (var k = 0; k < ld.idx.length; k++) {
        var sylIdx = ld.idx[k], v = vocals[sylIdx], lyric = v.Lyric || "";
        var noSpace = /\-$/.test(lyric), brk = /\+$/.test(lyric);
        var span = document.createElement("span");
        span.className = "syllable syllable-future";
        span.setAttribute("data-syl", sylIdx);
        span.textContent = stripMark(lyric);
        div.appendChild(span);
        if (!noSpace && !brk) div.appendChild(document.createTextNode(" "));
      }
      container.appendChild(div);
      displayed[lineIdx] = { el: div, slot: "incoming", timer: null };
      void div.offsetHeight; // reflow so the slide transition fires
      requestAnimationFrame(function () {
        var st = displayed[lineIdx];
        if (st && st.slot === "incoming") { setSlot(st.el, slot); st.slot = slot; }
      });
    }

    function scheduleRemoval(lineIdx) {
      var st = displayed[lineIdx];
      st.timer = setTimeout(function () {
        var s = displayed[lineIdx];
        if (s && s.slot === "outgoing") { s.el.remove(); delete displayed[lineIdx]; }
      }, ANIM * 1000 + 100);
    }

    function updateSyllables(lineIdx, t) {
      var st = displayed[lineIdx]; if (!st) return;
      var spans = st.el.querySelectorAll(".syllable");
      for (var i = 0; i < spans.length; i++) {
        var sylIdx = parseInt(spans[i].getAttribute("data-syl"), 10), v = vocals[sylIdx];
        var keep = Math.min(v.Length || 0, MAXNOTE), diff = t - v.Time, cls;
        if (diff < 0) cls = "syllable-future";
        else if (diff > keep) cls = "syllable-past";
        else cls = "syllable-current";
        var next = "syllable " + cls;
        if (spans[i].className !== next) spans[i].className = next;
      }
    }

    SK.onState(function (s) {
      if (s.songId !== loadedSong) { loadedSong = s.songId; loadLyrics(s.songId); }
      if (s.phase !== "playing" || !vocals.length || !lineStruct.length) { clearAll(); return; }

      var t = (s.time || 0) + LAT;
      if (t <= 0) { clearAll(); return; }

      // Active = most recently started line; keeps it visible during gaps.
      var active = -1;
      for (var i = 0; i < lineStruct.length; i++) {
        if (lineStruct[i].startTime <= t) active = i; else break;
      }
      var anticipating = false;
      if (active === -1) {
        if (lineStruct[0].startTime - t <= PRE) { active = 0; anticipating = true; }
        else { clearAll(); return; }
      }

      var targets = {}; targets[active] = "active";
      if (!anticipating) {
        for (var off = 1; off < LINES; off++) {
          var idx = active + off;
          if (idx < lineStruct.length) targets[idx] = off === 1 ? "preview" : "preview" + off;
        }
      }
      // Create / re-slot.
      for (var ts in targets) {
        var li = parseInt(ts, 10);
        if (displayed[li]) {
          var stt = displayed[li];
          if (stt.timer) { clearTimeout(stt.timer); stt.timer = null; }
          if (stt.slot !== targets[ts]) { setSlot(stt.el, targets[ts]); stt.slot = targets[ts]; }
        } else createLine(li, targets[ts]);
      }
      // Retire lines no longer targeted.
      for (var dk in displayed) {
        if (!(dk in targets) && displayed[dk].slot !== "outgoing") {
          setSlot(displayed[dk].el, "outgoing"); displayed[dk].slot = "outgoing"; scheduleRemoval(dk);
        }
      }
      // Highlight syllables on visible lines.
      for (var tk in targets) updateSyllables(parseInt(tk, 10), t);
    });
  })();
