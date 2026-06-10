"""Playthrough history — byte-for-byte parity with RockSniffer's
PlaythroughHistory (RockSniffer/History/PlaythroughHistory.cs).

Writes BOTH a SQLite `playthrough_history` table and a CSV with the identical
column set, order, and formatting RockSniffer uses, including the three
timestamps (metadata-loaded / actual-start / actual-end, "yyyy-MM-dd HH:mm:ss").

Score-Attack-only columns are always NULL (SQLite) / blank (CSV): Slopsmith has
no Score Attack mode, exactly as RockSniffer leaves them for Learn-a-Song rows.

The producer supplies the Slopsmith-side values; routes.py enriches album/year/
tuning-name from the meta DB before calling record(), mirroring how RockSniffer
pulled them from SongDetails.
"""

from __future__ import annotations

import csv
import io
import os
import sqlite3
from pathlib import Path

# Exact column order RockSniffer uses (SQLite + CSV share it).
TEXT_COLS = {
    "timestamp", "timestamp_start", "timestamp_end", "song_id", "song_name",
    "artist_name", "album_name", "arrangement_id", "arrangement_path",
    "arrangement_tuning", "game_mode", "author",
}
# CSV header (RockSniffer's exact spelling/order).
CSV_HEADER = [
    "Timestamp", "TimestampStart", "TimestampEnd", "SongID", "SongName",
    "ArtistName", "AlbumName", "AlbumYear", "SongLength", "ArrangementID",
    "ArrangementPath", "ArrangementTuning", "GameMode", "Author", "TotalNotes",
    "NotesHit", "NotesMissed", "HighestHitStreak", "Accuracy", "Completed",
    "Paused", "TotalPerfectHits", "PerfectPhrases", "GoodPhrases",
    "PassedPhrases", "FailedPhrases", "HighestPerfectPhraseStreak",
    "HighestGoodPhraseStreak", "HighestPassedPhraseStreak",
    "HighestFailedPhraseStreak", "CurrentScore", "HighestMultiplier",
]
# SQLite column names in the same order.
SQL_COLS = [
    "timestamp", "timestamp_start", "timestamp_end", "song_id", "song_name",
    "artist_name", "album_name", "album_year", "song_length", "arrangement_id",
    "arrangement_path", "arrangement_tuning", "game_mode", "author",
    "total_notes", "notes_hit", "notes_missed", "highest_hit_streak",
    "accuracy", "completed", "paused", "total_perfect_hits", "perfect_phrases",
    "good_phrases", "passed_phrases", "failed_phrases",
    "highest_perfect_phrase_streak", "highest_good_phrase_streak",
    "highest_passed_phrase_streak", "highest_failed_phrase_streak",
    "current_score", "highest_multiplier",
]
# Score-Attack-only fields (always empty for Slopsmith).
SA_COLS = [
    "total_perfect_hits", "perfect_phrases", "good_phrases", "passed_phrases",
    "failed_phrases", "highest_perfect_phrase_streak",
    "highest_good_phrase_streak", "highest_passed_phrase_streak",
    "highest_failed_phrase_streak", "current_score", "highest_multiplier",
]


