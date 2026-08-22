"""Weekly (configurable) background scheduler that re-scans official sources.

Runs the (blocking, network-bound) ingest in a worker thread so the event loop stays
responsive, then reloads the knowledge base in place so live services pick up new content
without a restart. Errors in one run are logged and never stop the schedule.
"""
from __future__ import annotations

import asyncio
import logging

from ..config import Settings
from ..rag import KnowledgeBase
from .pipeline import IngestReport, run_ingest

logger = logging.getLogger("cyprus_agent.ingest")


class IngestScheduler:
    def __init__(self, settings: Settings, kb: KnowledgeBase):
        self.settings = settings
        self.kb = kb
        self.last_report: IngestReport | None = None
        self._task: asyncio.Task | None = None

    def run_sync(self) -> IngestReport:
        """Fetch all sources and reload the KB. Blocking — call via a thread in async code."""
        report = run_ingest(self.settings)
        try:
            n = self.kb.reload()
            logger.info("Ingest complete: %s ok, %s changed, %s errors; KB now %s docs",
                        report.ok_count, report.changed_count, report.error_count, n)
        except Exception:  # pragma: no cover - reload should not normally fail
            logger.exception("KB reload after ingest failed")
        self.last_report = report
        return report

    async def _loop(self) -> None:
        interval = max(1, self.settings.ingest_interval_hours) * 3600
        try:
            if self.settings.ingest_on_startup:
                await asyncio.sleep(5)
                await self._safe_run()
            while True:
                await asyncio.sleep(interval)
                await self._safe_run()
        except asyncio.CancelledError:  # pragma: no cover - shutdown path
            pass

    async def _safe_run(self) -> None:
        try:
            await asyncio.to_thread(self.run_sync)
        except Exception:  # pragma: no cover - defensive; keep the schedule alive
            logger.exception("Scheduled ingest run failed")

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())
            logger.info("Ingest scheduler started (every %sh)", self.settings.ingest_interval_hours)

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
