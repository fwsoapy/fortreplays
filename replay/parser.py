"""Parser for Fortnite .replay files (event-chunk layer).

A .replay file is a header followed by a stream of chunks. Chunk payloads are
AES-256-ECB encrypted with a key that sits in plaintext in the header. This
module reads the container and decodes the event chunks that carry match
results:

  AthenaMatchStats      damage, accuracy, elims, materials, distance
  AthenaMatchTeamStats  final placement and lobby size
  playerElim            one per elimination in the lobby, with positions

The network-stream chunks (per-player replication data) are deliberately not
decoded. See README.
"""

from __future__ import annotations

import hashlib
import os
import re
import struct
from dataclasses import dataclass, field
from typing import Any

from .aes import decrypt_ecb
from .archive import Archive, ReadError

FILE_MAGIC = 0x1CA2E27F
NETWORK_MAGIC = 0x2CF5A13D

# Chunk type ids
CHUNK_HEADER = 0
CHUNK_REPLAY_DATA = 1
CHUNK_CHECKPOINT = 2
CHUNK_EVENT = 3

# ReplayVersionHistory
HISTORY_RECORDED_TIMESTAMP = 4
HISTORY_COMPRESSION = 5
HISTORY_ENCRYPTION = 6
HISTORY_CUSTOM_VERSIONS = 7

# NetworkVersionHistory
NET_HISTORY_HEADER_FLAGS = 9
NET_HISTORY_SAVE_FULL_ENGINE_VERSION = 11
NET_HISTORY_HEADER_GUID = 12
NET_HISTORY_SAVE_PACKAGE_VERSION_UE = 17
NET_HISTORY_RECORDING_METADATA = 18
NET_HISTORY_USE_CUSTOM_VERSION = 19

# The header names the loaded level and the Verse game-feature plugins the match
# was running. Between them they identify the mode without touching the network
# stream. Checked in order, and the first matching root wins.
MODE_BY_ROOT = (
    ("CreativeRoot", "Creative"),
    ("BlitzRoot", "Blitz Royale"),
    ("BRRoot", "Battle Royale"),
    ("STWRoot", "Save the World"),
)

MAP_NAMES = {
    "Hera_V2_Terrain": "Hera",
    "Hera_Terrain": "Hera",
    "Athena_Empty": "Athena",
    "Athena_Terrain": "Athena",
    "VKPlay_EmptyOcean_VolumeSupport": "Creative island",
}

# Event group / metadata names
GROUP_PLAYER_ELIM = "playerElim"
META_MATCH_STATS = "AthenaMatchStats"
META_TEAM_STATS = "AthenaMatchTeamStats"
META_ENCRYPTION_KEY = "PlayerStateEncryptionKey"

# PlayerTypes
PLAYER_TYPE_BOT = 0x03
PLAYER_TYPE_NAMED_BOT = 0x10
PLAYER_TYPE_PLAYER = 0x11

_BRANCH_RE = re.compile(r"\+\+Fortnite\+Release-(\d+)\.(\d+)")


class ReplayError(Exception):
    """The file is not a replay, or is damaged beyond the point of reading."""


@dataclass
class EventRef:
    """An event chunk located during the index pass, not yet decrypted."""

    event_id: str
    group: str
    metadata: str
    start_time: int
    end_time: int
    offset: int
    size: int


@dataclass
class ReplayInfo:
    file_version: int = 0
    length_ms: int = 0
    network_version: int = 0
    changelist: int = 0
    friendly_name: str = ""
    is_live: bool = False
    recorded_at: Any = None
    is_compressed: bool = False
    is_encrypted: bool = False
    encryption_key: bytes = b""


@dataclass
class ReplayHeader:
    network_version: int = 0
    network_checksum: int = 0
    engine_network_version: int = 0
    game_protocol_version: int = 0
    guid: str = ""
    major: int = 0
    minor: int = 0
    patch: int = 0
    changelist: int = 0
    branch: str = ""
    level_name: str = ""
    game_specific_data: list = field(default_factory=list)
    platform: str = ""

    @property
    def fortnite_version(self) -> str:
        match = _BRANCH_RE.search(self.branch or "")
        return f"{match.group(1)}.{match.group(2)}" if match else ""

    @property
    def verse_roots(self) -> list[str]:
        """Game-feature plugin roots, e.g. ['BRRoot'] or ['CreativeRoot', ...]."""
        for entry in self.game_specific_data:
            if entry.startswith("VerseURI="):
                return [
                    part.rsplit("/", 1)[-1]
                    for part in entry[len("VerseURI=") :].split("+")
                    if part.endswith("Root")
                ]
        return []

    @property
    def mode(self) -> str:
        roots = self.verse_roots
        for root, label in MODE_BY_ROOT:
            if root in roots:
                return label
        return "Unknown"

    @property
    def map_name(self) -> str:
        if not self.level_name:
            return ""
        leaf = self.level_name.rsplit("/", 1)[-1]
        return MAP_NAMES.get(leaf, leaf.replace("_", " "))


