"""Unit tests for the RipStitch Engine.  Run:  python -m unittest discover tests"""
import importlib.util
import unittest
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent / "docs" / "engine" / "ripstitch_engine.py"
spec = importlib.util.spec_from_file_location("ripstitch_engine", ENGINE)
eng = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eng)

CFG = dict(eng.DEFAULTS, out_dir="/tmp/rs-out")

try:
    import yt_dlp  # noqa: F401
    HAVE_YTDLP = True
except ImportError:
    HAVE_YTDLP = False


class ConfigTests(unittest.TestCase):
    def test_clamps_numbers(self):
        c = eng.validate_config({"workers": 99, "frag_workers": 0})
        self.assertEqual(c["workers"], 8)
        self.assertEqual(c["frag_workers"], 1)

    def test_rejects_bad_choice(self):
        with self.assertRaises(ValueError):
            eng.validate_config({"merge_format": "avi"})

    def test_rejects_escaping_template(self):
        for bad in ("../%(title)s.%(ext)s", "/etc/%(title)s.%(ext)s", "%(title)s"):
            with self.assertRaises(ValueError, msg=bad):
                eng.validate_config({"template": bad})

    def test_rate_limit_format(self):
        self.assertEqual(eng.validate_config({"rate_limit": "5M"})["rate_limit"], "5M")
        with self.assertRaises(ValueError):
            eng.validate_config({"rate_limit": "fast please"})

    def test_ignores_unknown_keys(self):
        self.assertEqual(eng.validate_config({"nope": 1}), {})


class ArgvTests(unittest.TestCase):
    def argv(self, spec, ffmpeg=True, **cfg):
        return eng.download_argv(dict({"url": "https://x"}, **spec), dict(CFG, **cfg), ffmpeg)

    def test_quick_height(self):
        a = self.argv({"mode": "quick", "quality": "720"})
        self.assertIn("bv*[height<=720]+ba/b[height<=720]/bv*+ba/b", a)
        self.assertEqual(a[a.index("--merge-output-format") + 1], "mp4")

    def test_without_ffmpeg_uses_premerged(self):
        a = self.argv({"mode": "quick", "quality": "1080"}, ffmpeg=False)
        self.assertIn("b[height<=1080]/b", a)
        self.assertNotIn("--embed-metadata", a)

    def test_audio(self):
        a = self.argv({"mode": "quick", "quality": "audio"}, audio_codec="opus")
        self.assertIn("-x", a)
        self.assertEqual(a[a.index("--audio-format") + 1], "opus")
        self.assertNotIn("--merge-output-format", a)

    def test_exact_format_merges_audio(self):
        a = self.argv({"mode": "format", "format_id": "137", "needs_audio": True})
        self.assertIn("137+bestaudio/137", a)

    def test_section_names_file_and_cuts(self):
        a = self.argv({"mode": "quick", "quality": "best", "section": {"start": 65, "end": 130.4, "precise": True}})
        self.assertIn("*65.000-130.400", a)
        self.assertIn("--force-keyframes-at-cuts", a)
        tmpl = a[a.index("-o") + 1]
        self.assertTrue(tmpl.endswith(" [1m05s-2m10s].%(ext)s"), tmpl)

    def test_playlist_folder_and_numbering(self):
        a = self.argv({"mode": "quick", "quality": "best", "folder": "My: List?", "index": 7})
        self.assertTrue(a[a.index("-o") + 1].startswith("My_ List_/007 - "))

    def test_compat_sort(self):
        self.assertIn("vcodec:h264,res,acodec:aac", self.argv({"mode": "quick", "quality": "best"}, compat=True))

    @unittest.skipUnless(HAVE_YTDLP, "yt-dlp not installed")
    def test_yt_dlp_accepts_every_variant(self):
        variants = [
            {"mode": "quick", "quality": "best"},
            {"mode": "quick", "quality": "480"},
            {"mode": "quick", "quality": "audio"},
            {"mode": "format", "format_id": "18"},
            {"mode": "quick", "quality": "best", "section": {"start": 1, "end": 2}},
        ]
        cfg = dict(subs=True, embed_thumb=True, sponsorblock=True, archive=True, rate_limit="5M", cookies_from="firefox")
        for v in variants:
            yt_dlp.parse_options(self.argv(v, **cfg))


class SummaryTests(unittest.TestCase):
    def test_video_summary_drops_storyboards_and_flags_merges(self):
        info = {"id": "a", "title": "T", "extractor_key": "Youtube", "duration": 10, "formats": [
            {"format_id": "sb0", "ext": "mhtml", "format_note": "storyboard", "vcodec": "none", "acodec": "none"},
            {"format_id": "140", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2", "abr": 129},
            {"format_id": "137", "ext": "mp4", "vcodec": "avc1.640028", "acodec": "none", "height": 1080, "width": 1920},
        ]}
        s = eng.summarize(info)
        self.assertEqual([f["format_id"] for f in s["formats"]], ["137", "140"])  # best first
        self.assertTrue(s["formats"][0]["needs_audio"])
        self.assertTrue(s["formats"][1]["video_absent"])

    def test_playlist_summary(self):
        s = eng.summarize({"_type": "playlist", "title": "P", "entries": [
            {"url": "https://www.youtube.com/watch?v=1", "title": "one", "duration": 5}, None]})
        self.assertEqual(s["kind"], "playlist")
        self.assertEqual(s["count"], 1)


class OriginTests(unittest.TestCase):
    def test_origins(self):
        eng.CFG.update(eng.DEFAULTS)
        self.assertTrue(eng.origin_allowed("https://mattymattmattmatt.github.io"))
        self.assertTrue(eng.origin_allowed("http://127.0.0.1:8731"))
        self.assertTrue(eng.origin_allowed("http://localhost:5500"))
        self.assertFalse(eng.origin_allowed("https://evil.example"))
        self.assertFalse(eng.origin_allowed("null"))
        self.assertFalse(eng.origin_allowed(None))


class InstallerHelperTests(unittest.TestCase):
    def test_version_compare(self):
        self.assertGreater(eng.vtuple("1.10.0"), eng.vtuple("1.9.9"))
        self.assertEqual(eng.vtuple("1.1"), (1, 1))

    def test_manual_install_kind_without_marker(self):
        self.assertEqual(eng.install_kind(), "manual")

    def test_console_python_leaves_normal_interpreters_alone(self):
        self.assertEqual(eng.console_python("/usr/bin/python3"), Path("/usr/bin/python3"))

    def test_auto_update_on_by_default(self):
        self.assertTrue(eng.DEFAULTS["auto_update"])
        self.assertFalse(eng.validate_config({"auto_update": 0})["auto_update"])


if __name__ == "__main__":
    unittest.main()
