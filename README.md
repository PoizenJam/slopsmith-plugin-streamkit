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
http://<your-slopsmith-host>/api/plugins/stream_kit/assets/overlay-nowplaying.html
```

Use the **http://** player host (not an https-fronted domain) so a future
browser-direct OBS control connection isn't blocked by mixed content.

## What it does

- **Producer**: subscribes to `window.slopsmith` song lifecycle events and pushes
  live now-playing state to the plugin backend.
- **Overlays** (OBS Browser Sources, SSE-fed, in `assets/`, sharing
  `sk-overlay-core.js`):
  - `overlay-nowplaying.html` — compact now-playing + instrument detail + accuracy
  - `overlay-current-song.html` — album art, title/artist/album/year, arrangement
  - `overlay-note-streaks.html` — current & best streak
  - `overlay-accuracy-chart.html` — accuracy over the song (self-contained canvas)
  - `overlay-debug.html` — live feed dump (the `debug_addon` analog)
- **Playthrough history**: every finished song is persisted with **RockSniffer
  `PlaythroughHistory` parity** — identical `playthrough_history` SQLite table and
  CSV (same columns/order/quoting, three timestamps; Score-Attack columns blank).

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

Done: now-playing, current-song, note-streaks, accuracy-chart, current-measure,
timeline, vocals (karaoke), and debug overlays; the per-song chart-structures
channel (beats/sections/phrases/lyrics); RockSniffer-parity playthrough history
(SQLite + CSV); note-detector accuracy/streak tally.

The **vocals** overlay needs a one-line `getLyrics()` accessor on the highway
(`slopsmith-getLyrics-accessor.patch`, mirrors `getBeats()`/`getSections()`) —
it degrades to blank without it, lighting up once the patch lands.

Next: the per-phrase/section accuracy ladder + previous-best tracker (powers
current_song v3.1/v4 and the Learn-a-Song Arcade overlay) — it needs phrase
exposure the same way (no `getPhrases()` today). OBS scene automation remains
deferred.

## License

AGPL-3.0-only. Sign commits with DCO (`git commit -s`).
