(function () {
      var wrap = document.getElementById("sk-timeline");
      var bar = document.getElementById("sk-tl-bar");
      var head = document.getElementById("sk-tl-head");
      var secEl = document.getElementById("sk-tl-section");
      var clockEl = document.getElementById("sk-tl-clock");
      var sections = [];       // [{name, time}]
      var loadedSong = null, builtFor = null;

      function loadChart() {
        SK.fetchSong().then(function (c) {
          sections = (c && c.sections) || [];
          builtFor = null;     // force segment rebuild once we know duration
        });
      }
      // Build section segments across 0..duration (needs duration from state).
      function buildSegments(dur) {
        // remove old segments (keep the playhead)
        Array.prototype.slice.call(bar.querySelectorAll(".seg")).forEach(function (n) { n.remove(); });
        if (!dur || !sections.length) return;
        for (var i = 0; i < sections.length; i++) {
          var start = sections[i].time || 0;
          var end = (i + 1 < sections.length) ? (sections[i + 1].time || dur) : dur;
          var seg = document.createElement("div");
          seg.className = "seg";
          seg.dataset.idx = i;
          seg.style.left = (100 * start / dur) + "%";
          seg.style.width = (100 * Math.max(0, end - start) / dur) + "%";
          bar.insertBefore(seg, head);
        }
        builtFor = dur;
      }
      function currentSectionIdx(t) {
        var idx = -1;
        for (var i = 0; i < sections.length; i++) { if ((sections[i].time || 0) <= t) idx = i; else break; }
        return idx;
      }

      SK.onState(function (s) {
        var on = SK.songActive(s);
        wrap.classList.toggle("sk-hidden", !on);
        if (!on) return;
        if (s.songId !== loadedSong) { loadedSong = s.songId; loadChart(); }
        var dur = s.duration || 0;
        if (dur && builtFor !== dur) buildSegments(dur);

        var t = s.time || 0;
        if (dur) head.style.left = Math.max(0, Math.min(100, 100 * t / dur)) + "%";
        clockEl.textContent = SK.fmtClock(t) + (dur ? " / " + SK.fmtClock(dur) : "");

        var idx = currentSectionIdx(t);
        secEl.textContent = idx >= 0 ? (sections[idx].name || "") : "";
        Array.prototype.slice.call(bar.querySelectorAll(".seg")).forEach(function (n) {
          n.classList.toggle("active", parseInt(n.dataset.idx, 10) === idx);
        });
      });
    })();
