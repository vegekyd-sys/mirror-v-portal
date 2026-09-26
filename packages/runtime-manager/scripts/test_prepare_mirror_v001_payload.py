import importlib.util
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("prepare-mirror-v001-payload.py")
spec = importlib.util.spec_from_file_location("prepare_mirror_v001", SCRIPT)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)


class PrepareMirrorV001Tests(unittest.TestCase):
    def test_builds_isolated_identity_and_retrievable_memory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "source"
            root.mkdir()
            for name in module.CORE:
                (root / name).write_text("V from Versa knows Makaron.\n", encoding="utf-8")
            (root / "memory").mkdir()
            (root / "memory" / "makaron.md").write_text("Makaron is a creative product.\n")
            (root / "memory" / "secret.md").write_text("export MAKARON_API_KEY=test-secret-value\n")
            (root / "memory" / "clip.mp4").write_bytes(b"video")
            (root / "skills").mkdir()
            (root / "skills" / "SKILL.md").write_text("Use the available tool.\n")
            output = Path(temp) / "payload.tar"
            report = module.prepare(root, output)
            self.assertEqual(report["version"], module.VERSION)
            self.assertGreaterEqual(report["redaction_count"], 1)
            with tarfile.open(output) as archive:
                names = set(archive.getnames())
                self.assertIn("memory/makaron.md", names)
                self.assertNotIn("memory/clip.mp4", names)
                identity = archive.extractfile("IDENTITY.md").read().decode()
                self.assertIn("Mirror V", identity)
                self.assertNotIn("V from Versa is the public", identity)
                secret = archive.extractfile("memory/secret.md").read().decode()
                self.assertIn("<redacted>", secret)
                self.assertNotIn("test-secret-value", secret)
                manifest = json.load(archive.extractfile("payload-manifest.json"))
                self.assertEqual(manifest["version"], module.VERSION)

    def test_rejects_private_key_document(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in module.CORE:
                (root / name).write_text("normal\n")
            (root / "AGENTS.md").write_text("-----BEGIN PRIVATE KEY-----\n")
            with self.assertRaisesRegex(ValueError, "credential"):
                module.prepare(root, root / "out.tar")


if __name__ == "__main__":
    unittest.main()
