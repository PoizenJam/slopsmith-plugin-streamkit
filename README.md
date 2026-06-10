# Stream Kit

A [slopsmith](https://github.com/slopsmith/slopsmith) plugin that emulates
RockSniffer's streamer-facing features: a now-playing OBS overlay, live
accuracy/streak (when a note detector is installed), and per-playthrough
history — all read natively from slopsmith's event bus, no memory scraping or
external process.

## Install

In slopsmith, open the Plugins page, click **Install from GitHub URL**, and paste:

```
https://github.com/PoizenJam/slopsmith-plugin-streamkit
```

slopsmith downloads, installs, and reloads. Then point an OBS **Browser Source** at:

```
http://<your-slopsmith-host>/api/plugins/stream_kit/assets/nowplaying/index.html
```

Use the **http://** player host (not an https-fronted domain) so a future
browser-direct OBS control connection isn't blocked by mixed content.

## What it does

- **Producer**: subscribes to `window.slopsmith` song lifecycle events and pushes
  live now-playing state to the plugin backend.
- **Overlays** (OBS Browser Sources, SSE-fed). Each lives in its own folder under
  `assets/` with its own `index.html` + `style.css` + `script.js`; shared SSE
  client and base theme live in `assets/core/` (`sk-overlay-core.js`, `base.css`):
  - `nowplaying/` — compact now-playing + instrument detail + accuracy
  - `current-song/` — album art, title/artist/album/year, arrangement
  - `vocals/` — timed-syllable karaoke (needs the `getLyrics()` core accessor)
  - `note-streaks/` — current & best streak
  - `accuracy-chart/` — accuracy over the song (self-contained canvas)
  - `current-measure/` — current measure / total (from the chart-structures channel)
  - `timeline/` — section segments + playhead (from the chart-structures channel)
  - `debug/` — live feed dump (the `debug_addon` analog)
- **Playthrough history**: every finished song is persisted with **RockSniffer
  `PlaythroughHistory` parity** — identical `playthrough_history` SQLite table and
  CSV (same columns/order/quoting, three timestamps; Score-Attack columns blank).

## Asset layout

```
assets/
  core/          sk-overlay-core.js (SSE + formatters), base.css (vars + base classes)
  <overlay>/     index.html + style.css + script.js   (one folder per overlay)
  plugin.css     in-app dashboard styles
```

A new overlay = a new folder with those three files; reference `core/base.css` +
`core/sk-overlay-core.js`, add a `render(state)` via `SK.onState`. No shared file
grows as overlays are added.

## Forward compatibility across instruments

`instruments.py` is the single source of truth for instrument families, their
classification, which `song_info` fields each has, and the scorer kind that can
score them. The backend serves it at `/api/plugins/stream_kit/instruments`; the
producer and overlay classify/render from the fetched copy. Adding an instrument
as slopsmith grows (drums already; keys/vocals next) is a data edit there — the
namespaced state, the history schema (`instrument` discriminator + JSON meta),
and the overlay rendering all adapt without code changes.

## Soft dependencies (degrade gracefully)

- **Note detection**: accuracy/streak come from a note-detector plugin
  (e.g. `slopsmith-plugin-notedetect`) if installed — probed, never imported.
  Without it, overlays and history still work; they just omit accuracy.
- **Reference pitch**: the overlay shows the song's cent offset for fretted
  instruments when slopsmith exposes `getSongInfo().centOffset`
  (see [slopsmith PR #770](https://github.com/slopsmith/slopsmith/pull/770)).
  On builds without that field it simply isn't shown — no breakage.

## Status

Overlays: now-playing, current-song-minimal, current-song (v4), current-song-basic
(v2), current-song-advanced (v3.1), current-song-8bit (Arcade), note-streaks,
accuracy-chart, current-measure, timeline, vocals, debug. Plus the playthrough
tracker (per-section/phrase accuracy + previous-best), RockSniffer-parity history
(SQLite + CSV), and the chart-structures channel.

Soft deps: vocals needs the `getLyrics()` core accessor; per-phrase/section
coloring needs a note detector installed; reference-pitch/centOffset comes via
PR #770. OBS scene automation remains deferred.

## License

AGPL-3.0-only. Sign commits with DCO (`git commit -s`).