class Store:
    def __init__(self, base_dir: Path, enable_sqlite: bool = True, enable_csv: bool = True):
        base_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = base_dir / "history.db"
        self.csv_path = base_dir / "history.csv"
        self.enable_sqlite = enable_sqlite
        self.enable_csv = enable_csv
        self.conn = None
        if enable_sqlite:
            self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
            self.conn.row_factory = sqlite3.Row
            self._create_table()
        if enable_csv and not self.csv_path.exists():
            with open(self.csv_path, "w", newline="", encoding="utf-8") as f:
                csv.writer(f, quoting=csv.QUOTE_MINIMAL).writerow(CSV_HEADER)

    def _create_table(self) -> None:
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS playthrough_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                timestamp_start TEXT NOT NULL,
                timestamp_end TEXT NOT NULL,
                song_id TEXT,
                song_name TEXT,
                artist_name TEXT,
                album_name TEXT,
                album_year INTEGER,
                song_length REAL,
                arrangement_id TEXT,
                arrangement_path TEXT,
                arrangement_tuning TEXT,
                game_mode TEXT,
                author TEXT,
                total_notes INTEGER,
                notes_hit INTEGER,
                notes_missed INTEGER,
                highest_hit_streak INTEGER,
                accuracy REAL,
                completed INTEGER,
                paused INTEGER,
                total_perfect_hits INTEGER,
                perfect_phrases INTEGER,
                good_phrases INTEGER,
                passed_phrases INTEGER,
                failed_phrases INTEGER,
                highest_perfect_phrase_streak INTEGER,
                highest_good_phrase_streak INTEGER,
                highest_passed_phrase_streak INTEGER,
                highest_failed_phrase_streak INTEGER,
                current_score INTEGER,
                highest_multiplier INTEGER
            )
            """
        )
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ph_song ON playthrough_history(song_id, timestamp)"
        )
        # Per-arrangement best attempt, for the previous-best ladder comparison
        # (the stream_kit analog of RockSniffer's playthrough_tracker storage).
        # sections / phrases hold per-section / per-phrase accuracy of the best
        # run, as JSON ({name: acc} / {index: acc}).
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS playthrough_best (
                song_id TEXT NOT NULL,
                arrangement TEXT NOT NULL,
                accuracy REAL,
                sections TEXT,
                phrases TEXT,
                updated_at TEXT,
                PRIMARY KEY (song_id, arrangement)
            )
            """
        )
        self.conn.commit()

    def get_best(self, song_id: str, arrangement: str) -> dict | None:
        if not (self.enable_sqlite and self.conn is not None) or not song_id:
            return None
        row = self.conn.execute(
            "SELECT accuracy, sections, phrases FROM playthrough_best WHERE song_id=? AND arrangement=?",
            (song_id, arrangement or ""),
        ).fetchone()
        if not row:
            return None
        import json
        return {
            "accuracy": row[0],
            "sections": json.loads(row[1]) if row[1] else {},
            "phrases": json.loads(row[2]) if row[2] else {},
        }

    def put_best(self, song_id: str, arrangement: str, accuracy, sections: dict, phrases: dict) -> bool:
        """Upsert the best attempt, but only when this run beats the stored
        overall accuracy (or there's no stored run). Returns True if written."""
        if not (self.enable_sqlite and self.conn is not None) or not song_id or accuracy is None:
            return False
        import json
        prev = self.get_best(song_id, arrangement)
        if prev is not None and prev.get("accuracy") is not None and accuracy <= prev["accuracy"]:
            return False
        try:
            self.conn.execute(
                """INSERT INTO playthrough_best (song_id, arrangement, accuracy, sections, phrases, updated_at)
                   VALUES (?, ?, ?, ?, ?, datetime('now'))
                   ON CONFLICT(song_id, arrangement) DO UPDATE SET
                     accuracy=excluded.accuracy, sections=excluded.sections,
                     phrases=excluded.phrases, updated_at=excluded.updated_at""",
                (song_id, arrangement or "", round(float(accuracy), 1),
                 json.dumps(sections or {}), json.dumps(phrases or {})),
            )
            self.conn.commit()
            return True
        except Exception:
            self.conn.rollback()
            raise

    def record(self, rec: dict) -> int | None:
        """Persist one playthrough to SQLite and/or CSV. `rec` carries the
        Slopsmith-side values already mapped to RockSniffer column names by
        routes.py. SA columns are ignored if present and written empty."""
        row = self._normalize(rec)
        rowid = None
        if self.enable_sqlite and self.conn is not None:
            try:
                placeholders = ", ".join(":" + c for c in SQL_COLS)
                cur = self.conn.execute(
                    f"INSERT INTO playthrough_history ({', '.join(SQL_COLS)}) VALUES ({placeholders})",
                    row,
                )
                self.conn.commit()
                rowid = int(cur.lastrowid)
            except Exception:
                self.conn.rollback()
                raise
        if self.enable_csv:
            self._append_csv(row)
        return rowid

    def _normalize(self, rec: dict) -> dict:
        row = {c: None for c in SQL_COLS}
        for c in SQL_COLS:
            if c in rec and rec[c] is not None:
                row[c] = rec[c]
        # SA fields: always empty for Slopsmith (no Score Attack mode).
        for c in SA_COLS:
            row[c] = None
        # Coerce the booleans to 0/1 for SQLite.
        for c in ("completed", "paused"):
            row[c] = 1 if rec.get(c) else 0
        # Accuracy to 1 decimal, matching RockSniffer's Math.Round(..., 1).
        if row.get("accuracy") is not None:
            try:
                row["accuracy"] = round(float(row["accuracy"]), 1)
            except (TypeError, ValueError):
                row["accuracy"] = 0.0
        return row

    def _append_csv(self, row: dict) -> None:
        # Map SQL row -> CSV cells in header order, matching RockSniffer's
        # quoting (text quoted, numerics bare, booleans True/False, SA blank).
        completed = "True" if row.get("completed") else "False"
        paused = "True" if row.get("paused") else "False"
        cells = [
            row.get("timestamp") or "",
            row.get("timestamp_start") or "",
            row.get("timestamp_end") or "",
            row.get("song_id") or "",
            row.get("song_name") or "",
            row.get("artist_name") or "",
            row.get("album_name") or "",
            _num(row.get("album_year")),
            _num(row.get("song_length")),
            row.get("arrangement_id") or "",
            row.get("arrangement_path") or "",
            row.get("arrangement_tuning") or "",
            row.get("game_mode") or "",
            row.get("author") or "",
            _num(row.get("total_notes")),
            _num(row.get("notes_hit")),
            _num(row.get("notes_missed")),
            _num(row.get("highest_hit_streak")),
            _num(row.get("accuracy")),
            completed,
            paused,
        ] + ["" for _ in SA_COLS]  # SA columns blank
        with open(self.csv_path, "a", newline="", encoding="utf-8") as f:
            csv.writer(f, quoting=csv.QUOTE_MINIMAL).writerow(cells)

    def query(self, song_id: str | None = None, limit: int = 100) -> list[dict]:
        if not (self.enable_sqlite and self.conn is not None):
            return []
        limit = max(1, min(int(limit or 100), 1000))
        if song_id:
            rows = self.conn.execute(
                "SELECT * FROM playthrough_history WHERE song_id = ? ORDER BY id DESC LIMIT ?",
                (song_id, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM playthrough_history ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]


def _num(v):
    """Render a numeric CSV cell bare (no quotes), empty when None."""
    return "" if v is None else v