@dataclass
class Elimination:
    time_ms: int
    eliminated_id: str
    eliminated_type: str
    eliminator_id: str
    eliminator_type: str
    gun_type: int
    knocked: bool
    eliminated_pos: tuple | None = None
    eliminator_pos: tuple | None = None

    @property
    def is_self_elim(self) -> bool:
        return self.eliminated_id == self.eliminator_id

    @property
    def distance_cm(self) -> float | None:
        """Straight-line distance, or None when either position is unrecorded.

        Storm, fall and disconnect eliminations carry a zeroed eliminator
        location, which would otherwise read as a kill from the map origin.
        """
        a, b = self.eliminated_pos, self.eliminator_pos
        if not a or not b:
            return None
        if not any(a) or not any(b):
            return None
        return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5

    def as_dict(self) -> dict:
        distance = self.distance_cm
        return {
            "time_ms": self.time_ms,
            "eliminated_id": self.eliminated_id,
            "eliminated_type": self.eliminated_type,
            "eliminator_id": self.eliminator_id,
            "eliminator_type": self.eliminator_type,
            "gun_type": self.gun_type,
            "knocked": self.knocked,
            "is_self_elim": self.is_self_elim,
            "distance_m": round(distance / 100.0, 1) if distance else None,
        }


@dataclass
class MatchStats:
    accuracy: float = 0.0
    assists: int = 0
    eliminations: int = 0
    weapon_damage: int = 0
    other_damage: int = 0
    revives: int = 0
    damage_taken: int = 0
    damage_to_structures: int = 0
    materials_gathered: int = 0
    materials_used: int = 0
    total_traveled: int = 0

    @property
    def total_damage(self) -> int:
        return self.weapon_damage + self.other_damage

    def is_empty(self) -> bool:
        """True when Fortnite wrote the block but never filled it in."""
        return (
            self.total_damage == 0
            and self.eliminations == 0
            and self.damage_to_structures == 0
            and self.materials_used == 0
        )

    def as_dict(self) -> dict:
        return {
            "accuracy": self.accuracy,
            "assists": self.assists,
            "eliminations": self.eliminations,
            "weapon_damage": self.weapon_damage,
            "other_damage": self.other_damage,
            "total_damage": self.total_damage,
            "revives": self.revives,
            "damage_taken": self.damage_taken,
            "damage_to_structures": self.damage_to_structures,
            "materials_gathered": self.materials_gathered,
            "materials_used": self.materials_used,
            "total_traveled": self.total_traveled,
        }


@dataclass
class ParsedReplay:
    replay_id: str
    file_name: str
    file_path: str
    file_size: int
    info: ReplayInfo
    header: ReplayHeader
    stats: MatchStats | None = None
    placement: int | None = None
    total_players: int | None = None
    eliminations: list[Elimination] = field(default_factory=list)
    elim_event_count: int = 0
    elim_parse_failures: int = 0

    @property
    def has_stats(self) -> bool:
        return self.stats is not None and not self.stats.is_empty()


