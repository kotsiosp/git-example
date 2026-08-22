"""SQLite persistence for freemium metering, premium flags, and GDPR erasure.

Deliberately tiny and dependency-free (stdlib ``sqlite3``). It stores only what the
freemium model needs: a per-user monthly inquiry counter and a premium flag, keyed by the
user's WhatsApp number (or any channel id). No message content is persisted.

For a single-instance deployment SQLite is plenty; swap ``Store`` for a Postgres/Redis
implementation behind the same interface for horizontal scaling.
"""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path


def _current_period() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


class Store:
    def __init__(self, db_path: Path | str):
        db_path = Path(db_path)
        if db_path.parent and str(db_path) != ":memory:":
            db_path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False + a lock: safe for FastAPI's threadpool.
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock, self._conn:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    user_id    TEXT PRIMARY KEY,
                    premium    INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS usage (
                    user_id TEXT NOT NULL,
                    period  TEXT NOT NULL,
                    count   INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (user_id, period)
                );
                """
            )

    def _ensure_user(self, user_id: str) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO users (user_id, created_at) VALUES (?, ?)",
            (user_id, datetime.now(timezone.utc).isoformat()),
        )

    # -- usage ---------------------------------------------------------------
    def get_usage(self, user_id: str, period: str | None = None) -> int:
        period = period or _current_period()
        with self._lock:
            row = self._conn.execute(
                "SELECT count FROM usage WHERE user_id = ? AND period = ?",
                (user_id, period),
            ).fetchone()
        return int(row["count"]) if row else 0

    def record_inquiry(self, user_id: str, period: str | None = None) -> int:
        """Increment and return the user's inquiry count for the period."""
        period = period or _current_period()
        with self._lock, self._conn:
            self._ensure_user(user_id)
            self._conn.execute(
                """
                INSERT INTO usage (user_id, period, count) VALUES (?, ?, 1)
                ON CONFLICT(user_id, period) DO UPDATE SET count = count + 1
                """,
                (user_id, period),
            )
            row = self._conn.execute(
                "SELECT count FROM usage WHERE user_id = ? AND period = ?",
                (user_id, period),
            ).fetchone()
        return int(row["count"])

    # -- premium -------------------------------------------------------------
    def is_premium(self, user_id: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT premium FROM users WHERE user_id = ?", (user_id,)
            ).fetchone()
        return bool(row and row["premium"])

    def set_premium(self, user_id: str, premium: bool = True) -> None:
        with self._lock, self._conn:
            self._ensure_user(user_id)
            self._conn.execute(
                "UPDATE users SET premium = ? WHERE user_id = ?",
                (1 if premium else 0, user_id),
            )

    # -- GDPR ----------------------------------------------------------------
    def erase(self, user_id: str) -> bool:
        """Delete all stored data for a user. Returns True if anything was removed."""
        with self._lock, self._conn:
            cur = self._conn.execute("DELETE FROM usage WHERE user_id = ?", (user_id,))
            removed = cur.rowcount
            cur = self._conn.execute("DELETE FROM users WHERE user_id = ?", (user_id,))
            removed += cur.rowcount
        return removed > 0

    def close(self) -> None:
        with self._lock:
            self._conn.close()
