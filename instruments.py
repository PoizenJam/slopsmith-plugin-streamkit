"""Instrument family registry — the forward-compatibility keystone.

Everything instrument-specific in stream_kit (the now-playing state shape, the
history record, the scorer wiring, the overlay rendering) is driven off the
table below rather than hardcoding guitar/bass assumptions. Adding a new
instrument as Slopsmith grows (drums already exists; keys/vocals/etc. will
follow) is a data edit *here* — no schema migration, no producer rewrite, no
overlay code change for the common path.

The frontend never re-implements this. `routes.py` exposes the table at
`GET /api/plugins/stream_kit/instruments`, and `screen.js` / `overlay.js`
classify and render from the fetched copy. One source of truth, two consumers.

Classification mirrors how Slopsmith core itself infers arrangement type
(lib/loosefolder.py: name keywords), plus the authoritative `has_drum_tab`
flag from the `song_info` payload for drums.

`fields`  — which song_info fields are meaningful for this family. The producer
            only copies present-and-true fields into the instrument block, so a
            drum arrangement never carries a bogus `tuning`/`capo`.
`scorer`  — the *kind* of detector that can score this family. "pitch" is what
            slopsmith-plugin-notedetect provides today (guitar/bass). "onset"
            is the natural kind for a future drum scorer. None = no scorer kind
            exists yet, so accuracy stays null and history degrades gracefully.
`accuracy_unit` — documents what `accuracy` *means* for this family, since the
            number is per-instrument (a fretted "note" hit vs a drum "hit").
"""

from __future__ import annotations

SCHEMA_VERSION = 1

# Order matters only for documentation; classify() applies explicit precedence.
FAMILIES: dict[str, dict] = {
    "guitar": {
        "label": "Guitar",
        # Matched by arrangement-name keyword when not a drum tab.
        "match_names": ["lead", "rhythm", "combo", "guitar"],
        "fields": {"tuning": True, "string_count": True, "capo": True, "kit": False, "reference_pitch": True},
        "scorer": "pitch",
        "accuracy_unit": "note",
    },
    "bass": {
        "label": "Bass",
        "match_names": ["bass"],
        "fields": {"tuning": True, "string_count": True, "capo": True, "kit": False, "reference_pitch": True},
        "scorer": "pitch",
        "accuracy_unit": "note",
    },
    "keys": {
        "label": "Keys",
        "match_names": ["keys", "piano", "synth"],
        # Keys has no string/tuning/capo; no detector kind exists yet.
        "fields": {"tuning": False, "string_count": False, "capo": False, "kit": False, "reference_pitch": False},
        "scorer": None,
        "accuracy_unit": None,
    },
    "drums": {
        "label": "Drums",
        # `has_drum_tab` is authoritative; names are a fallback.
        "match_names": ["drums", "drum", "percussion"],
        "match_drum_tab": True,
        "fields": {"tuning": False, "string_count": False, "capo": False, "kit": True, "reference_pitch": False},
        "scorer": "onset",          # no onset scorer ships yet — accuracy stays null
        "accuracy_unit": "hit",
    },
    # Known-future placeholder: lyrics + lib/vocal_pitch.py already exist, so a
    # vocals family is a likely next integration. Declared so the producer and
    # overlays already tolerate it; no fields/scorer claimed until it's real.
    "vocals": {
        "label": "Vocals",
        "match_names": ["vocals", "vocal", "lyrics"],
        "fields": {"tuning": False, "string_count": False, "capo": False, "kit": False, "reference_pitch": False},
        "scorer": None,
        "accuracy_unit": None,
    },
}

# Fallback for anything unrecognized — renders title/artist/arrangement only,
# never claims instrument-specific fields, never attaches a scorer.
DEFAULT_FAMILY = "unknown"
_UNKNOWN_DESC = {
    "label": "",
    "match_names": [],
    "fields": {"tuning": False, "string_count": False, "capo": False, "kit": False},
    "scorer": None,
    "accuracy_unit": None,
}


def descriptor(family: str) -> dict:
    return FAMILIES.get(family, _UNKNOWN_DESC)


def classify(arrangement_name: str | None, has_drum_tab: bool = False) -> str:
    """Map an arrangement to a family key. Mirrors core's name-based inference.

    Precedence: drum tab flag → name keyword (drums first, then others) → unknown.
    """
    if has_drum_tab:
        return "drums"
    name = (arrangement_name or "").lower()
    # Check drums-by-name before the rest so a "Drums" arrangement without an
    # explicit drum_tab (legacy drum sloppaks encode hits as notes) still maps right.
    for fam in ("drums", "bass", "keys", "vocals", "guitar"):
        for kw in FAMILIES[fam]["match_names"]:
            if kw in name:
                return fam
    return DEFAULT_FAMILY


def wire_table() -> dict:
    """The serializable copy the frontend fetches. Includes the keyword lists so
    the client can classify without re-implementing any logic."""
    return {
        "schema_version": SCHEMA_VERSION,
        "default": DEFAULT_FAMILY,
        "families": {
            key: {
                "label": d["label"],
                "match_names": d.get("match_names", []),
                "match_drum_tab": bool(d.get("match_drum_tab", False)),
                "fields": d["fields"],
                "scorer": d["scorer"],
                "accuracy_unit": d["accuracy_unit"],
            }
            for key, d in FAMILIES.items()
        },
    }


def normalize(family: str | None) -> str:
    """Coerce an arbitrary client-supplied family to a known key (history hygiene)."""
    return family if family in FAMILIES else DEFAULT_FAMILY
