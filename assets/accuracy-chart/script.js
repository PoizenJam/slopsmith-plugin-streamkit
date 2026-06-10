(function () {
      var wrap = document.getElementById("sk-chart");
      var nowEl = document.getElementById("sk-chart-now");
      var cv = document.getElementById("sk-chart-canvas");
      var ctx = cv.getContext("2d");
      var W = cv.width, H = cv.height, PAD = 4;
      var pts = [];          // {t, acc}
      var curSong = null, lastDur = 0;

      function accent() {
        return getComputedStyle(document.documentElement).getPropertyValue("--sk-accent").trim() || "#5b8cff";
      }
      function draw(dur) {
        ctx.clearRect(0, 0, W, H);
        // gridlines at 0/50/100%
        ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1;
        [0, 0.5, 1].forEach(function (f) {
          var y = PAD + (H - 2 * PAD) * (1 - f);
          ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
        });
        if (pts.length < 2) return;
        var span = dur || (pts[pts.length - 1].t || 1);
        var x = function (t) { return PAD + (W - 2 * PAD) * Math.max(0, Math.min(1, t / span)); };
        var y = function (a) { return PAD + (H - 2 * PAD) * (1 - Math.max(0, Math.min(100, a)) / 100); };
        ctx.strokeStyle = accent(); ctx.lineWidth = 2; ctx.lineJoin = "round";
        ctx.beginPath(); ctx.moveTo(x(pts[0].t), y(pts[0].acc));
        for (var i = 1; i < pts.length; i++) ctx.lineTo(x(pts[i].t), y(pts[i].acc));
        ctx.stroke();
      }

      SK.onState(function (s) {
        var on = SK.songActive(s) && s.scored;
        wrap.classList.toggle("sk-hidden", !on);
        if (!on) return;
        if (s.songId !== curSong) { curSong = s.songId; pts = []; } // reset per song
        lastDur = s.duration || lastDur;
        if (s.stats && s.stats.accuracy != null && s.time != null) {
          var last = pts[pts.length - 1];
          if (!last || s.time >= (last.t || 0)) pts.push({ t: s.time, acc: s.stats.accuracy });
          nowEl.textContent = s.stats.accuracy + "%";
        }
        draw(lastDur);
      });
    })();
