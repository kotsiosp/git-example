"""Freemium metering (Phase 4): N free inquiries per user per month, then premium.

An "inquiry" is a billable action — a Q&A answer, a generated checklist, or a filled
form. Menu navigation, help, and GDPR commands are free and never metered.
"""
from __future__ import annotations

from dataclasses import dataclass

from ..storage import Store


@dataclass
class Quota:
    allowed: bool
    used: int
    limit: int
    premium: bool

    @property
    def remaining(self) -> int:
        if self.premium:
            return -1  # unlimited
        return max(0, self.limit - self.used)


class UsageService:
    def __init__(self, store: Store, free_per_month: int):
        self.store = store
        self.free_per_month = free_per_month

    def check(self, user_id: str) -> Quota:
        """Return the user's quota status WITHOUT consuming an inquiry."""
        premium = self.store.is_premium(user_id)
        used = self.store.get_usage(user_id)
        allowed = premium or used < self.free_per_month
        return Quota(allowed=allowed, used=used, limit=self.free_per_month, premium=premium)

    def consume(self, user_id: str) -> Quota:
        """Record one inquiry and return the resulting quota.

        Premium users are recorded (for analytics) but never limited.
        """
        premium = self.store.is_premium(user_id)
        used = self.store.record_inquiry(user_id)
        allowed = premium or used <= self.free_per_month
        return Quota(allowed=allowed, used=used, limit=self.free_per_month, premium=premium)
