(function () {
      var wrap = document.getElementById("sk-measure");
      var curEl = document.getElementById("sk-measure-cur");
      var totEl = document.getElementById("sk-measure-tot");
      var beats = [];          // [{time, measure}]
      var totalMeasures = 0;
      var loadedSong = null;

      function loadChart() {
        SK.fetchSong().then(function (c) {
          beats = (c && c.beats) || [];
          totalMeasures = beats.reduce(function (m, b) { return Math.max(m, b.measure || 0); }, 0);
        });
      }
      // Current measure = measure of the latest beat at or before current time.
      function measureAt(t) {
        if (!beats.length) return 0;
        var lo = 0, hi = beats.length - 1, ans = 0;
        while (lo <= hi) {
          var mid = (lo + hi) >> 1;
          if (beats[mid].time <= t) { ans = beats[mid].measure || 0; lo = mid + 1; }
          else hi = mid - 1;
        }
        return ans;
      }

      SK.onState(function (s) {
        var on = SK.songActive(s);
        wrap.classList.toggle("sk-hidden", !on);
        if (!on) return;
        if (s.songId !== loadedSong) { loadedSong = s.songId; loadChart(); }
        curEl.textContent = measureAt(s.time || 0);
        totEl.textContent = totalMeasures ? " / " + totalMeasures : "";
      });
    })();
