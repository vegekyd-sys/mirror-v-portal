import importlib.util, time, unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("feishu_docs", Path(__file__).parents[1] / "feishu-docs.py")
f = importlib.util.module_from_spec(spec); spec.loader.exec_module(f)


def row(space, title, days, i):
    return {"space_id": space, "space": space, "path": title, "depth": 0, "title": title, "node_token": f"{space}{i}",
            "edit": str(int(time.time() - days * 86400 - i * 90000)), "fetchable": True, "excluded": None}


class Rank(unittest.TestCase):
    def test_a_space_untouched_for_a_year_gets_a_few_slots_and_goes_last(self):
        word = lambda i: "".join(chr(0x4E00 + (i * 7 + k * 131) % 5000) for k in range(6))
        rows = ([row("old", "OKR " + word(i), 1500, i) for i in range(13)]
                + [row("wiki", "星擎" + word(100 + i), 10, i) for i in range(3)]
                + [row(f.DRIVE["space_id"], word(200 + i), 1, i) for i in range(400)])
        f.rank(rows)
        deep = [r for r in rows if r["tier"] == "deep"]
        self.assertEqual(len(deep), f.DEEP_LIMIT)
        self.assertEqual(sum(r["space_id"] == "old" for r in deep), f.STALE_KEEP)
        self.assertEqual(sum(r["space_id"] == "wiki" for r in deep), 3)
        self.assertTrue(all(r["stale"] == (r["space_id"] == "old") for r in rows))
        self.assertTrue(all(r["why"] for r in rows if r["tier"] == "catalog"))

    def test_an_old_wiki_is_read_in_full_when_it_is_all_there_is(self):
        word = lambda i: "".join(chr(0x4E00 + (i * 7 + k * 131) % 5000) for k in range(6))
        rows = [row("old", word(i), 1500, i) for i in range(40)]
        f.rank(rows)
        self.assertEqual(sum(r["tier"] == "deep" for r in rows), 40)


if __name__ == "__main__":
    unittest.main()
