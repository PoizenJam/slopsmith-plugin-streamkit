(function () {
      var wrap = document.getElementById("sk-streaks");
      var cur = document.getElementById("sk-cur"), best = document.getElementById("sk-best");
      SK.onState(function (s) {
        // Hide unless a song is active AND a detector is scoring it.
        var on = SK.songActive(s) && s.scored && s.stats;
        wrap.classList.toggle("sk-hidden", !on);
        if (!on) return;
        cur.textContent = s.stats.streak || 0;
        best.textContent = s.stats.bestStreak || 0;
      });
    })();
