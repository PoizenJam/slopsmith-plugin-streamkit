(function () {
      var node = document.getElementById("sk-debug");
      var ver = document.getElementById("sk-version");
      fetch(SK.api("version")).then(function (r) { return r.json(); })
        .then(function (v) { ver.textContent = "stream_kit v" + (v.version || "?"); })
        .catch(function () { ver.textContent = "stream_kit (version unknown)"; });
      SK.onState(function (s) { node.textContent = JSON.stringify(s, null, 2); });
    })();