class ReplayReader:
    """Reads one .replay file.

    Chunks are indexed first without decrypting anything, so the caller can
    decide how much work to do. Match stats are a couple of hundred bytes;
    the killfeed can be tens of kilobytes of AES per file.
    """

    def __init__(self, data: bytes, file_path: str = ""):
        self.archive = Archive(data)
        self.file_path = file_path
        self.info = ReplayInfo()
        self.header = ReplayHeader()
        self.events: list[EventRef] = []
        self._indexed = False

    # -- container --------------------------------------------------------

    def _read_info(self) -> None:
        ar = self.archive
        magic = ar.read_uint32()
        if magic != FILE_MAGIC:
            raise ReplayError(f"not a replay file (magic {magic:#010x})")

        info = self.info
        info.file_version = ar.read_uint32()
        if info.file_version >= HISTORY_CUSTOM_VERSIONS:
            ar.skip(ar.read_int32() * 20)

        info.length_ms = ar.read_uint32()
        info.network_version = ar.read_uint32()
        info.changelist = ar.read_uint32()
        info.friendly_name = ar.read_fstring().strip()
        info.is_live = ar.read_bool32()

        if info.file_version >= HISTORY_RECORDED_TIMESTAMP:
            info.recorded_at = ar.read_dotnet_datetime()
        if info.file_version >= HISTORY_COMPRESSION:
            info.is_compressed = ar.read_bool32()
        if info.file_version >= HISTORY_ENCRYPTION:
            info.is_encrypted = ar.read_bool32()
            info.encryption_key = ar.read_bytes(ar.read_uint32())

        if info.is_encrypted and not info.encryption_key:
            raise ReplayError("replay is encrypted but carries no key")

    def _read_header_chunk(self, offset: int, size: int) -> None:
        ar = Archive(self.archive.data[offset : offset + size])
        if ar.read_uint32() != NETWORK_MAGIC:
            raise ReplayError("bad network magic in header chunk")

        header = self.header
        header.network_version = ar.read_uint32()
        if header.network_version >= NET_HISTORY_USE_CUSTOM_VERSION:
            ar.skip(ar.read_int32() * 20)

        header.network_checksum = ar.read_uint32()
        header.engine_network_version = ar.read_uint32()
        header.game_protocol_version = ar.read_uint32()

        if header.network_version >= NET_HISTORY_HEADER_GUID:
            header.guid = ar.read_guid()
        if header.network_version >= NET_HISTORY_SAVE_FULL_ENGINE_VERSION:
            header.major = ar.read_uint16()
            header.minor = ar.read_uint16()
            header.patch = ar.read_uint16()
            header.changelist = ar.read_uint32()
            header.branch = ar.read_fstring()
        else:
            header.changelist = ar.read_uint32()

        # Everything past this point is what identifies the mode. It sits at the
        # tail of the header, so a read failure here loses the mode but nothing
        # else, hence the guarded block rather than a hard error.
        try:
            if header.network_version >= NET_HISTORY_RECORDING_METADATA:
                ar.skip(12)  # UE4Version, UE5Version, PackageVersionLicenseeUE

            level_count = ar.read_int32()
            for index in range(level_count):
                name = ar.read_fstring()
                ar.read_uint32()  # level change time
                if index == 0:
                    header.level_name = name

            if header.network_version >= NET_HISTORY_HEADER_FLAGS:
                ar.read_uint32()  # replay header flags

            header.game_specific_data = [ar.read_fstring() for _ in range(ar.read_int32())]

            if header.network_version >= NET_HISTORY_SAVE_PACKAGE_VERSION_UE:
                ar.skip(16)  # min/max record Hz, frame + checkpoint limits
                header.platform = ar.read_fstring()
        except (ReadError, ValueError):
            pass

    def index(self) -> None:
        """Walk the chunk table, recording events and parsing the header."""
        if self._indexed:
            return
        self._read_info()
        ar = self.archive

        while ar.remaining() >= 8:
            chunk_type = ar.read_uint32()
            chunk_size = ar.read_int32()
            offset = ar.pos
            if chunk_size <= 0 or offset + chunk_size > len(ar):
                break  # truncated or corrupt tail, so keep whatever we have

            if chunk_type == CHUNK_HEADER:
                try:
                    self._read_header_chunk(offset, chunk_size)
                except (ReadError, ReplayError):
                    pass
            elif chunk_type == CHUNK_EVENT:
                try:
                    event_id = ar.read_fstring()
                    group = ar.read_fstring()
                    metadata = ar.read_fstring()
                    start_time = ar.read_uint32()
                    end_time = ar.read_uint32()
                    size = ar.read_int32()
                    if 0 < size <= chunk_size:
                        self.events.append(
                            EventRef(event_id, group, metadata, start_time, end_time, ar.pos, size)
                        )
                except ReadError:
                    pass

            ar.seek(offset + chunk_size)

        self._indexed = True

    def _payload(self, ref: EventRef) -> Archive:
        raw = self.archive.data[ref.offset : ref.offset + ref.size]
        if self.info.is_encrypted:
            raw = decrypt_ecb(raw, self.info.encryption_key)
        return Archive(raw, self.header.engine_network_version)

    # -- events -----------------------------------------------------------

    def read_match_stats(self) -> MatchStats | None:
        """Last AthenaMatchStats event wins, since early ones can be placeholders."""
        result = None
        for ref in self.events:
            if ref.metadata != META_MATCH_STATS:
                continue
            try:
                ar = self._payload(ref)
                ar.skip(4)  # unknown leading int, always zero in practice
                candidate = MatchStats(
                    accuracy=ar.read_float(),
                    assists=ar.read_uint32(),
                    eliminations=ar.read_uint32(),
                    weapon_damage=ar.read_uint32(),
                    other_damage=ar.read_uint32(),
                    revives=ar.read_uint32(),
                    damage_taken=ar.read_uint32(),
                    damage_to_structures=ar.read_uint32(),
                    materials_gathered=ar.read_uint32(),
                    materials_used=ar.read_uint32(),
                    total_traveled=ar.read_uint32(),
                )
            except ReadError:
                continue
            # Prefer a populated block over an empty placeholder.
            if result is None or (result.is_empty() and not candidate.is_empty()):
                result = candidate
        return result

    def read_team_stats(self) -> tuple[int, int] | None:
        for ref in self.events:
            if ref.metadata != META_TEAM_STATS:
                continue
            try:
                ar = self._payload(ref)
                ar.skip(4)
                return ar.read_uint32(), ar.read_uint32()
            except ReadError:
                continue
        return None

    @staticmethod
    def _read_elim_transform(ar: Archive) -> tuple[float, float, float]:
        """Read one FTransform, returning just its location.

        Engine net version 34 introduced large-world coordinates, which widened
        transforms from float to double. Both layouts are quat + location +
        scale, so only the component width changes: 40 bytes vs 80.
        """
        if ar.engine_network_version >= 34:
            ar.skip(32)  # rotation quaternion
            location = struct.unpack_from("<3d", ar.data, ar.pos)
            ar.skip(24)
            ar.skip(24)  # scale
        else:
            ar.skip(16)
            location = ar.read_fvector()
            ar.skip(12)
        return location

    def _read_elim_player(self, ar: Archive, version: int) -> tuple[str, str]:
        if version < 6:
            return ar.read_fstring(), "player"
        player_type = ar.read_byte()
        if player_type == PLAYER_TYPE_BOT:
            return "Bot", "bot"
        if player_type == PLAYER_TYPE_NAMED_BOT:
            return ar.read_fstring(), "named_bot"
        if player_type == PLAYER_TYPE_PLAYER:
            return ar.read_guid(ar.read_byte()), "player"
        raise ReadError(f"unknown player type {player_type:#x}")

    def read_eliminations(self) -> tuple[list[Elimination], int, int]:
        """Returns (eliminations, total elim events seen, parse failures)."""
        result: list[Elimination] = []
        seen = failures = 0

        for ref in self.events:
            if ref.group != GROUP_PLAYER_ELIM:
                continue
            seen += 1
            try:
                ar = self._payload(ref)
                version = ar.read_int32()
                eliminated_pos = eliminator_pos = None

                if version >= 3:
                    ar.skip(1)
                    if version >= 6:
                        eliminated_pos = self._read_elim_transform(ar)
                    eliminator_pos = self._read_elim_transform(ar)

                eliminated_id, eliminated_type = self._read_elim_player(ar, version)
                eliminator_id, eliminator_type = self._read_elim_player(ar, version)
                gun_type = ar.read_byte()
                knocked = ar.read_bool32()

                result.append(
                    Elimination(
                        time_ms=ref.start_time,
                        eliminated_id=eliminated_id,
                        eliminated_type=eliminated_type,
                        eliminator_id=eliminator_id,
                        eliminator_type=eliminator_type,
                        gun_type=gun_type,
                        knocked=knocked,
                        eliminated_pos=eliminated_pos,
                        eliminator_pos=eliminator_pos,
                    )
                )
            except (ReadError, struct.error):
                failures += 1

        return result, seen, failures


