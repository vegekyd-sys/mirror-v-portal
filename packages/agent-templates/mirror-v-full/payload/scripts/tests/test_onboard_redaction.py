"""Run: python3 -m unittest scripts/tests/test_onboard_redaction.py"""
import importlib.util
import pathlib
import unittest

HERE = pathlib.Path(__file__).resolve().parent.parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TableSecrets(unittest.TestCase):
    redact = staticmethod(load("onboard-collect").redact)

    def test_password_columns_are_blanked_and_the_rest_kept(self):
        text = "\n".join(["| 账号 | TT密码 | 绑定邮箱 | 邮箱密码 |", "|-|-|-|-|", "| shop_one | `Ab12+x` | `a@b.co` | — |", "| shop_two | 短 | c@d.co | zz9 |"])
        out, hits = self.redact(text)
        for leaked in ("Ab12", "zz9", "| 短"):
            self.assertNotIn(leaked, out)
        for kept in ("shop_one", "shop_two", "a@b.co", "| — |", "邮箱密码"):
            self.assertIn(kept, out)
        self.assertEqual(sum(h["pattern"] == "table-secret" for h in hits), 3)
        self.assertEqual(self.redact(out)[0], out)  # 再跑一次不变

    def test_next_table_and_prose_are_not_affected(self):
        text = "| 名称 | 密码 |\n|---|---|\n| a | b1c2 |\n\n密码丢失要赔偿。\n\n| 名称 | 价格 |\n|---|---|\n| x | 3000 |"
        out, _ = self.redact(text)
        self.assertNotIn("b1c2", out)
        self.assertIn("3000", out)
        self.assertIn("密码丢失要赔偿", out)


class Titles(unittest.TestCase):
    def test_credential_titles_are_never_read(self):
        x = load("feishu-docs").EXCLUDE_TITLE
        for t in ("某某家纺 · 账号与邮箱（内部）", "邮箱及账号", "后台登录信息"):
            self.assertTrue(x.search(t), t)
        for t in ("TikTok 账号矩阵方案", "账号运营周报", "邮箱营销方案"):
            self.assertFalse(x.search(t), t)


if __name__ == "__main__":
    unittest.main()
