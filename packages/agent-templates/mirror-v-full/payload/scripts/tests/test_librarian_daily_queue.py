import datetime as dt, importlib.util, tempfile, unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location("daily_queue", Path(__file__).parents[1] / "librarian-daily-queue.py")
q = importlib.util.module_from_spec(spec); spec.loader.exec_module(q)


class FakeNow(dt.datetime):
    at = None

    @classmethod
    def now(cls, tz=None):
        return cls.at.astimezone(tz) if tz else cls.at.replace(tzinfo=None)


class FirstDay(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.memory = Path(self.tmp.name)
        patcher = mock.patch.object(q, "MEMORY", self.memory)
        patcher.start(); self.addCleanup(patcher.stop); self.addCleanup(self.tmp.cleanup)

    def first_day_at(self, utc):
        FakeNow.at = utc
        with mock.patch.object(q.dt, "datetime", FakeNow):
            return q.first_log_day()

    def test_a_tenant_opened_after_midnight_shanghai_keeps_the_utc_dated_first_log(self):
        # 2026-11-26 01:49 in Shanghai is still 11-25 in UTC; the first log may be named 2026-11-25.
        since = self.first_day_at(dt.datetime(2026, 11, 25, 17, 49, tzinfo=dt.timezone.utc))
        self.assertEqual(since, "2026-11-25")
        (self.memory / "2026-11-25.md").write_text("## 主人自述\n小林，上海做面料外贸\n")
        FakeNow.at = dt.datetime(2026, 11, 26, 13, 0, tzinfo=dt.timezone.utc)  # that night, 21:00 Shanghai
        with mock.patch.object(q.dt, "datetime", FakeNow):
            items = q.queue({"since": since, "backfill_days": [], "done": {}}, "daily")
        self.assertEqual([i["id"] for i in items], ["2026-11-25#主人自述"])

    def test_daytime_start_is_today(self):
        self.assertEqual(self.first_day_at(dt.datetime(2026, 11, 26, 3, 0, tzinfo=dt.timezone.utc)), "2026-11-26")

    def test_an_existing_log_wins(self):
        (self.memory / "2026-10-02.md").write_text("x")
        self.assertEqual(self.first_day_at(dt.datetime(2026, 11, 26, 3, 0, tzinfo=dt.timezone.utc)), "2026-10-02")


if __name__ == "__main__":
    unittest.main()
