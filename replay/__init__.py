"""Fortnite .replay parsing (event-chunk layer), pure standard library."""

from .parser import (
    Elimination,
    MatchStats,
    ParsedReplay,
    ReplayError,
    parse_replay,
    parse_replay_bytes,
)

__all__ = [
    "Elimination",
    "MatchStats",
    "ParsedReplay",
    "ReplayError",
    "parse_replay",
    "parse_replay_bytes",
]