def compute_replay_id(header: ReplayHeader, info: ReplayInfo, data: bytes) -> str:
    """Stable identity for a replay, so re-importing the same match is a no-op."""
    if header.guid:
        return header.guid
    digest = hashlib.sha1()
    digest.update(str(info.length_ms).encode())
    digest.update(str(info.recorded_at).encode())
    digest.update(data[:4096])
    return digest.hexdigest().upper()


def parse_replay(path: str, with_killfeed: bool = True) -> ParsedReplay:
    """Parse a replay file from disk."""
    with open(path, "rb") as handle:
        data = handle.read()
    return parse_replay_bytes(data, path, with_killfeed)


def parse_replay_bytes(data: bytes, path: str = "", with_killfeed: bool = True) -> ParsedReplay:
    reader = ReplayReader(data, path)
    reader.index()

    replay = ParsedReplay(
        replay_id=compute_replay_id(reader.header, reader.info, data),
        file_name=os.path.basename(path) if path else reader.info.friendly_name,
        file_path=path,
        file_size=len(data),
        info=reader.info,
        header=reader.header,
        stats=reader.read_match_stats(),
    )

    team = reader.read_team_stats()
    if team:
        replay.placement, replay.total_players = team

    if with_killfeed:
        replay.eliminations, replay.elim_event_count, replay.elim_parse_failures = (
            reader.read_eliminations()
        )
    else:
        replay.elim_event_count = sum(1 for e in reader.events if e.group == GROUP_PLAYER_ELIM)

    return replay
