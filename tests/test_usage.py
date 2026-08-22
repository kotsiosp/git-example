from app.services import UsageService
from app.storage import Store


def test_store_metering_and_erase():
    store = Store(":memory:")
    assert store.get_usage("u1") == 0
    assert store.record_inquiry("u1") == 1
    assert store.record_inquiry("u1") == 2
    assert store.get_usage("u1") == 2
    assert store.erase("u1") is True
    assert store.get_usage("u1") == 0
    assert store.erase("u1") is False  # nothing left


def test_premium_flag():
    store = Store(":memory:")
    assert store.is_premium("u1") is False
    store.set_premium("u1", True)
    assert store.is_premium("u1") is True


def test_usage_service_free_limit():
    store = Store(":memory:")
    usage = UsageService(store, free_per_month=3)
    for _ in range(3):
        assert usage.check("u1").allowed
        usage.consume("u1")
    q = usage.check("u1")
    assert q.allowed is False
    assert q.remaining == 0
    assert q.used == 3


def test_usage_service_premium_unlimited():
    store = Store(":memory:")
    store.set_premium("vip", True)
    usage = UsageService(store, free_per_month=3)
    for _ in range(10):
        assert usage.consume("vip").allowed
    q = usage.check("vip")
    assert q.allowed is True
    assert q.remaining == -1  # unlimited
