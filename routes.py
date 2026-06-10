"""stream_kit backend — state relay (SSE) + RockSniffer-parity playthrough history.

- Ingests now-playing/stats state from the producer and fans it to overlays (SSE).
- Persists finished playthroughs to a history store whose SQLite + CSV layout
  matches RockSniffer's PlaythroughHistory exactly (see history.py).
- Enriches each record with album / year / canonical tuning name from the meta
  DB (keyed by song_id == the songs-table filename), mirroring how RockSniffer
  pulled those from SongDetails — they aren't in the song_info WS payload.
- Serves the instrument family table so the frontend never re-implements it.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

PLUGIN_ID = "stream_kit"
DEFAULT_GAME_MODE = "LEARNASONG"  # Slopsmith free-play ≈ RockSniffer Learn-a-Song

# Single source of truth for the version: the manifest. Surfaced for bug-report
# triage (startup log, /version endpoint, debug overlay, in-app dashboard) but
# never on the streamer-facing overlays.
try:
    PLUGIN_VERSION = json.loads(
        (Path(__file__).resolve().parent / "plugin.json").read_text(encoding="utf-8")
    ).get("version", "?")
except Exception:
    PLUGIN_VERSION = "?"


def setup(app: FastAPI, context: dict) -> None:
    log = context["log"]
    instruments = context["load_sibling"]("instruments")
    history_mod = context["load_sibling"]("history")
    store = history_mod.Store(context["config_dir"] / PLUGIN_ID)
    meta_db = context.get("meta_db")

    state: dict = {"value": {"phase": "idle"}, "rev": 0}
    subscribers: set[asyncio.Queue] = set()
    # Cache album/year per song_id so we meta-lookup once per song, not per frame.
    enrich = {"song_id": None, "album": None, "year": None, "tuning_name": None}
    # Chart structures (beats/sections/phrases) are large and change only per
    # song, so they ride a separate once-per-song channel — NOT the per-frame
    # SSE state. The producer POSTs them on song load; overlays GET them when the
    # SSE state's songId changes.
    chart = {"song_id": None, "beats": [], "sections": [], "phrases": [], "lyrics": []}

    def _publish(payload: dict) -> None:
        state["value"] = payload
        state["rev"] += 1
        for q in list(subscribers):
            try:
                q.put_nowait(payload)
            except Exception:
                subscribers.discard(q)

    def _meta_lookup(song_id: str) -> dict:
        """album / year / tuning_name for a song_id (songs.filename). Returns {}
        on any miss so history still writes with blanks (RockSniffer parity)."""
        if not song_id or meta_db is None:
            return {}
        try:
            with meta_db._lock:
                row = meta_db.conn.execute(
                    "SELECT album, year, tuning_name FROM songs WHERE filename = ?",
                    (song_id,),
                ).fetchone()
            if not row:
                return {}
            return {"album": row[0], "year": row[1], "tuning_name": row[2]}
        except Exception:
            return {}

    @app.post(f"/api/plugins/{PLUGIN_ID}/song")
    async def ingest_chart(request: Request):
        # Per-song chart structures from the producer (beats/sections/phrases).
        try:
            p = await request.json()
        except Exception:
            return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
        chart["song_id"] = p.get("songId")
        chart["beats"] = p.get("beats") or []
        chart["sections"] = p.get("sections") or []
        chart["phrases"] = p.get("phrases") or []
        chart["lyrics"] = p.get("lyrics") or []
        return {"ok": True, "beats": len(chart["beats"]), "sections": len(chart["sections"])}

    @app.get(f"/api/plugins/{PLUGIN_ID}/song")
    async def get_chart():
        return JSONResponse(chart)

    @app.get(f"/api/plugins/{PLUGIN_ID}/instruments")
    async def instruments_table():
        return JSONResponse(instruments.wire_table())

    @app.post(f"/api/plugins/{PLUGIN_ID}/state")
    async def ingest_state(request: Request):
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
        # Attach album/year (not in song_info) so current_song-style overlays can
        # show them. Looked up once per song_id, then cached.
        sid = payload.get("songId")
        if sid and sid != enrich["song_id"]:
            meta = _meta_lookup(sid)
            enrich.update(song_id=sid, album=meta.get("album"), year=meta.get("year"),
                          tuning_name=meta.get("tuning_name"))
        if sid and sid == enrich["song_id"]:
            payload["album"] = enrich["album"]
            payload["year"] = enrich["year"]
            payload["tuningName"] = enrich["tuning_name"]
        _publish(payload)
        return {"ok": True, "rev": state["rev"]}

    @app.get(f"/api/plugins/{PLUGIN_ID}/events")
    async def events(request: Request):
        q: asyncio.Queue = asyncio.Queue()
        subscribers.add(q)
        q.put_nowait(state["value"])

        async def gen():
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        payload = await asyncio.wait_for(q.get(), timeout=15.0)
                        yield f"data: {json.dumps(payload)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                subscribers.discard(q)

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post(f"/api/plugins/{PLUGIN_ID}/playthrough")
    async def record_playthrough(request: Request):
        try:
            p = await request.json()
        except Exception:
            return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
        try:
            meta = _meta_lookup(p.get("song_id") or "")
            # Build the RockSniffer arrangement_tuning string: canonical tuning
            # name + capo suffix, e.g. "D Standard (Capo Fret 2)".
            tuning_name = meta.get("tuning_name") or p.get("tuning_name") or ""
            capo = p.get("capo") or 0
            arr_tuning = tuning_name
            if tuning_name and capo:
                arr_tuning = f"{tuning_name} (Capo Fret {capo})"

            rec = {
                "timestamp": p.get("timestamp"),
                "timestamp_start": p.get("timestamp_start"),
                "timestamp_end": p.get("timestamp_end"),
                "song_id": p.get("song_id") or "",
                "song_name": p.get("song_name") or "",
                "artist_name": p.get("artist_name") or "",
                "album_name": meta.get("album") or "",
                "album_year": meta.get("year"),
                "song_length": p.get("song_length"),
                "arrangement_id": str(p.get("arrangement_id") if p.get("arrangement_id") is not None else ""),
                "arrangement_path": p.get("arrangement_path") or "",
                "arrangement_tuning": arr_tuning,
                "game_mode": p.get("game_mode") or DEFAULT_GAME_MODE,
                "author": p.get("author") or "",
                "total_notes": p.get("total_notes"),
                "notes_hit": p.get("notes_hit"),
                "notes_missed": p.get("notes_missed"),
                "highest_hit_streak": p.get("highest_hit_streak"),
                "accuracy": p.get("accuracy"),
                "completed": p.get("completed"),
                "paused": p.get("paused"),
            }
            rid = store.record(rec)
            return {"ok": True, "id": rid}
        except Exception as e:
            log.warning("stream_kit: playthrough record failed: %s", e)
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    @app.get(f"/api/plugins/{PLUGIN_ID}/history")
    async def history_query(song_id: str | None = None, limit: int = 100):
        return JSONResponse(store.query(song_id=song_id, limit=limit))

    @app.get(f"/api/plugins/{PLUGIN_ID}/tracker")
    async def get_best(song_id: str | None = None, arrangement: str = ""):
        # Previous-best per-arrangement accuracy (+ per-section/phrase), for the
        # ladder's relative-to-best coloring. {} when there's no prior run.
        best = store.get_best(song_id or "", arrangement)
        return JSONResponse(best or {})

    @app.post(f"/api/plugins/{PLUGIN_ID}/tracker")
    async def put_best(request: Request):
        try:
            p = await request.json()
        except Exception:
            return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
        try:
            wrote = store.put_best(
                p.get("song_id") or "", p.get("arrangement") or "",
                p.get("accuracy"), p.get("sections") or {}, p.get("phrases") or {},
            )
            return {"ok": True, "updated": bool(wrote)}
        except Exception as e:
            log.warning("stream_kit: best update failed: %s", e)
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    # ── OBS scene automation config ──────────────────────────────────────────
    # The scene-control page (run as an OBS browser source/dock) reads this to
    # connect to obs-websocket v5 and map producer phases → scenes. Stored next
    # to the history DB. NOTE: the obs-websocket password is returned to the
    # controller so it can authenticate; this is intended for local single-user
    # setups (the controller and OBS are on the same machine).
    scene_cfg_path = context["config_dir"] / PLUGIN_ID / "scene-config.json"
    _PHASES = ["browsing", "idle", "loaded", "playing", "paused", "results"]

    def _scene_defaults() -> dict:
        # guard=True: only switch when OBS is already on one of the mapped
        # scenes, so manual scenes (Intro/Outro/Just Chatting) are left alone.
        return {"enabled": False, "guard": True, "host": "localhost", "port": 4455,
                "password": "", "map": {p: "" for p in _PHASES}}

    def _load_scene_cfg() -> dict:
        d = _scene_defaults()
        try:
            if scene_cfg_path.exists():
                saved = json.loads(scene_cfg_path.read_text(encoding="utf-8"))
                d.update({k: saved[k] for k in ("enabled", "guard", "host", "port", "password") if k in saved})
                d["map"].update({p: (saved.get("map") or {}).get(p, "") for p in _PHASES})
        except Exception as e:
            log.warning("stream_kit: scene-config read failed: %s", e)
        return d

    @app.get(f"/api/plugins/{PLUGIN_ID}/scene-config")
    async def get_scene_config():
        return JSONResponse(_load_scene_cfg())

    @app.post(f"/api/plugins/{PLUGIN_ID}/scene-config")
    async def set_scene_config(request: Request):
        try:
            p = await request.json()
        except Exception:
            return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
        cfg = _scene_defaults()
        cfg["enabled"] = bool(p.get("enabled", False))
        cfg["guard"] = bool(p.get("guard", True))
        cfg["host"] = str(p.get("host") or "localhost")
        try:
            cfg["port"] = int(p.get("port") or 4455)
        except (TypeError, ValueError):
            cfg["port"] = 4455
        cfg["password"] = str(p.get("password") or "")
        cfg["map"] = {ph: str((p.get("map") or {}).get(ph, "") or "") for ph in _PHASES}
        try:
            scene_cfg_path.parent.mkdir(parents=True, exist_ok=True)
            scene_cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
            return {"ok": True}
        except Exception as e:
            log.warning("stream_kit: scene-config write failed: %s", e)
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    @app.get(f"/api/plugins/{PLUGIN_ID}/version")
    async def get_version():
        return JSONResponse({"id": PLUGIN_ID, "name": "Stream Kit", "version": PLUGIN_VERSION})

    log.info("stream_kit v%s backend ready (RockSniffer-parity history at %s / %s)",
             PLUGIN_VERSION, store.db_path, store.csv_path)
