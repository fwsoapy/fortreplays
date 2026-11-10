"""Reader for Unreal Engine's binary serialization format."""

from __future__ import annotations

import struct
from datetime import datetime, timedelta, timezone

# .NET DateTime ticks (100 ns units) between 0001-01-01 and 1970-01-01.
_TICKS_AT_UNIX_EPOCH = 621355968000000000


class ReadError(Exception):
    """Raised when a read runs past the end of the buffer or hits nonsense."""


class Archive:
    """Sequential little-endian reader over an in-memory buffer."""

    __slots__ = ("data", "pos", "engine_network_version")

    def __init__(self, data: bytes, engine_network_version: int = 0):
        self.data = data
        self.pos = 0
        self.engine_network_version = engine_network_version

    def __len__(self) -> int:
        return len(self.data)

    @property
    def at_end(self) -> bool:
        return self.pos >= len(self.data)

    def remaining(self) -> int:
        return len(self.data) - self.pos

    def _take(self, count: int) -> bytes:
        end = self.pos + count
        if count < 0 or end > len(self.data):
            raise ReadError(f"read of {count} bytes at {self.pos} exceeds buffer ({len(self.data)})")
        chunk = self.data[self.pos : end]
        self.pos = end
        return chunk

    def skip(self, count: int) -> None:
        if self.pos + count > len(self.data):
            raise ReadError(f"skip of {count} bytes at {self.pos} exceeds buffer")
        self.pos += count

    def seek(self, pos: int) -> None:
        self.pos = pos

    # -- scalars ----------------------------------------------------------

    def read_bytes(self, count: int) -> bytes:
        return self._take(count)

    def read_byte(self) -> int:
        return self._take(1)[0]

    def read_bool32(self) -> bool:
        return self.read_uint32() != 0

    def read_uint16(self) -> int:
        return struct.unpack_from("<H", self.data, self._advance(2))[0]

    def read_uint32(self) -> int:
        return struct.unpack_from("<I", self.data, self._advance(4))[0]

    def read_int32(self) -> int:
        return struct.unpack_from("<i", self.data, self._advance(4))[0]

    def read_int64(self) -> int:
        return struct.unpack_from("<q", self.data, self._advance(8))[0]

    def read_float(self) -> float:
        return struct.unpack_from("<f", self.data, self._advance(4))[0]

    def _advance(self, count: int) -> int:
        start = self.pos
        if start + count > len(self.data):
            raise ReadError(f"read of {count} bytes at {start} exceeds buffer ({len(self.data)})")
        self.pos = start + count
        return start

    # -- composites -------------------------------------------------------

    def read_fstring(self) -> str:
        """FString: length-prefixed, negative length means UTF-16, includes a NUL."""
        length = self.read_int32()
        if length == 0:
            return ""
        if length < 0:
            raw = self._take(-length * 2)
            return raw[:-2].decode("utf-16-le", "replace")
        raw = self._take(length)
        return raw[:-1].decode("utf-8", "replace")

    def read_fvector(self) -> tuple[float, float, float]:
        return struct.unpack_from("<3f", self.data, self._advance(12))

    def read_fquat(self) -> tuple[float, float, float, float]:
        return struct.unpack_from("<4f", self.data, self._advance(16))

    def read_guid(self, size: int = 16) -> str:
        # Lower case is Epic's canonical form for account ids, and the lookup
        # service treats the two spellings as different accounts.
        return self._take(size).hex()

    def read_dotnet_datetime(self) -> datetime | None:
        """.NET DateTime.FromBinary: top two bits are a kind flag, rest are ticks."""
        raw = self.read_int64()
        ticks = raw & 0x3FFFFFFFFFFFFFFF
        seconds = (ticks - _TICKS_AT_UNIX_EPOCH) / 1e7
        try:
            return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=seconds)
        except (OverflowError, OSError, ValueError):
            return None
