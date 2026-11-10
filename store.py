"""SQLite-backed library of parsed matches.

Replays are large (10-40 MB) and Fortnite deletes the unsaved ones as you keep
playing. Parsed results are small, about a kilobyte of stats plus a row per
elimination, so everything is extracted once and kept here permanently. A
replay is identified by the GUID in its own header, which makes re-importing
the same match a no-op.
"""

from __future__ import annotations

import json
import os
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Iterable

from replay.parser import ParsedReplay

APP_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share"), "FortReplays"
)
DB_PATH = os.path.join(APP_DIR, "library.db")

DEFAULT_DEMOS_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA", ""), "FortniteGame", "Saved", "Demos"
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS matches (
    replay_id            TEXT PRIMARY KEY,
    file_name            TEXT NOT NULL,
    file_path            TEXT,
    file_size            INTEGER,
    imported_at          TEXT NOT NULL,
    recorded_at          TEXT,
    length_ms            INTEGER NOT NULL DEFAULT 0,
    fortnite_version     TEXT,
    changelist           INTEGER,
    mode                 TEXT,
    map_name             TEXT,
    platform             TEXT,
    recorder_id          TEXT,
    has_stats            INTEGER NOT NULL DEFAULT 0,
    accuracy             REAL,
    assists              INTEGER,
    eliminations         INTEGER,
    weapon_damage        INTEGER,
    other_damage         INTEGER,
    total_damage         INTEGER,
    revives              INTEGER,
    damage_taken         INTEGER,
    damage_to_structures INTEGER,
    materials_gathered   INTEGER,
    materials_used       INTEGER,
    total_traveled       INTEGER,
    placement            INTEGER,
    total_players        INTEGER,
    elim_event_count     INTEGER NOT NULL DEFAULT 0,
    elim_parse_failures  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS eliminations (
    replay_id      TEXT NOT NULL REFERENCES matches(replay_id) ON DELETE CASCADE,
    seq            INTEGER NOT NULL,
    time_ms        INTEGER NOT NULL,
    eliminated_id   TEXT,
    eliminator_id   TEXT,
    eliminated_type TEXT,
    eliminator_type TEXT,
    gun_type       INTEGER,
    knocked        INTEGER NOT NULL DEFAULT 0,
    is_self_elim   INTEGER NOT NULL DEFAULT 0,
    distance_m     REAL,
    PRIMARY KEY (replay_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_elim_eliminator ON eliminations(eliminator_id);
CREATE INDEX IF NOT EXISTS idx_elim_eliminated ON eliminations(eliminated_id);
CREATE INDEX IF NOT EXISTS idx_matches_recorded ON matches(recorded_at);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Team number, display name and placement per player, read from the replay's
-- network stream by the helper executable. When present this is authoritative:
-- teams are the game's own team index rather than anything inferred.
CREATE TABLE IF NOT EXISTS match_roster (
    replay_id  TEXT NOT NULL REFERENCES matches(replay_id) ON DELETE CASCADE,
    player_id  TEXT NOT NULL,
    name       TEXT,
    team       INTEGER,
    placement  INTEGER,
    kills      INTEGER,
    is_bot     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (replay_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_roster_team ON match_roster(replay_id, team);

-- A teammate's own replay of the same match carries their real stats block.
-- Uploading it here is the only exact way to get their damage, so each one is
-- attached to the match it belongs to.
CREATE TABLE IF NOT EXISTS contributions (
    replay_id   TEXT NOT NULL REFERENCES matches(replay_id) ON DELETE CASCADE,
    owner_id    TEXT NOT NULL,
    file_name   TEXT,
    source_id   TEXT,
    stats       TEXT NOT NULL,
    placement   INTEGER,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (replay_id, owner_id)
);


-- Replays do not record which players were on your team, so the squad roster is
-- built up here: suggested from the killfeed, confirmed by you, then permanent.
CREATE TABLE IF NOT EXISTS teammates (
    player_id TEXT PRIMARY KEY,
    added_at  TEXT NOT NULL,
    source    TEXT NOT NULL DEFAULT 'manual'
);

-- Display names are not in the part of a replay this app reads: they live in the
-- Oodle-compressed replication stream. So they are either typed in by hand or
-- fetched from a lookup service, and cached here either way. Manual and
-- looked-up names are kept apart so clearing a nickname falls back to the
-- looked-up name instead of losing both.
CREATE TABLE IF NOT EXISTS player_names (
    player_id   TEXT PRIMARY KEY,
    manual_name TEXT,
    lookup_name TEXT,
    looked_up   INTEGER NOT NULL DEFAULT 0,
    fetched_at  TEXT
);
"""

# Fortnite stores an elimination cause as a numeric code and publishes no
# mapping from code to weapon. Two are identifiable from the data itself: code
# 50 is ~98% self-eliminations (storm), code 0 is the generic environment cause.
# For the rest the app suggests a weapon from the code's own range profile and
# lets you correct the name. A guessed default you can fix beats a fake
# authoritative mapping.
KNOWN_CAUSES = {50: "Storm", 0: "Environment"}

# (upper bound on the 75th-percentile kill range in metres, suggested name).
# The 75th percentile separates weapon classes far better than the median:
# every weapon gets used point-blank, so medians all collapse toward each other,
# but only the long-range ones have a long tail.
RANGE_PROFILE = (
    (3, "Melee / pickaxe"),
    (12, "Shotgun"),
    (25, "SMG"),
    (45, "Assault rifle"),
    (80, "Marksman rifle"),
    (float("inf"), "Sniper"),
)


def suggest_weapon_name(code: int | None, p75_range: float | None) -> str:
    if code in KNOWN_CAUSES:
        return KNOWN_CAUSES[code]
    if p75_range is None:
        return f"Weapon type {code}"
    for limit, name in RANGE_PROFILE:
        if p75_range <= limit:
            return name
    return f"Weapon type {code}"


def get_weapon_labels(conn) -> dict:
    try:
        return json.loads(get_setting(conn, "weapon_labels") or "{}")
    except json.JSONDecodeError:
        return {}


def set_weapon_labels(conn, labels: dict) -> None:
    clean = {str(k): str(v).strip() for k, v in (labels or {}).items() if str(v).strip()}
    set_setting(conn, "weapon_labels", json.dumps(clean) if clean else None)


def cause_label(code: int | None, labels: dict | None = None) -> str:
    if code is None:
        return "Unknown"
    if labels and str(code) in labels:
        return labels[str(code)]
    return KNOWN_CAUSES.get(code, f"Weapon type {code}")


def weapon_names(conn, account_id: str | None) -> dict:
    """Code to display name: your custom label first, else the range-based guess.

    One source of truth, so the killfeed, the per-player table and the dashboard
    breakdown never disagree about what a weapon is called.
    """
    labels = get_weapon_labels(conn)
    names = dict(labels)
    for weapon in weapon_catalog(conn, account_id):
        names.setdefault(str(weapon["code"]), weapon["label"])
    return names


def _percentile(values: list, fraction: float) -> float | None:
    clean = sorted(v for v in values if v is not None)
    if not clean:
        return None
    return clean[min(len(clean) - 1, int(len(clean) * fraction))]


def weapon_catalog(conn, account_id: str | None) -> list[dict]:
    """Every cause code seen in the killfeed, with the evidence for naming it.

    Ranges are measured over kills only. Knocks are all close-quarters by
    nature and would flatten the differences between weapon classes.
    """
    if not account_id:
        return []
    labels = get_weapon_labels(conn)
    rows = conn.execute(
        """SELECT gun_type, COUNT(*) AS kills, MAX(distance_m) AS max_distance
           FROM eliminations
           WHERE eliminator_id = ? AND is_self_elim = 0 AND knocked = 0
           GROUP BY gun_type ORDER BY kills DESC""",
        (account_id,),
    ).fetchall()

    catalog = []
    for row in rows:
        code = row["gun_type"]
        distances = [
            r["distance_m"]
            for r in conn.execute(
                """SELECT distance_m FROM eliminations
                   WHERE eliminator_id = ? AND gun_type IS ? AND knocked = 0
                     AND is_self_elim = 0 AND distance_m IS NOT NULL""",
                (account_id, code),
            )
        ]
        median = _percentile(distances, 0.5)
        p75 = _percentile(distances, 0.75)
        suggestion = suggest_weapon_name(code, p75)
        catalog.append(
            {
                "code": code,
                "kills": row["kills"],
                "median_distance": round(median, 1) if median is not None else None,
                "p75_distance": round(p75, 1) if p75 is not None else None,
                "max_distance": row["max_distance"],
                "suggestion": suggestion,
                "label": labels.get(str(code)) or suggestion,
                "custom": str(code) in labels,
            }
        )
    return catalog


def connect(db_path: str = DB_PATH) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def _migrate(conn) -> None:
    """Add columns introduced after a library was first created."""
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(matches)")}
    for column, ddl in (
        ("mode", "TEXT"),
        ("map_name", "TEXT"),
        ("platform", "TEXT"),
        ("recorder_id", "TEXT"),
    ):
        if column not in existing:
            conn.execute(f"ALTER TABLE matches ADD COLUMN {column} {ddl}")

    elim_columns = {row["name"] for row in conn.execute("PRAGMA table_info(eliminations)")}
    for column in ("eliminated_type", "eliminator_type"):
        if column not in elim_columns:
            conn.execute(f"ALTER TABLE eliminations ADD COLUMN {column} TEXT")

    # Earlier versions kept one display_name column plus a source string.
    name_columns = {row["name"] for row in conn.execute("PRAGMA table_info(player_names)")}
    if "display_name" in name_columns and "manual_name" not in name_columns:
        conn.execute("ALTER TABLE player_names ADD COLUMN manual_name TEXT")
        conn.execute("ALTER TABLE player_names ADD COLUMN lookup_name TEXT")
        conn.execute("ALTER TABLE player_names ADD COLUMN looked_up INTEGER NOT NULL DEFAULT 0")
        conn.execute(
            "UPDATE player_names SET manual_name = CASE WHEN source = 'manual' THEN display_name END,"
            " lookup_name = CASE WHEN source = 'lookup' THEN display_name END,"
            " looked_up = CASE WHEN source IN ('lookup', 'lookup-miss') THEN 1 ELSE 0 END"
        )
    # Created here rather than in SCHEMA: on an existing library the column has
    # only just been added by the loop above.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_matches_mode ON matches(mode)")
    conn.commit()


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def get_setting(conn, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn, key: str, value: str | None) -> None:
    if value is None:
        conn.execute("DELETE FROM settings WHERE key = ?", (key,))
    else:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
    conn.commit()


def get_demos_dir(conn) -> str:
    return get_setting(conn, "demos_dir") or DEFAULT_DEMOS_DIR


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

def import_replay(conn, replay: ParsedReplay) -> str:
    """Insert a parsed replay. Returns 'added' or 'duplicate'."""
    existing = conn.execute(
        "SELECT 1 FROM matches WHERE replay_id = ?", (replay.replay_id,)
    ).fetchone()
    if existing:
        return "duplicate"

    stats = replay.stats
    recorded = replay.info.recorded_at
    conn.execute(
        """INSERT INTO matches (
            replay_id, file_name, file_path, file_size, imported_at, recorded_at,
            length_ms, fortnite_version, changelist, mode, map_name, platform, has_stats,
            accuracy, assists, eliminations, weapon_damage, other_damage, total_damage,
            revives, damage_taken, damage_to_structures, materials_gathered,
            materials_used, total_traveled, placement, total_players,
            elim_event_count, elim_parse_failures
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            replay.replay_id,
            replay.file_name,
            replay.file_path,
            replay.file_size,
            datetime.now(timezone.utc).isoformat(),
            recorded.isoformat() if recorded else None,
            replay.info.length_ms,
            replay.header.fortnite_version,
            replay.header.changelist,
            replay.header.mode,
            replay.header.map_name,
            replay.header.platform,
            1 if replay.has_stats else 0,
            stats.accuracy if stats else None,
            stats.assists if stats else None,
            stats.eliminations if stats else None,
            stats.weapon_damage if stats else None,
            stats.other_damage if stats else None,
            stats.total_damage if stats else None,
            stats.revives if stats else None,
            stats.damage_taken if stats else None,
            stats.damage_to_structures if stats else None,
            stats.materials_gathered if stats else None,
            stats.materials_used if stats else None,
            stats.total_traveled if stats else None,
            replay.placement,
            replay.total_players,
            replay.elim_event_count,
            replay.elim_parse_failures,
        ),
    )

    conn.executemany(
        """INSERT INTO eliminations
           (replay_id, seq, time_ms, eliminated_id, eliminator_id,
            eliminated_type, eliminator_type, gun_type,
            knocked, is_self_elim, distance_m)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        [
            (
                replay.replay_id,
                seq,
                elim.time_ms,
                elim.eliminated_id,
                elim.eliminator_id,
                elim.eliminated_type,
                elim.eliminator_type,
                elim.gun_type,
                1 if elim.knocked else 0,
                1 if elim.is_self_elim else 0,
                round(elim.distance_cm / 100.0, 1) if elim.distance_cm else None,
            )
            for seq, elim in enumerate(replay.eliminations)
        ],
    )
    conn.commit()
    return "added"


def known_replay_ids(conn) -> set[str]:
    return {row["replay_id"] for row in conn.execute("SELECT replay_id FROM matches")}


def delete_match(conn, replay_id: str) -> bool:
    cursor = conn.execute("DELETE FROM matches WHERE replay_id = ?", (replay_id,))
    conn.execute("DELETE FROM eliminations WHERE replay_id = ?", (replay_id,))
    conn.commit()
    return cursor.rowcount > 0


# ---------------------------------------------------------------------------
# Account detection
# ---------------------------------------------------------------------------

def detect_account_id(conn) -> tuple[str | None, dict]:
    """Work out which account id is the person recording.

    Event chunks never say who you are, so two independent signals are combined:

      presence  you appear in every one of your own replays; nobody else does.
                Decisive over a large library, useless over one match.
      agreement your killfeed kill count should equal the eliminations figure in
                that match's own stats block. Works on a single replay.

    Agreement is ranked first because it stays reliable when only a handful of
    replays have been imported, which is the common case.
    """
    presence = {
        row["player_id"]: row["n"]
        for row in conn.execute(
            """SELECT player_id, COUNT(DISTINCT replay_id) AS n FROM (
                   SELECT replay_id, eliminated_id AS player_id FROM eliminations
                   UNION ALL
                   SELECT replay_id, eliminator_id AS player_id FROM eliminations
               )
               WHERE player_id IS NOT NULL AND player_id <> 'Bot'
               GROUP BY player_id"""
        )
    }
    if not presence:
        return None, {"candidates": []}

    agreement = {
        row["player_id"]: row["hits"]
        for row in conn.execute(
            """SELECT k.player_id, COUNT(*) AS hits FROM (
                   SELECT eliminator_id AS player_id, replay_id, COUNT(*) AS kills
                   FROM eliminations
                   WHERE knocked = 0 AND is_self_elim = 0 AND eliminator_id IS NOT NULL
                   GROUP BY eliminator_id, replay_id
               ) k
               JOIN matches m ON m.replay_id = k.replay_id
               WHERE m.has_stats = 1 AND m.eliminations = k.kills
               GROUP BY k.player_id"""
        )
    }

    ranked = sorted(
        presence,
        key=lambda pid: (-agreement.get(pid, 0), -presence[pid], pid),
    )
    candidates = [
        {"id": pid, "matches": presence[pid], "stats_agreement": agreement.get(pid, 0)}
        for pid in ranked[:5]
    ]
    best = candidates[0]
    runner_up = candidates[1] if len(candidates) > 1 else None

    decisive = best["stats_agreement"] >= max(
        1, (runner_up["stats_agreement"] if runner_up else 0) * 2
    ) or best["matches"] >= max(3, (runner_up["matches"] if runner_up else 0) * 2)

    total = conn.execute("SELECT COUNT(*) AS n FROM matches").fetchone()["n"]
    return best["id"], {
        "candidates": candidates,
        "total_matches": total,
        "confidence": "high" if decisive else "low",
    }


def ensure_account_id(conn) -> str | None:
    """Return the stored account id, detecting and saving one if not set."""
    stored = get_setting(conn, "account_id")
    if stored:
        return stored
    detected, meta = detect_account_id(conn)
    if detected and meta.get("confidence") == "high":
        set_setting(conn, "account_id", detected)
        return detected
    return detected


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------

def _where(filters: dict) -> tuple[str, list]:
    clauses, params = [], []
    if filters.get("stats_only", True):
        clauses.append("has_stats = 1")
    if filters.get("date_from"):
        clauses.append("recorded_at >= ?")
        params.append(filters["date_from"])
    if filters.get("date_to"):
        clauses.append("recorded_at <= ?")
        params.append(filters["date_to"] + "T23:59:59Z")
    if filters.get("min_length_ms"):
        clauses.append("length_ms >= ?")
        params.append(int(filters["min_length_ms"]))
    if filters.get("mode"):
        clauses.append("mode = ?")
        params.append(filters["mode"])
    if filters.get("wins_only"):
        clauses.append("placement = 1")
    if filters.get("min_damage"):
        clauses.append("total_damage >= ?")
        params.append(int(filters["min_damage"]))
    if filters.get("min_eliminations"):
        clauses.append("eliminations >= ?")
        params.append(int(filters["min_eliminations"]))
    if filters.get("q"):
        term = f"%{filters['q'].strip()}%"
        clauses.append(
            "(file_name LIKE ? OR mode LIKE ? OR map_name LIKE ? OR recorded_at LIKE ?)"
        )
        params.extend([term] * 4)
    return (" WHERE " + " AND ".join(clauses) if clauses else ""), params


def modes(conn) -> list[dict]:
    """Distinct modes present in the library, most common first."""
    rows = conn.execute(
        """SELECT COALESCE(mode, 'Unknown') AS mode, COUNT(*) AS n,
                  SUM(has_stats) AS with_stats
           FROM matches GROUP BY COALESCE(mode, 'Unknown') ORDER BY n DESC"""
    )
    return [dict(row) for row in rows]


def list_matches(conn, filters: dict | None = None) -> list[dict]:
    filters = filters or {}
    where, params = _where(filters)
    sql = f"SELECT * FROM matches{where} ORDER BY COALESCE(recorded_at, imported_at) DESC"
    if filters.get("limit"):
        sql += " LIMIT ?"
        params.append(int(filters["limit"]))
    return [dict(row) for row in conn.execute(sql, params)]


def get_match(conn, replay_id: str, account_id: str | None = None) -> dict | None:
    row = conn.execute("SELECT * FROM matches WHERE replay_id = ?", (replay_id,)).fetchone()
    if not row:
        return None
    match = dict(row)

    elims = [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM eliminations WHERE replay_id = ? ORDER BY time_ms, seq",
            (replay_id,),
        )
    ]
    names = weapon_names(conn, account_id)
    for elim in elims:
        elim["cause"] = names.get(str(elim["gun_type"])) or cause_label(elim["gun_type"])
        elim["by_me"] = bool(account_id and elim["eliminator_id"] == account_id)
        elim["on_me"] = bool(account_id and elim["eliminated_id"] == account_id)

    # Kept under its own key: the `eliminations` column is the stats-block count.
    match["killfeed"] = elims
    players = match_players(conn, replay_id, account_id)
    match["players"] = players
    match["squad"] = [p for p in players if p["is_teammate"]]
    match["squad_candidates"] = squad_candidates(conn, account_id, replay_id)
    match["killfeed_summary"] = {
        "total": len(elims),
        "my_kills": sum(1 for e in elims if e["by_me"] and not e["knocked"] and not e["is_self_elim"]),
        "my_knocks": sum(1 for e in elims if e["by_me"] and e["knocked"]),
        "my_deaths": sum(1 for e in elims if e["on_me"] and not e["knocked"] and not e["is_self_elim"]),
    }
    return match


_EFFECTIVE_NAME = "COALESCE(manual_name, lookup_name)"


def get_player_names(conn, player_ids: Iterable[str] | None = None) -> dict:
    """Effective display names, keyed by account id. A nickname wins over a lookup."""
    if player_ids is None:
        rows = conn.execute(f"SELECT player_id, {_EFFECTIVE_NAME} AS name FROM player_names")
    else:
        ids = [p for p in player_ids if p]
        if not ids:
            return {}
        marks = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT player_id, {_EFFECTIVE_NAME} AS name FROM player_names "
            f"WHERE player_id IN ({marks})",
            ids,
        )
    return {row["player_id"]: row["name"] for row in rows if row["name"]}


def set_player_name(conn, player_id: str, name: str | None) -> None:
    """Set or clear a manual nickname. Clearing falls back to the looked-up name."""
    clean = (name or "").strip() or None
    conn.execute(
        """INSERT INTO player_names(player_id, manual_name) VALUES(?, ?)
           ON CONFLICT(player_id) DO UPDATE SET manual_name = excluded.manual_name""",
        (player_id, clean),
    )
    conn.execute(
        "DELETE FROM player_names WHERE player_id = ? AND manual_name IS NULL"
        " AND lookup_name IS NULL AND looked_up = 0",
        (player_id,),
    )
    conn.commit()


def set_lookup_name(conn, player_id: str, name: str | None) -> None:
    """Record the result of an online lookup, leaving any nickname untouched."""
    conn.execute(
        """INSERT INTO player_names(player_id, lookup_name, looked_up, fetched_at)
           VALUES(?, ?, 1, ?)
           ON CONFLICT(player_id) DO UPDATE SET
               lookup_name = excluded.lookup_name,
               looked_up = 1,
               fetched_at = excluded.fetched_at""",
        (player_id, (name or "").strip() or None, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()


def record_lookup_miss(conn, player_id: str) -> None:
    """Remember that a lookup came back empty, so it is not retried on every view."""
    set_lookup_name(conn, player_id, None)


def unresolved_player_ids(conn, replay_id: str | None = None) -> list[str]:
    """Real player ids with no name yet and no recorded lookup miss."""
    sql = """SELECT DISTINCT e.player_id AS player_id FROM (
                 SELECT replay_id, eliminated_id AS player_id, eliminated_type AS ptype
                 FROM eliminations
                 UNION ALL
                 SELECT replay_id, eliminator_id AS player_id, eliminator_type AS ptype
                 FROM eliminations
             ) e
             LEFT JOIN player_names n ON n.player_id = e.player_id
             WHERE e.player_id IS NOT NULL AND e.player_id <> 'Bot'
               AND (e.ptype IS NULL OR e.ptype = 'player')
               AND (n.player_id IS NULL OR (n.looked_up = 0 AND n.manual_name IS NULL))"""
    params: list = []
    if replay_id:
        sql += " AND e.replay_id = ?"
        params.append(replay_id)
    return [row["player_id"] for row in conn.execute(sql, params)]


def name_stats(conn) -> dict:
    row = conn.execute(
        f"""SELECT COUNT(*) AS total,
                   SUM({_EFFECTIVE_NAME} IS NOT NULL) AS named,
                   SUM(manual_name IS NOT NULL) AS manual,
                   SUM(lookup_name IS NOT NULL) AS looked_up
            FROM player_names"""
    ).fetchone()
    return {
        "cached": row["total"] or 0,
        "named": row["named"] or 0,
        "manual": row["manual"] or 0,
        "looked_up": row["looked_up"] or 0,
        "unresolved": len(unresolved_player_ids(conn)),
    }


def save_roster(conn, replay_id: str, players: list) -> int:
    """Store the network-stream roster and adopt its names."""
    rows = []
    for player in players or []:
        player_id = (player.get("id") or "").strip().lower()
        if not player_id:
            continue
        rows.append(
            (
                replay_id,
                player_id,
                (player.get("name") or "").strip() or None,
                player.get("team"),
                player.get("placement"),
                player.get("kills"),
                1 if player.get("isBot") else 0,
            )
        )
    if not rows:
        return 0

    conn.executemany(
        """INSERT INTO match_roster(replay_id, player_id, name, team, placement, kills, is_bot)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(replay_id, player_id) DO UPDATE SET
               name = COALESCE(excluded.name, match_roster.name),
               team = COALESCE(excluded.team, match_roster.team),
               placement = COALESCE(excluded.placement, match_roster.placement),
               kills = COALESCE(excluded.kills, match_roster.kills),
               is_bot = excluded.is_bot""",
        rows,
    )
    # Names from the stream are real display names, so they seed the name cache
    # and remove any need to look them up online.
    for row in rows:
        if row[2]:
            conn.execute(
                """INSERT INTO player_names(player_id, lookup_name, looked_up, fetched_at)
                   VALUES(?,?,1,?)
                   ON CONFLICT(player_id) DO UPDATE SET
                       lookup_name = excluded.lookup_name, looked_up = 1""",
                (row[1], row[2], datetime.now(timezone.utc).isoformat()),
            )
    conn.commit()
    return len(rows)


def match_fingerprint(conn, replay_id: str) -> set:
    """A set of elimination keys identifying a match regardless of who recorded it.

    Deliberately carries no timestamps. Each player's client starts recording at
    its own moment, so the same elimination sits at a different millisecond in
    every player's file; including time meant two replays of one match never
    matched. Who eliminated whom, with what, does not drift.
    """
    return {
        (row["eliminated_id"], row["eliminator_id"], row["gun_type"])
        for row in conn.execute(
            "SELECT eliminated_id, eliminator_id, gun_type FROM eliminations WHERE replay_id = ?"
            " AND eliminated_type = 'player' AND eliminator_type = 'player'",
            (replay_id,),
        )
    }


def fingerprint_of(replay) -> set:
    # Only player-versus-player entries: bot identifiers are per-client and
    # would differ between two recordings of the same game.
    return {
        (e.eliminated_id, e.eliminator_id, e.gun_type)
        for e in replay.eliminations
        if e.eliminated_type == "player" and e.eliminator_type == "player"
    }


def match_similarity(conn, replay) -> tuple[str | None, float]:
    """Best-matching stored match for this replay, and how strong the match is.

    Timestamps are deliberately not used to narrow the search. Fortnite writes
    the recording time as local time with no time zone attached, so two players
    in different countries produce headers hours apart for the same game. Only
    the eliminations decide it, and they are the same for everybody.
    """
    incoming = fingerprint_of(replay)
    if len(incoming) < 5:
        return None, 0.0

    best_id, best_score = None, 0.0
    for row in conn.execute(
        "SELECT replay_id FROM matches WHERE replay_id <> ?", (replay.replay_id,)
    ).fetchall():
        existing = match_fingerprint(conn, row["replay_id"])
        if not existing:
            continue
        overlap = len(incoming & existing) / min(len(incoming), len(existing))
        if overlap > best_score:
            best_id, best_score = row["replay_id"], overlap

    return best_id, best_score


def find_same_match(conn, replay, minimum_overlap: float = 0.6) -> str | None:
    """Find an already-imported match that this replay is another view of."""
    best_id, score = match_similarity(conn, replay)
    return best_id if score >= minimum_overlap else None


def set_recorder(conn, replay_id: str, recorder_id: str | None) -> None:
    conn.execute(
        "UPDATE matches SET recorder_id = ? WHERE replay_id = ?",
        ((recorder_id or "").lower() or None, replay_id),
    )
    conn.commit()


def merge_duplicate_matches(conn, account_id: str | None) -> list[dict]:
    """Fold matches that are really one game into a single entry.

    Before timestamps were dropped from the fingerprint, a teammate's replay
    imported as a separate match. This finds those, keeps the one you recorded,
    and turns the others into contributions on it.
    """
    rows = conn.execute(
        """SELECT replay_id, recorder_id, recorded_at, file_name, accuracy, assists,
                  eliminations, weapon_damage, other_damage, total_damage, revives,
                  damage_taken, damage_to_structures, materials_gathered, materials_used,
                  total_traveled, placement
           FROM matches ORDER BY imported_at"""
    ).fetchall()
    if len(rows) < 2:
        return []

    prints = {row["replay_id"]: match_fingerprint(conn, row["replay_id"]) for row in rows}
    merged: list[dict] = []
    absorbed: set = set()

    for index, row in enumerate(rows):
        if row["replay_id"] in absorbed:
            continue
        mine = prints[row["replay_id"]]
        if len(mine) < 5:
            continue

        for other in rows[index + 1 :]:
            if other["replay_id"] in absorbed:
                continue
            theirs = prints[other["replay_id"]]
            if len(theirs) < 5:
                continue
            overlap = len(mine & theirs) / min(len(mine), len(theirs))
            if overlap < 0.6:
                continue

            # Keep whichever one you recorded, so your match stays the primary.
            keep, drop = row, other
            if account_id and (other["recorder_id"] or "") == account_id.lower() \
               and (row["recorder_id"] or "") != account_id.lower():
                keep, drop = other, row

            owner = (drop["recorder_id"] or "").lower()
            if not owner or owner == "unknown":
                continue  # cannot attribute it, so leave it alone

            stats = {
                key: drop[key]
                for key in (
                    "accuracy", "assists", "eliminations", "weapon_damage", "other_damage",
                    "total_damage", "revives", "damage_taken", "damage_to_structures",
                    "materials_gathered", "materials_used", "total_traveled",
                )
            }
            conn.execute(
                """INSERT INTO contributions(replay_id, owner_id, file_name, source_id, stats,
                                             placement, imported_at)
                   VALUES(?,?,?,?,?,?,?)
                   ON CONFLICT(replay_id, owner_id) DO UPDATE SET stats = excluded.stats""",
                (
                    keep["replay_id"],
                    owner,
                    drop["file_name"],
                    drop["replay_id"],
                    json.dumps(stats),
                    drop["placement"],
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            conn.execute("DELETE FROM eliminations WHERE replay_id = ?", (drop["replay_id"],))
            conn.execute("DELETE FROM matches WHERE replay_id = ?", (drop["replay_id"],))
            absorbed.add(drop["replay_id"])
            merged.append(
                {"kept": keep["replay_id"], "absorbed": drop["file_name"], "owner": owner}
            )

    conn.commit()
    return merged


def add_contribution(conn, replay_id: str, owner_id: str, replay, source_replay_id: str) -> None:
    """Attach a teammate's stats block to a match already in the library."""
    stats = replay.stats.as_dict() if replay.stats else {}
    conn.execute(
        """INSERT INTO contributions(replay_id, owner_id, file_name, source_id, stats,
                                     placement, imported_at)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(replay_id, owner_id) DO UPDATE SET
               stats = excluded.stats,
               file_name = excluded.file_name,
               placement = excluded.placement,
               imported_at = excluded.imported_at""",
        (
            replay_id,
            owner_id.lower(),
            replay.file_name,
            source_replay_id,
            json.dumps(stats),
            replay.placement,
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    conn.commit()


def get_contributions(conn, replay_id: str) -> dict:
    out = {}
    for row in conn.execute(
        "SELECT owner_id, stats, file_name FROM contributions WHERE replay_id = ?", (replay_id,)
    ):
        try:
            stats = json.loads(row["stats"])
        except json.JSONDecodeError:
            continue
        stats["_file"] = row["file_name"]
        out[row["owner_id"]] = stats
    return out






def match_roster(conn, replay_id: str) -> dict:
    return {
        row["player_id"]: dict(row)
        for row in conn.execute("SELECT * FROM match_roster WHERE replay_id = ?", (replay_id,))
    }


def roster_teammates(conn, replay_id: str, account_id: str | None) -> set:
    """Players sharing your team number in this match. Exact, when available."""
    if not account_id:
        return set()
    row = conn.execute(
        "SELECT team FROM match_roster WHERE replay_id = ? AND player_id = ?",
        (replay_id, account_id.lower()),
    ).fetchone()
    if not row or row["team"] is None:
        return set()
    return {
        r["player_id"]
        for r in conn.execute(
            "SELECT player_id FROM match_roster WHERE replay_id = ? AND team = ? AND player_id <> ?",
            (replay_id, row["team"], account_id.lower()),
        )
    }


def has_roster(conn, replay_id: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM match_roster WHERE replay_id = ? LIMIT 1", (replay_id,)
        ).fetchone()
        is not None
    )


def get_teammates(conn) -> set:
    return {row["player_id"] for row in conn.execute("SELECT player_id FROM teammates")}


def set_teammate(conn, player_id: str, is_teammate: bool, source: str = "manual") -> None:
    if is_teammate:
        conn.execute(
            """INSERT INTO teammates(player_id, added_at, source) VALUES(?,?,?)
               ON CONFLICT(player_id) DO UPDATE SET source = excluded.source""",
            (player_id, datetime.now(timezone.utc).isoformat(), source),
        )
    else:
        conn.execute("DELETE FROM teammates WHERE player_id = ?", (player_id,))
    conn.commit()


def _knock_chain_partners(conn, replay_id: str, account_id: str) -> Counter:
    """Players who finished someone you knocked, or finished your knock.

    Squads trade knocks and finishes constantly and opponents essentially never
    do, so this is the sharpest single-match signal available. Measured across
    this library it picks a genuine squadmate about three times in four.
    """
    rows = conn.execute(
        """SELECT time_ms, eliminated_id, eliminator_id, knocked, is_self_elim
           FROM eliminations WHERE replay_id = ? ORDER BY time_ms, seq""",
        (replay_id,),
    ).fetchall()
    partners: Counter = Counter()
    for index, first in enumerate(rows):
        if first["is_self_elim"] or not first["knocked"]:
            continue
        for second in rows[index + 1 :]:
            if second["time_ms"] - first["time_ms"] > 30000:
                break
            if second["is_self_elim"] or second["knocked"]:
                continue
            if second["eliminated_id"] != first["eliminated_id"]:
                continue
            a, b = first["eliminator_id"], second["eliminator_id"]
            if a == account_id and b and b != account_id:
                partners[b] += 1
            elif b == account_id and a and a != account_id:
                partners[a] += 1
    return partners


def _traded_with(conn, account_id: str, replay_id: str | None = None) -> set:
    """Accounts that eliminated you or that you eliminated. Never teammates."""
    sql = """SELECT eliminated_id AS other FROM eliminations
             WHERE eliminator_id = ? AND is_self_elim = 0
             UNION
             SELECT eliminator_id AS other FROM eliminations
             WHERE eliminated_id = ? AND is_self_elim = 0"""
    params = [account_id, account_id]
    if replay_id:
        sql = sql.replace("WHERE eliminator_id = ?", "WHERE replay_id = ? AND eliminator_id = ?")
        sql = sql.replace("WHERE eliminated_id = ?", "WHERE replay_id = ? AND eliminated_id = ?")
        params = [replay_id, account_id, replay_id, account_id]
    return {row["other"] for row in conn.execute(sql, params) if row["other"]}


def squad_candidates(conn, account_id: str | None, replay_id: str | None = None) -> list[dict]:
    """Suggested teammates, best first, excluding anyone already confirmed.

    Two signals: how often an account turns up across your library, and whether
    they traded knocks and finishes with you in this match. Neither is proof,
    which is why these are suggestions with a button rather than a silent guess.
    """
    if not account_id:
        return []
    # With the network stream read, teams are known outright and there is
    # nothing to suggest.
    if replay_id and has_roster(conn, replay_id):
        return []
    confirmed = get_teammates(conn)
    # Only trades inside this match disqualify someone. Across a whole library a
    # regular squadmate will inevitably turn up as an opponent in some other
    # lobby, so a global exclusion throws away real teammates.
    enemies = _traded_with(conn, account_id, replay_id) if replay_id else set()
    chains = _knock_chain_partners(conn, replay_id, account_id) if replay_id else Counter()

    rival_counts = Counter(
        row["other"]
        for row in conn.execute(
            """SELECT eliminated_id AS other FROM eliminations
               WHERE eliminator_id = ? AND is_self_elim = 0
               UNION ALL
               SELECT eliminator_id AS other FROM eliminations
               WHERE eliminated_id = ? AND is_self_elim = 0""",
            (account_id, account_id),
        )
        if row["other"]
    )

    if replay_id:
        present = {
            row["player_id"]
            for row in conn.execute(
                """SELECT eliminated_id AS player_id FROM eliminations WHERE replay_id = ?
                   UNION
                   SELECT eliminator_id AS player_id FROM eliminations WHERE replay_id = ?""",
                (replay_id, replay_id),
            )
        }
    else:
        present = None

    rows = conn.execute(
        """SELECT player_id, COUNT(DISTINCT replay_id) AS together FROM (
               SELECT replay_id, eliminated_id AS player_id FROM eliminations
               UNION ALL
               SELECT replay_id, eliminator_id AS player_id FROM eliminations
           )
           WHERE player_id IS NOT NULL AND player_id <> 'Bot' AND player_id <> ?
           GROUP BY player_id""",
        (account_id,),
    ).fetchall()

    names = get_player_names(conn)
    candidates = []
    for row in rows:
        pid = row["player_id"]
        if pid in confirmed or pid in enemies:
            continue
        if present is not None and pid not in present:
            continue
        # Trading eliminations with you is evidence against, not proof against.
        score = row["together"] + 4 * chains.get(pid, 0) - 2 * rival_counts.get(pid, 0)
        if score < 2:
            continue
        candidates.append(
            {
                "player_id": pid,
                "matches_together": row["together"],
                "shared_eliminations": chains.get(pid, 0),
                "traded_with_you": rival_counts.get(pid, 0),
                "score": score,
                "display_name": names.get(pid),
            }
        )
    candidates.sort(key=lambda c: (-c["score"], c["player_id"]))
    return candidates[:6]


def match_players(conn, replay_id: str, account_id: str | None = None) -> list[dict]:
    """Per-player breakdown of one match, built from the killfeed.

    The killfeed covers the whole lobby, so this works for everyone in the game,
    not just you. What it cannot include is damage: the game never sends other
    players' damage totals to your client, so it is not in the file. Anyone who
    neither eliminated nor was eliminated leaves no trace here either, which in
    practice means the match winner is the one player who may be missing.
    """
    rows = conn.execute(
        """SELECT time_ms, eliminated_id, eliminator_id, eliminated_type, eliminator_type,
                  gun_type, knocked, is_self_elim, distance_m
           FROM eliminations WHERE replay_id = ? ORDER BY time_ms, seq""",
        (replay_id,),
    ).fetchall()
    if not rows:
        return []

    match_row = conn.execute(
        "SELECT length_ms FROM matches WHERE replay_id = ?", (replay_id,)
    ).fetchone()
    length_ms = match_row["length_ms"] if match_row else 0
    labels = weapon_names(conn, account_id)

    players: dict[str, dict] = {}

    def entry(player_id, player_type):
        if not player_id:
            return None
        record = players.setdefault(
            player_id,
            {
                "player_id": player_id,
                "player_type": player_type or "player",
                "kills": 0,
                "knocks": 0,
                "deaths": 0,
                "times_knocked": 0,
                "self_elims": 0,
                "kill_distances": [],
                "weapons": Counter(),
                "first_seen_ms": None,
                "last_seen_ms": None,
                "died_at_ms": None,
                "killed_by": None,
                "victims": set(),
            },
        )
        if player_type and record["player_type"] == "player":
            record["player_type"] = player_type
        return record

    for row in rows:
        killer = entry(row["eliminator_id"], row["eliminator_type"])
        victim = entry(row["eliminated_id"], row["eliminated_type"])

        for record in (killer, victim):
            if not record:
                continue
            if record["first_seen_ms"] is None:
                record["first_seen_ms"] = row["time_ms"]
            record["last_seen_ms"] = row["time_ms"]

        if row["is_self_elim"]:
            if victim:
                victim["self_elims"] += 1
                if not row["knocked"] and victim["died_at_ms"] is None:
                    victim["died_at_ms"] = row["time_ms"]
                    victim["killed_by"] = cause_label(row["gun_type"], labels)
            continue

        if killer:
            if row["knocked"]:
                killer["knocks"] += 1
            else:
                killer["kills"] += 1
                killer["weapons"][row["gun_type"]] += 1
                if row["distance_m"] is not None:
                    killer["kill_distances"].append(row["distance_m"])
                if row["eliminated_id"]:
                    killer["victims"].add(row["eliminated_id"])

        if victim:
            if row["knocked"]:
                victim["times_knocked"] += 1
            else:
                victim["deaths"] += 1
                if victim["died_at_ms"] is None:
                    victim["died_at_ms"] = row["time_ms"]
                    victim["killed_by"] = cause_label(row["gun_type"], labels)

    names = get_player_names(conn, players.keys())
    roster = match_roster(conn, replay_id)
    contributed = get_contributions(conn, replay_id)
    # An exact team number beats the roster you built up by hand, so it wins
    # when the network stream was readable.
    auto_squad = roster_teammates(conn, replay_id, account_id)
    teammates = auto_squad if roster else get_teammates(conn)
    def official(player_id, field):
        """The game's own figure for a player, when the network stream gave us one."""
        entry = roster.get(player_id) or {}
        value = entry.get(field)
        return value if value is not None else None

    result = []
    for record in players.values():
        distances = record["kill_distances"]
        top_weapon = record["weapons"].most_common(1)
        survived_ms = record["died_at_ms"] if record["died_at_ms"] is not None else length_ms
        result.append(
            {
                "player_id": record["player_id"],
                "player_type": record["player_type"],
                "is_bot": record["player_type"] in ("bot", "named_bot"),
                "is_me": bool(account_id and record["player_id"] == account_id),
                "is_teammate": record["player_id"] in teammates,
                # Named bots carry their name in the replay itself; everyone
                # else needs a nickname or a lookup.
                "display_name": (roster.get(record["player_id"], {}) or {}).get("name")
                or names.get(record["player_id"])
                or (record["player_id"] if record["player_type"] == "named_bot" else None),
                "team": (roster.get(record["player_id"], {}) or {}).get("team"),
                # Exact stats, from that player's own replay of this match.
                "own_stats": contributed.get(record["player_id"]),
                # Counting eliminations out of the killfeed disagrees with the
                # game: it over-credits whoever lands the finishing blow and
                # misses kills the feed attributes elsewhere. Measured on one
                # match: 7 vs 4 for one teammate, 0 vs 2 for another. So the
                # game's own count wins whenever it is available.
                "kills": official(record["player_id"], "kills")
                if official(record["player_id"], "kills") is not None
                else record["kills"],
                "kills_from_killfeed": record["kills"],
                "knocks": record["knocks"],
                "deaths": record["deaths"],
                "times_knocked": record["times_knocked"],
                "self_elims": record["self_elims"],
                "kd": _safe_div(
                    official(record["player_id"], "kills")
                    if official(record["player_id"], "kills") is not None
                    else record["kills"],
                    record["deaths"],
                )
                or (record["kills"] or 0),
                "avg_kill_distance": round(sum(distances) / len(distances), 1) if distances else None,
                "longest_kill": max(distances) if distances else None,
                "top_weapon": cause_label(top_weapon[0][0], labels) if top_weapon else None,
                "unique_victims": len(record["victims"]),
                "first_seen_ms": record["first_seen_ms"],
                "died_at_ms": record["died_at_ms"],
                "survived_ms": survived_ms,
                "survived_to_end": record["died_at_ms"] is None,
                "killed_by": record["killed_by"],
            }
        )

    result.sort(key=lambda p: (-p["kills"], -p["knocks"], p["survived_ms"] and -p["survived_ms"]))
    return result


def _safe_div(a: float | None, b: float | None) -> float | None:
    if not a or not b:
        return None
    return a / b


def clear_library(conn) -> int:
    """Delete every stored match. Replay files on disk are untouched."""
    count = conn.execute("SELECT COUNT(*) AS n FROM matches").fetchone()["n"]
    conn.execute("DELETE FROM eliminations")
    conn.execute("DELETE FROM matches")
    set_setting(conn, "account_id", None)
    set_setting(conn, "account_id_manual", None)
    conn.commit()
    return count


def backfill_metadata(conn, parse_fn) -> dict:
    """Re-read headers of already-imported replays to fill newly added columns.

    Only touches rows whose original file is still on disk, and only reads the
    header, with no killfeed work, so it is fast.
    """
    rows = conn.execute(
        "SELECT replay_id, file_path FROM matches WHERE mode IS NULL AND file_path IS NOT NULL"
    ).fetchall()
    updated = missing = 0
    for row in rows:
        if not row["file_path"] or not os.path.isfile(row["file_path"]):
            missing += 1
            continue
        try:
            replay = parse_fn(row["file_path"], with_killfeed=False)
        except Exception:
            missing += 1
            continue
        conn.execute(
            "UPDATE matches SET mode = ?, map_name = ?, platform = ? WHERE replay_id = ?",
            (replay.header.mode, replay.header.map_name, replay.header.platform, row["replay_id"]),
        )
        updated += 1
    conn.commit()
    return {"updated": updated, "skipped": missing, "candidates": len(rows)}


def library_stats(conn) -> dict:
    row = conn.execute(
        """SELECT COUNT(*) AS total,
                  SUM(has_stats) AS with_stats,
                  SUM(placement IS NOT NULL) AS with_placement,
                  MIN(recorded_at) AS first_match,
                  MAX(recorded_at) AS last_match
           FROM matches"""
    ).fetchone()
    elims = conn.execute("SELECT COUNT(*) AS n FROM eliminations").fetchone()["n"]
    return {**dict(row), "eliminations": elims, "db_path": DB_PATH}
