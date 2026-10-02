#!/usr/bin/env python3
"""
RipStitch Engine: the local helper behind the Rip tab of RipStitch.

It runs on your own computer, listens on 127.0.0.1 only, and drives yt-dlp so
the RipStitch web app can read links and save videos straight to your disk.
Nothing is uploaded anywhere; the only traffic is the download itself.

    python ripstitch_engine.py              start the engine and open the app
    python ripstitch_engine.py --background run quietly (what the installers use)
    python ripstitch_engine.py --stop       stop a running engine
    python ripstitch_engine.py --help       every option

Standard library only. yt-dlp is installed on first run if it is missing,
into a private environment that never touches your system Python.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import platform
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from collections import OrderedDict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

VERSION = "1.1.0"
DEFAULT_PORT = 8731
APP_URL = os.environ.get("RIPSTITCH_APP_URL") or "https://mattymattmattmatt.github.io/RipStitch/"
TRUSTED_ORIGINS = {"https://mattymattmattmatt.github.io"}
ENGINE_PATH = Path(__file__).resolve()
APP_DIR = ENGINE_PATH.parent.parent        # installed layout: <app>/engine, <app>/bin, <app>/python
IS_WIN = os.name == "nt"
IS_MAC = sys.platform == "darwin"
NO_WINDOW = {"creationflags": 0x08000000} if IS_WIN else {}  # CREATE_NO_WINDOW


# --------------------------------------------------------------------------
# paths & config
# --------------------------------------------------------------------------
def config_dir() -> Path:
    if os.environ.get("RIPSTITCH_HOME"):          # the desktop app keeps its own settings and history
        return Path(os.environ["RIPSTITCH_HOME"])
    if IS_WIN:
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        return base / "RipStitch"
    if IS_MAC:
        return Path.home() / "Library" / "Application Support" / "RipStitch"
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "ripstitch"


CONF_DIR = config_dir()
CONF_FILE = CONF_DIR / "config.json"
JOBS_FILE = CONF_DIR / "history.json"
ARCHIVE_FILE = CONF_DIR / "archive.txt"
VENV_DIR = CONF_DIR / "runtime"
LOG_FILE = CONF_DIR / "engine.log"
STATE_FILE = CONF_DIR / "state.json"


def install_kind() -> str:
    """How this engine got here: the Windows app, the Mac/Linux install script, or by hand."""
    try:
        return json.loads((APP_DIR / "installed.json").read_text("utf-8-sig")).get("kind") or "manual"
    except Exception:
        return "manual"


def prepare_path() -> None:
    """Put bundled and commonly-installed tools on PATH, so yt-dlp finds FFmpeg and Deno even when
    started at login (where PATH is minimal)."""
    extra = [APP_DIR / "bin", Path.home() / ".deno" / "bin"]
    if not IS_WIN:
        extra += [Path("/opt/homebrew/bin"), Path("/usr/local/bin"), Path("/usr/bin")]
    have = os.environ.get("PATH", "").split(os.pathsep)
    add = [str(d) for d in extra if d.is_dir() and str(d) not in have]
    if add:
        os.environ["PATH"] = os.pathsep.join(add + have)


def console_python(p) -> Path:
    """pythonw.exe has no console streams; child processes use its python.exe sibling (window hidden)."""
    p = Path(p)
    if IS_WIN and p.name.lower() == "pythonw.exe" and p.with_name("python.exe").exists():
        return p.with_name("python.exe")
    return p


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text("utf-8"))
    except Exception:
        return {}


def save_state(st: dict) -> None:
    try:
        CONF_DIR.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(st), "utf-8")
    except OSError:
        pass

DEFAULTS = {
    "out_dir": str(Path.home() / "Downloads" / "RipStitch"),
    "workers": 2,
    "frag_workers": 4,
    "merge_format": "mp4",
    "audio_codec": "mp3",
    "template": "%(title).150B [%(id)s].%(ext)s",
    "sub_langs": "en.*,en",
    "rate_limit": "",
    "cookies_from": "",
    "subs": False,
    "embed_subs": True,
    "embed_thumb": False,
    "embed_meta": True,
    "sponsorblock": False,
    "archive": False,
    "compat": False,
    "auto_update": True,
    "extra_origins": [],
}
CHOICES = {
    "merge_format": ("mp4", "mkv", "webm"),
    "audio_codec": ("mp3", "m4a", "opus", "flac", "wav"),
    "cookies_from": ("", "chrome", "edge", "firefox", "brave", "vivaldi", "opera", "safari", "chromium"),
}
CFG_LOCK = threading.RLock()
CFG: dict = {}


def load_config() -> None:
    data = {}
    try:
        data = json.loads(CONF_FILE.read_text("utf-8"))
    except FileNotFoundError:
        pass
    except Exception as e:  # corrupt file: keep defaults, say so
        print(f"  ! config unreadable ({e}); using defaults")
    cfg = dict(DEFAULTS)
    try:
        cfg.update(validate_config(data, partial=True))
    except ValueError as e:
        print(f"  ! ignoring bad config value: {e}")
    with CFG_LOCK:
        CFG.clear()
        CFG.update(cfg)


def save_config() -> None:
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    with CFG_LOCK:
        tmp = CONF_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(CFG, indent=2), "utf-8")
        os.replace(tmp, CONF_FILE)


def validate_config(data: dict, partial: bool = False) -> dict:
    """Return a clean copy of the known keys in `data`; raise ValueError on nonsense."""
    out = {}
    for k, v in (data or {}).items():
        if k not in DEFAULTS:
            continue
        d = DEFAULTS[k]
        if isinstance(d, bool):
            out[k] = bool(v)
        elif isinstance(d, int):
            try:
                v = int(v)
            except (TypeError, ValueError):
                raise ValueError(f"{k} must be a number")
            lo, hi = (1, 8) if k == "workers" else (1, 16)
            out[k] = max(lo, min(hi, v))
        elif isinstance(d, list):
            if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
                raise ValueError(f"{k} must be a list of origins")
            out[k] = [x.strip().rstrip("/") for x in v if x.strip()]
        else:
            v = "" if v is None else str(v).strip()
            if k in CHOICES and v not in CHOICES[k]:
                raise ValueError(f"{k} must be one of: {', '.join(c or '(none)' for c in CHOICES[k])}")
            if k == "out_dir":
                if not v:
                    raise ValueError("Output folder can't be empty")
                v = str(Path(os.path.expandvars(os.path.expanduser(v))).resolve())
            if k == "rate_limit" and v and not re.fullmatch(r"\d+(\.\d+)?\s*[KMGkmg]?", v):
                raise ValueError("Speed cap looks like 5M, 800K or 2.5M")
            if k == "template":
                if not v:
                    v = DEFAULTS["template"]
                if "%(ext)s" not in v:
                    raise ValueError("File name template must end with .%(ext)s")
                if os.path.isabs(v) or ".." in Path(v).parts:
                    raise ValueError("File name template must stay inside the output folder")
            if k == "sub_langs" and not v:
                v = DEFAULTS["sub_langs"]
            out[k] = v
    return out


# --------------------------------------------------------------------------
# yt-dlp runtime: which Python has it, and installing / updating it
# --------------------------------------------------------------------------
RUNTIME = {"py": None, "ytdlp": None, "where": None}
RUNTIME_LOCK = threading.Lock()


def venv_python() -> Path:
    return VENV_DIR / ("Scripts/python.exe" if IS_WIN else "bin/python")


def ytdlp_version(py) -> str | None:
    try:
        r = subprocess.run(
            [str(py), "-c", "import sys,yt_dlp;sys.stdout.write(yt_dlp.version.__version__)"],
            capture_output=True, text=True, timeout=60, **NO_WINDOW)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except Exception:
        pass
    return None


def find_runtime() -> None:
    with RUNTIME_LOCK:
        me = console_python(sys.executable)
        mine = "bundled" if APP_DIR / "python" in me.parents else "system"
        for py, where in ((venv_python(), "private"), (me, mine)):
            if py.exists():
                v = ytdlp_version(py)
                if v:
                    RUNTIME.update(py=str(py), ytdlp=v, where=where)
                    return
        RUNTIME.update(py=None, ytdlp=None, where=None)


def _pip(py, *args, timeout=600) -> tuple[bool, str]:
    cmd = [str(py), "-m", "pip", "install", "--disable-pip-version-check", "--upgrade", *args]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **NO_WINDOW)
        return r.returncode == 0, (r.stdout + r.stderr).strip()
    except Exception as e:
        return False, str(e)


def install_ytdlp(echo=None) -> tuple[bool, str]:
    """Install or upgrade yt-dlp. Prefers a private venv so system Python stays untouched."""
    with UPDATE_LOCK:
        return _install_ytdlp(echo)


UPDATE_LOCK = threading.Lock()


def _install_ytdlp(echo=None) -> tuple[bool, str]:
    say = echo or (lambda s: None)
    log = []
    pkg = "yt-dlp[default]"
    me = console_python(sys.executable)
    if RUNTIME["where"] in ("system", "bundled"):
        ok, out = _pip(me, pkg)
        log.append(out)
        if ok:
            find_runtime()
            return True, "\n".join(log)
        say("System Python refused the upgrade; switching to a private runtime…")
    vpy = venv_python()
    if not vpy.exists():
        say(f"Creating a private Python runtime in {VENV_DIR} …")
        try:
            import venv
            venv.EnvBuilder(with_pip=True, clear=False).create(VENV_DIR)
        except Exception as e:
            log.append(f"venv unavailable ({e}); falling back to pip --user")
            ok, out = _pip(me, "--user", pkg)
            log.append(out)
            find_runtime()
            return ok and bool(RUNTIME["py"]), "\n".join(log)
    say("Installing yt-dlp (this takes a moment)…")
    ok, out = _pip(vpy, "pip")
    ok, out = _pip(vpy, pkg)
    log.append(out)
    find_runtime()
    return ok and bool(RUNTIME["py"]), "\n".join(log)


TOOLS = {"ffmpeg": None, "ffmpeg_version": None, "js": None, "checked": 0}


def check_tools(force=False) -> None:
    if not force and time.time() - TOOLS["checked"] < 30:
        return
    ff = shutil.which("ffmpeg")
    ver = None
    if ff:
        try:
            r = subprocess.run([ff, "-hide_banner", "-version"], capture_output=True, text=True, timeout=15, **NO_WINDOW)
            m = re.search(r"ffmpeg version (\S+)", r.stdout)
            ver = m.group(1) if m else "unknown"
        except Exception:
            ver = "unknown"
    js = next((n for n in ("deno", "node", "bun") if shutil.which(n)), None)
    TOOLS.update(ffmpeg=bool(ff and shutil.which("ffprobe")), ffmpeg_version=ver, js=js, checked=time.time())


# --------------------------------------------------------------------------
# worker mode: runs under the yt-dlp Python, talks JSON lines on stdout
# --------------------------------------------------------------------------
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def worker_main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=False)
    except Exception:
        pass
    out_lock = threading.Lock()

    def emit(**kw):
        line = json.dumps(kw, ensure_ascii=False, default=str)
        with out_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def clean(msg):
        msg = ANSI.sub("", str(msg))
        return re.sub(r"^(ERROR|WARNING):\s*", "", msg).strip()

    try:
        spec = json.loads(sys.stdin.read())
        import yt_dlp
        from yt_dlp.postprocessor.common import PostProcessor
    except Exception as e:
        emit(t="error", msg=f"engine worker could not start: {e}")
        return 2

    class Log:
        def debug(self, msg):
            if not msg.startswith("[debug] "):
                emit(t="log", level="info", msg=clean(msg))

        def info(self, msg):
            emit(t="log", level="info", msg=clean(msg))

        def warning(self, msg):
            emit(t="log", level="warn", msg=clean(msg))

        def error(self, msg):
            emit(t="log", level="error", msg=clean(msg))

    try:
        opts = yt_dlp.parse_options(spec["argv"]).ydl_opts
    except SystemExit:
        emit(t="error", msg="yt-dlp rejected the options (try updating yt-dlp)")
        return 2
    opts.update(logger=Log(), noprogress=True, color={"stdout": "no_color", "stderr": "no_color"})

    if spec["action"] == "probe":
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.sanitize_info(ydl.extract_info(spec["url"], download=False))
            emit(t="result", data=summarize(info))
            return 0
        except Exception as e:
            emit(t="error", msg=clean(e))
            return 1

    seen_files: list = []
    last = [0.0]

    def hook(d):
        fn = d.get("filename") or d.get("tmpfilename")
        if fn and fn not in seen_files:
            seen_files.append(fn)
        st = d.get("status")
        now = time.monotonic()
        if st == "downloading" and now - last[0] < 0.25:
            return
        last[0] = now
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        emit(t="progress", status=st, downloaded=d.get("downloaded_bytes"), total=total,
             estimated=not d.get("total_bytes"), speed=d.get("speed"), eta=d.get("eta"),
             frag_i=d.get("fragment_index"), frag_n=d.get("fragment_count"),
             stream=max(1, len(seen_files)), elapsed=d.get("elapsed"))

    def pphook(d):
        emit(t="pp", name=d.get("postprocessor"), status=d.get("status"))

    class Before(PostProcessor):
        def run(self, info):
            fmts = info.get("requested_formats") or [info]
            streams = []
            for f in fmts:
                kind = "audio" if f.get("vcodec") == "none" else "video" if f.get("acodec") == "none" else "av"
                streams.append({"id": f.get("format_id"), "kind": kind, "ext": f.get("ext")})
            emit(t="meta", id=info.get("id"), title=info.get("title"), thumb=best_thumb(info),
                 duration=info.get("duration"), extractor=info.get("extractor_key"),
                 width=info.get("width"), height=info.get("height"), streams=streams)
            return [], info

    class After(PostProcessor):
        def run(self, info):
            emit(t="file", path=info.get("filepath"))
            return [], info

    opts["progress_hooks"] = [hook]
    opts["postprocessor_hooks"] = [pphook]
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.add_post_processor(Before(ydl), when="before_dl")
            ydl.add_post_processor(After(ydl), when="after_move")
            code = ydl.download([spec["url"]])
        emit(t="exit", code=code)
        return 0 if not code else 1
    except Exception as e:
        emit(t="error", msg=clean(e))
        return 1


def best_thumb(info):
    if info.get("thumbnail"):
        return info["thumbnail"]
    th = [t for t in (info.get("thumbnails") or []) if t.get("url")]
    return th[-1]["url"] if th else None


def summarize(info: dict) -> dict:
    """Trim yt-dlp's huge info dict down to what the app shows."""
    kind = "playlist" if info.get("_type") in ("playlist", "multi_video") else "video"
    base = {
        "kind": kind, "id": info.get("id"), "title": info.get("title") or info.get("id") or "Untitled",
        "uploader": info.get("uploader") or info.get("channel") or info.get("playlist_uploader"),
        "extractor": info.get("extractor_key") or info.get("extractor"),
        "webpage_url": info.get("webpage_url") or info.get("original_url"),
        "thumb": best_thumb(info),
    }
    if kind == "playlist":
        entries = []
        for e in info.get("entries") or []:
            if not e:
                continue
            url = e.get("url") if str(e.get("url") or "").startswith("http") else e.get("webpage_url") or e.get("url")
            entries.append({"url": url, "id": e.get("id"), "title": e.get("title") or e.get("id") or "Untitled",
                            "duration": e.get("duration"), "thumb": best_thumb(e),
                            "uploader": e.get("uploader") or e.get("channel")})
        base.update(entries=entries, count=len(entries))
        return base
    fmts = []
    for f in reversed(info.get("formats") or [info]):
        if f.get("format_note") == "storyboard" or f.get("ext") == "mhtml" or str(f.get("protocol") or "").startswith("mhtml"):
            continue
        vc, ac = f.get("vcodec"), f.get("acodec")
        no_v, no_a = vc == "none", ac == "none"
        size = f.get("filesize")
        fmts.append({
            "format_id": f.get("format_id"), "ext": f.get("ext"),
            "width": None if no_v else f.get("width"), "height": None if no_v else f.get("height"),
            "fps": f.get("fps"), "vcodec": None if vc in (None, "none") else vc,
            "acodec": None if ac in (None, "none") else ac,
            "video_absent": no_v, "audio_absent": no_a, "needs_audio": (not no_v) and no_a,
            "abr": f.get("abr"), "vbr": f.get("vbr"), "tbr": f.get("tbr"), "asr": f.get("asr"),
            "filesize": size or f.get("filesize_approx"), "exact_size": bool(size),
            "protocol": f.get("protocol"), "note": f.get("format_note"), "lang": f.get("language"),
            "hdr": f.get("dynamic_range"),
        })
    subs = sorted((info.get("subtitles") or {}).keys())
    base.update(
        formats=fmts, duration=info.get("duration"), view_count=info.get("view_count"),
        like_count=info.get("like_count"), upload_date=info.get("upload_date"),
        is_live=info.get("live_status") == "is_live" or bool(info.get("is_live")),
        chapters=[{"start": c.get("start_time"), "end": c.get("end_time"), "title": c.get("title")}
                  for c in (info.get("chapters") or []) if c.get("start_time") is not None],
        subtitles=subs[:60], auto_captions=len(info.get("automatic_captions") or {}),
        description=(info.get("description") or "")[:400],
    )
    return base


# --------------------------------------------------------------------------
# jobs
# --------------------------------------------------------------------------
PP_LABEL = {
    "Merger": "Merging video + audio", "FFmpegMerger": "Merging video + audio",
    "ExtractAudio": "Converting audio", "FFmpegExtractAudio": "Converting audio",
    "EmbedThumbnail": "Embedding thumbnail", "FFmpegThumbnailsConvertor": "Converting thumbnail",
    "FFmpegMetadata": "Writing metadata", "Metadata": "Writing metadata",
    "FFmpegEmbedSubtitle": "Embedding subtitles", "EmbedSubtitle": "Embedding subtitles",
    "FFmpegSubtitlesConvertor": "Converting subtitles", "SponsorBlock": "Finding sponsor segments",
    "ModifyChapters": "Cutting sponsor segments", "FFmpegFixupM3u8": "Fixing container",
    "FFmpegFixupM4a": "Fixing container", "FFmpegFixupStretched": "Fixing aspect ratio",
    "FFmpegFixupTimestamp": "Fixing timestamps", "FFmpegFixupDuration": "Fixing duration",
    "FFmpegCopyStream": "Copying streams", "FFmpegVideoRemuxer": "Remuxing",
    "FFmpegVideoConvertor": "Converting video", "MoveFiles": "Finishing", "MoveFilesAfterDownload": "Finishing",
}
TERMINAL = ("done", "error", "cancelled")


class Job:
    _n = 0
    _n_lock = threading.Lock()

    def __init__(self, spec: dict):
        with Job._n_lock:
            Job._n += 1
            n = Job._n
        self.id = f"{int(time.time()) % 100000:05d}{n:03d}"
        self.spec = spec
        self.url = spec["url"]
        self.title = spec.get("title") or spec["url"]
        self.thumb = spec.get("thumb")
        self.label = spec.get("label") or ""
        self.kind = "audio" if spec.get("quality") == "audio" else "video"
        self.created = time.time()
        self.proc = None
        self.log: list = []
        self.reset()

    def reset(self):
        self.status = "queued"
        self.pct = 0.0
        self.downloaded = 0
        self.total = None
        self.estimated = False
        self.speed = None
        self.eta = None
        self.frag = None
        self.stream = 1
        self.streams = 1
        self.stage = ""
        self.error = None
        self.started = None
        self.finished = None
        self.dest = None
        self.size = None
        self.note = None
        self.cancel = False
        self.bytes_done_streams = 0

    def add_log(self, level, msg):
        msg = (msg or "").rstrip()
        if not msg:
            return
        self.log.append({"level": level, "msg": msg, "ts": round(time.time(), 2)})
        if len(self.log) > 600:
            del self.log[:100]

    def public(self) -> dict:
        dest_ok = bool(self.dest and os.path.isfile(self.dest))
        return {
            "id": self.id, "url": self.url, "title": self.title, "thumb": self.thumb, "label": self.label,
            "kind": self.kind, "status": self.status, "pct": round(self.pct, 2), "downloaded": self.downloaded,
            "total": self.total, "estimated": self.estimated, "speed": self.speed, "eta": self.eta,
            "frag": self.frag, "stream": self.stream, "streams": self.streams, "stage": self.stage,
            "error": self.error, "note": self.note, "created": self.created, "started": self.started,
            "finished": self.finished, "dest": self.dest, "filename": os.path.basename(self.dest) if self.dest else None,
            "size": self.size, "file_ok": dest_ok, "log_lines": len(self.log),
            "section": self.spec.get("section"), "folder": self.spec.get("folder"),
        }

    def persist(self) -> dict:
        d = self.public()
        d["spec"] = self.spec
        return d


class Manager:
    def __init__(self):
        self.jobs: "OrderedDict[str, Job]" = OrderedDict()
        self.cv = threading.Condition(threading.RLock())
        self._save_t = None
        threading.Thread(target=self._dispatch, daemon=True, name="dispatch").start()

    # --- persistence of finished jobs, so "Import from Rip" survives restarts
    def load(self):
        try:
            rows = json.loads(JOBS_FILE.read_text("utf-8"))
        except Exception:
            return
        for r in rows[-200:]:
            try:
                j = Job(r["spec"])
                j.created = r.get("created") or j.created
                j.status = r.get("status") if r.get("status") in TERMINAL else "cancelled"
                j.pct = 100.0 if j.status == "done" else r.get("pct") or 0
                for k in ("title", "thumb", "label", "kind", "dest", "size", "error", "note", "started", "finished",
                          "downloaded", "total"):
                    if r.get(k) is not None:
                        setattr(j, k, r[k])
                self.jobs[j.id] = j
            except Exception:
                continue

    def save_soon(self):
        if self._save_t:
            self._save_t.cancel()
        self._save_t = threading.Timer(1.0, self._save)
        self._save_t.daemon = True
        self._save_t.start()

    def _save(self):
        with self.cv:
            rows = [j.persist() for j in self.jobs.values() if j.status in TERMINAL]
        try:
            CONF_DIR.mkdir(parents=True, exist_ok=True)
            tmp = JOBS_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(rows[-200:], ensure_ascii=False), "utf-8")
            os.replace(tmp, JOBS_FILE)
        except Exception as e:
            print(f"  ! could not save history: {e}")

    # --- queue operations
    def add(self, spec) -> Job:
        j = Job(spec)
        with self.cv:
            self.jobs[j.id] = j
            self.cv.notify_all()
        return j

    def get(self, jid) -> Job | None:
        with self.cv:
            return self.jobs.get(jid)

    def list(self):
        with self.cv:
            return [j.public() for j in self.jobs.values()]

    def cancel(self, jid):
        with self.cv:
            j = self.jobs.get(jid)
            if not j:
                raise KeyError("no such job")
            if j.status == "queued":
                j.status, j.finished = "cancelled", time.time()
                self.save_soon()
                return
            if j.status in TERMINAL:
                return
            j.cancel = True
            proc = j.proc
        if proc:
            kill_tree(proc)

    def cancel_all(self):
        for j in list(self.jobs.values()):
            if j.status not in TERMINAL:
                try:
                    self.cancel(j.id)
                except KeyError:
                    pass

    def retry(self, jid):
        with self.cv:
            j = self.jobs.get(jid)
            if not j:
                raise KeyError("no such job")
            if j.status not in ("error", "cancelled", "done"):
                return
            j.reset()
            j.add_log("info", "— retry —")
            self.jobs.move_to_end(jid)
            self.cv.notify_all()

    def remove(self, jid):
        self.cancel(jid)
        with self.cv:
            self.jobs.pop(jid, None)
        self.save_soon()

    def clear(self):
        with self.cv:
            for jid in [k for k, j in self.jobs.items() if j.status in TERMINAL]:
                del self.jobs[jid]
        self.save_soon()

    def running(self):
        return sum(1 for j in self.jobs.values() if j.status in ("running", "merging"))

    def _dispatch(self):
        while True:
            with self.cv:
                while True:
                    free = int(CFG.get("workers", 2)) - self.running()
                    nxt = next((j for j in self.jobs.values() if j.status == "queued"), None)
                    if free > 0 and nxt:
                        break
                    self.cv.wait(timeout=2)
                nxt.status, nxt.started, nxt.stage = "running", time.time(), "Starting"
            threading.Thread(target=self._run, args=(nxt,), daemon=True, name=f"job-{nxt.id}").start()

    # --- one job, one worker process
    def _run(self, j: Job):
        try:
            self._run_inner(j)
        except Exception as e:
            traceback.print_exc()
            j.status, j.error = "error", f"engine error: {e}"
        finally:
            j.proc = None
            if j.status not in TERMINAL:
                j.status = "error"
                j.error = j.error or "stopped unexpectedly"
            j.finished = time.time()
            j.speed = j.eta = None
            with self.cv:
                self.cv.notify_all()
            self.save_soon()
            if j.status == "done":
                print(f"  ✓ {j.title}  →  {j.dest or '(already downloaded)'}")
            elif j.status == "error":
                print(f"  ✗ {j.title}: {j.error}")

    def _run_inner(self, j: Job):
        if not RUNTIME["py"]:
            j.status, j.error = "error", "yt-dlp is not installed. Open Setup in the app and press Install yt-dlp."
            return
        check_tools()
        with CFG_LOCK:
            cfg = dict(CFG)
        try:
            Path(cfg["out_dir"]).mkdir(parents=True, exist_ok=True)
        except OSError as e:
            j.status, j.error = "error", f"can't create output folder: {e}"
            return
        argv = download_argv(j.spec, cfg, TOOLS["ffmpeg"])
        j.add_log("info", f"yt-dlp {RUNTIME['ytdlp']} · {' '.join(argv)}")
        proc = spawn_worker({"action": "download", "url": j.url, "argv": argv})
        j.proc = proc
        if j.cancel:
            kill_tree(proc)
        last_err = None
        for raw in proc.stdout:
            line = raw.rstrip("\r\n")
            if not line:
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                j.add_log("error" if line.startswith(("ERROR", "Traceback")) else "info", ANSI.sub("", line))
                continue
            t = ev.get("t")
            if t == "log":
                lvl, msg = ev.get("level", "info"), ev.get("msg", "")
                j.add_log(lvl, msg)
                if lvl == "error":
                    last_err = msg
                if "has already been recorded in the archive" in msg:
                    j.note = "Already downloaded before (archive) — skipped"
            elif t == "meta":
                if ev.get("title"):
                    j.title = ev["title"]
                j.thumb = ev.get("thumb") or j.thumb
                j.streams = max(1, len(ev.get("streams") or []))
            elif t == "progress":
                st = ev.get("status")
                j.stream = min(ev.get("stream") or 1, max(j.streams, 1))
                total = ev.get("total")
                done = ev.get("downloaded") or 0
                if st == "finished":
                    done = total = done or total or 0
                frac = (done / total) if total else 0
                j.pct = max(0.0, min(99.5, ((j.stream - 1) + min(frac, 1)) / max(j.streams, 1) * 100))
                j.downloaded = j.bytes_done_streams + done
                j.total = (j.bytes_done_streams + total) if total else None
                j.estimated = bool(ev.get("estimated"))
                j.speed, j.eta = ev.get("speed"), ev.get("eta")
                fi, fn = ev.get("frag_i"), ev.get("frag_n")
                j.frag = f"{fi}/{fn}" if fi and fn else (str(fi) if fi else None)
                j.stage = f"Stream {j.stream} of {j.streams}" if j.streams > 1 else "Downloading"
                if st == "finished":
                    j.bytes_done_streams += done
                    if j.stream >= j.streams:
                        j.stage = "Processing"
                j.status = "running"
            elif t == "pp":
                if ev.get("status") == "started":
                    j.status = "merging"
                    j.stage = PP_LABEL.get(ev.get("name"), ev.get("name") or "Processing")
                    j.speed = j.eta = None
            elif t == "file":
                j.dest = ev.get("path")
            elif t == "error":
                last_err = ev.get("msg") or last_err
                j.add_log("error", ev.get("msg", ""))
        code = proc.wait()
        if j.cancel:
            j.status, j.stage = "cancelled", ""
            j.add_log("warn", "Stopped by you. Retry resumes where it left off.")
            return
        if code == 0 and (j.dest or j.note):
            j.status, j.pct, j.stage = "done", 100.0, ""
            if j.dest and os.path.isfile(j.dest):
                j.size = os.path.getsize(j.dest)
            return
        j.status = "error"
        j.error = friendly_error(last_err or f"yt-dlp exited with code {code}")


def friendly_error(msg: str) -> str:
    m = msg or ""
    if "ffmpeg" in m.lower() and ("not installed" in m.lower() or "not found" in m.lower()):
        return m + "\nInstall FFmpeg (Windows: winget install Gyan.FFmpeg · macOS: brew install ffmpeg · Linux: sudo apt install ffmpeg) and restart the engine."
    if "Sign in to confirm" in m or "login" in m.lower() and "required" in m.lower():
        return m + "\nTip: in Setup, choose the browser you're signed in with under “Sign in using browser cookies”."
    if "HTTP Error 403" in m:
        return m + "\nTip: update yt-dlp in Setup — sites change often and new releases fix most 403s."
    return m


def kill_tree(proc: subprocess.Popen):
    if proc.poll() is not None:
        return
    try:
        if IS_WIN:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, **NO_WINDOW)
        else:
            os.killpg(proc.pid, signal.SIGTERM)
            for _ in range(30):
                if proc.poll() is not None:
                    return
                time.sleep(0.1)
            os.killpg(proc.pid, signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def spawn_worker(spec: dict) -> subprocess.Popen:
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    kw = {"creationflags": 0x00000200 | 0x08000000} if IS_WIN else {"start_new_session": True}
    proc = subprocess.Popen(
        [RUNTIME["py"], "-u", str(ENGINE_PATH), "--worker"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", env=env, bufsize=1, **kw)
    proc.stdin.write(json.dumps(spec))
    proc.stdin.close()
    return proc


def common_argv(cfg) -> list:
    a = ["--no-colors", "--flat-playlist"]
    if cfg.get("cookies_from"):
        a += ["--cookies-from-browser", cfg["cookies_from"]]
    return a


def safe_name(s: str, limit=120) -> str:
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", str(s or "")).strip(" .")
    return (s[:limit].rstrip(" .") or "playlist").replace("%", "%%")


def clock_tag(sec: float) -> str:
    s = int(round(float(sec)))
    h, m, x = s // 3600, s % 3600 // 60, s % 60
    return f"{h}h{m:02d}m{x:02d}s" if h else f"{m}m{x:02d}s"


def download_argv(spec: dict, cfg: dict, ffmpeg: bool) -> list:
    a = common_argv(cfg) + ["--newline", "--no-playlist", "--no-mtime", "--continue"]
    tmpl = cfg["template"]
    if spec.get("folder"):
        idx = spec.get("index")
        tmpl = safe_name(spec["folder"]) + "/" + (f"{int(idx):03d} - " if idx else "") + tmpl
    sec = spec.get("section")
    if sec and ffmpeg:
        tag = f" [{clock_tag(sec['start'])}-{clock_tag(sec['end'])}]"
        i = tmpl.rfind(".%(ext)s")
        tmpl = tmpl[:i] + tag + tmpl[i:] if i >= 0 else tmpl + tag
    a += ["-P", cfg["out_dir"], "-o", tmpl, "-N", str(cfg["frag_workers"])]
    if cfg.get("rate_limit"):
        a += ["-r", cfg["rate_limit"].replace(" ", "").upper()]
    q = str(spec.get("quality") or "best")
    audio = q == "audio"
    if spec.get("mode") == "format" and spec.get("format_id"):
        fid = str(spec["format_id"])
        a += ["-f", f"{fid}+bestaudio/{fid}" if spec.get("needs_audio") and ffmpeg else fid]
        if spec.get("audio_only_format"):
            audio = True
    elif audio:
        a += ["-f", "ba/b"]
    else:
        if q.isdigit():
            h = int(q)
            fmt = f"bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b" if ffmpeg else f"b[height<={h}]/b"
        else:
            fmt = "bv*+ba/b" if ffmpeg else "b"
        a += ["-f", fmt]
        if cfg.get("compat"):
            a += ["-S", "vcodec:h264,res,acodec:aac"]
    if audio and ffmpeg and spec.get("mode") != "format":
        a += ["-x", "--audio-format", cfg["audio_codec"], "--audio-quality", "0"]
    elif not audio:
        a += ["--merge-output-format", cfg["merge_format"]]
    if sec and ffmpeg:
        a += ["--download-sections", f"*{float(sec['start']):.3f}-{float(sec['end']):.3f}"]
        if sec.get("precise"):
            a += ["--force-keyframes-at-cuts"]
    if ffmpeg:
        if cfg.get("embed_meta"):
            a += ["--embed-metadata"] + ([] if audio else ["--embed-chapters"])
        if cfg.get("embed_thumb") and (cfg["audio_codec"] != "wav" if audio else cfg["merge_format"] != "webm"):
            a += ["--embed-thumbnail"]
        if cfg.get("subs") and not audio:
            a += ["--write-subs", "--sub-langs", cfg["sub_langs"]] + (["--embed-subs"] if cfg.get("embed_subs") else [])
        if cfg.get("sponsorblock"):
            a += ["--sponsorblock-remove", "sponsor"]
    if cfg.get("archive"):
        a += ["--download-archive", str(ARCHIVE_FILE)]
    return a


PROBE_CACHE: dict = {}


def probe(url: str, playlist: bool) -> dict:
    if not RUNTIME["py"]:
        raise RuntimeError("yt-dlp is not installed yet. Open Setup and press Install yt-dlp.")
    with CFG_LOCK:
        cfg = dict(CFG)
    key = (url, playlist, cfg.get("cookies_from"))
    hit = PROBE_CACHE.get(key)
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    argv = common_argv(cfg) + (["--yes-playlist"] if playlist else ["--no-playlist"])
    proc = spawn_worker({"action": "probe", "url": url, "argv": argv})
    result, err, logs = None, None, []
    timer = threading.Timer(180, lambda: kill_tree(proc))
    timer.start()
    try:
        for raw in proc.stdout:
            try:
                ev = json.loads(raw)
            except ValueError:
                logs.append(raw.strip())
                continue
            if ev.get("t") == "result":
                result = ev["data"]
            elif ev.get("t") == "error":
                err = ev.get("msg")
            elif ev.get("t") == "log" and ev.get("level") == "error":
                err = err or ev.get("msg")
        proc.wait()
    finally:
        timer.cancel()
    if result is None:
        msg = err or next((l for l in reversed(logs) if l), None) or "yt-dlp returned nothing for this link"
        if "Unsupported URL" in msg:
            msg = "That page isn't a video yt-dlp knows how to read.\n" + msg
        raise RuntimeError(friendly_error(msg))
    PROBE_CACHE[key] = (time.time(), result)
    if len(PROBE_CACHE) > 64:
        PROBE_CACHE.pop(next(iter(PROBE_CACHE)))
    return result


def busy() -> bool:
    return any(j.status in ("queued", "running", "merging") for j in list(MANAGER.jobs.values()))


def auto_update_loop():
    """Sites change constantly; keep yt-dlp fresh once a day while nothing is downloading."""
    time.sleep(120)
    while True:
        try:
            st = load_state()
            if CFG.get("auto_update", True) and RUNTIME["py"] and not busy() \
                    and time.time() - st.get("ytdlp_checked", 0) > 20 * 3600:
                before = RUNTIME["ytdlp"]
                ok, out = install_ytdlp()
                st["ytdlp_checked"] = time.time()
                save_state(st)
                if ok and RUNTIME["ytdlp"] != before:
                    PROBE_CACHE.clear()
                    print(f"  ↑ yt-dlp updated {before} → {RUNTIME['ytdlp']}")
                elif not ok:
                    print("  ! yt-dlp auto-update failed: " + (out.strip().splitlines() or ["?"])[-1])
        except Exception as e:
            print(f"  ! auto-update error: {e}")
        time.sleep(3600)


def vtuple(v: str):
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3])


def self_update() -> tuple[bool, str]:
    """Fetch the engine published next to the app and swap it in. Returns (updated, version or reason)."""
    url = APP_URL + "engine/ripstitch_engine.py?v=" + str(int(time.time()))
    data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": f"RipStitchEngine/{VERSION}"}),
                                  timeout=30).read()
    text = data.decode("utf-8")
    m = re.search(r'^VERSION = "([\d.]+)"', text, re.M)
    if "RipStitch Engine" not in text or not m:
        raise ValueError("the downloaded file isn't a RipStitch engine")
    if vtuple(m.group(1)) <= vtuple(VERSION):
        return False, f"Engine {VERSION} is already the latest"
    compile(text, str(ENGINE_PATH), "exec")  # refuse anything that doesn't even parse
    shutil.copy2(ENGINE_PATH, ENGINE_PATH.with_name(ENGINE_PATH.name + ".bak"))
    tmp = ENGINE_PATH.with_name(ENGINE_PATH.name + ".new")
    tmp.write_bytes(data)
    os.replace(tmp, ENGINE_PATH)
    return True, m.group(1)


RESTART = {"now": False}


def restart(background: bool):
    args = [a for a in sys.argv[1:] if a not in ("--open", "--install")]
    cmd = [sys.executable, str(ENGINE_PATH), *args]
    print(f"  restarting: {' '.join(cmd)}")
    if IS_WIN:
        flags = (0x00000008 | 0x00000200) if background else 0x00000010  # detached / new console
        subprocess.Popen(cmd, creationflags=flags, close_fds=True)
        os._exit(0)
    os.execv(sys.executable, cmd)


def stop_running(port: int) -> bool:
    """Ask an engine on this machine to shut down (used by uninstallers and `--stop`)."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        opener.open(urllib.request.Request(f"http://127.0.0.1:{port}/api/shutdown", data=b"{}", method="POST",
                                           headers={"Content-Type": "application/json"}), timeout=5).read()
    except Exception:
        return False
    import socket
    for _ in range(80):
        with socket.socket() as sk:
            if sk.connect_ex(("127.0.0.1", port)) != 0:
                return True
        time.sleep(0.1)
    return True


def reveal(path: str | None):
    with CFG_LOCK:
        out = CFG["out_dir"]
    target = Path(path) if path else Path(out)
    if not target.exists():
        target = Path(out)
        target.mkdir(parents=True, exist_ok=True)
    if IS_WIN:
        if target.is_file():
            subprocess.Popen(["explorer", "/select,", str(target)])
        else:
            os.startfile(str(target))  # type: ignore[attr-defined]
    elif IS_MAC:
        subprocess.Popen(["open", "-R", str(target)] if target.is_file() else ["open", str(target)])
    else:
        subprocess.Popen(["xdg-open", str(target.parent if target.is_file() else target)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


VIDEO_EXT = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".ts", ".mts", ".flv", ".3gp", ".ogv", ".mpg", ".mpeg"}
AUDIO_EXT = {".mp3", ".m4a", ".opus", ".flac", ".wav", ".ogg", ".aac"}


def list_files(limit=300) -> list:
    with CFG_LOCK:
        root = Path(CFG["out_dir"])
    found = []
    if root.is_dir():
        for p in root.rglob("*"):
            try:
                if p.is_file() and p.suffix.lower() in VIDEO_EXT | AUDIO_EXT and not p.name.endswith(".part"):
                    if len(p.relative_to(root).parts) > 3:
                        continue
                    st = p.stat()
                    found.append({"path": str(p.relative_to(root)).replace("\\", "/"), "name": p.name,
                                  "size": st.st_size, "mtime": st.st_mtime,
                                  "kind": "audio" if p.suffix.lower() in AUDIO_EXT else "video"})
            except OSError:
                continue
    found.sort(key=lambda f: -f["mtime"])
    return found[:limit]


def resolve_in_out_dir(rel: str) -> Path:
    with CFG_LOCK:
        root = Path(CFG["out_dir"]).resolve()
    p = (root / rel).resolve()
    if root != p and root not in p.parents:
        raise PermissionError("outside the output folder")
    return p


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
TOKEN = secrets.token_urlsafe(18)
SERVER: ThreadingHTTPServer
MANAGER: Manager
SITE_DIR: Path | None = None
PORT = DEFAULT_PORT
EXTRA_ORIGINS: set = set()
VERBOSE = False


def origin_allowed(origin: str | None) -> bool:
    if not origin or origin == "null":
        return False
    origin = origin.rstrip("/")
    with CFG_LOCK:
        extra = set(CFG.get("extra_origins") or [])
    if origin in TRUSTED_ORIGINS or origin in EXTRA_ORIGINS or origin in extra:
        return True
    u = urlsplit(origin)
    return u.scheme in ("http", "https") and u.hostname in ("127.0.0.1", "localhost", "::1")


def free_bytes(path: str):
    p = Path(path)
    while not p.exists() and p != p.parent:
        p = p.parent
    try:
        return shutil.disk_usage(p).free
    except OSError:
        return None


def health() -> dict:
    check_tools()
    with CFG_LOCK:
        cfg = dict(CFG)
    return {
        "ok": True, "app": "ripstitch-engine", "version": VERSION, "token": TOKEN,
        "ytdlp": RUNTIME["ytdlp"], "runtime": RUNTIME["where"], "python": platform.python_version(),
        "ffmpeg": TOOLS["ffmpeg"], "ffmpeg_version": TOOLS["ffmpeg_version"], "js_runtime": TOOLS["js"],
        "free_bytes": free_bytes(cfg["out_dir"]), "out_dir": cfg["out_dir"], "config": cfg,
        "platform": "windows" if IS_WIN else "mac" if IS_MAC else "linux",
        "install": install_kind(), "log_file": str(LOG_FILE),
        "defaults": DEFAULTS, "choices": CHOICES,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = f"RipStitchEngine/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if VERBOSE:
            sys.stderr.write("  · " + (fmt % args) + "\n")

    # -- guards
    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").strip().lower()
        name = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
        return name in ("127.0.0.1", "localhost", "[::1]")

    def _cors(self):
        o = self.headers.get("Origin")
        if origin_allowed(o):
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Disposition, X-File-Name")
        self.send_header("Vary", "Origin")

    def _guard(self, write=False) -> bool:
        if not self._host_ok():
            self._json(403, {"ok": False, "error": "bad host"}, cors=False)
            return False
        o = self.headers.get("Origin")
        if o and not origin_allowed(o):
            self._json(403, {"ok": False, "error": f"origin {o} is not allowed; restart the engine with --allow-origin {o}"}, cors=False)
            return False
        return True

    # -- responses
    def _send(self, code, body: bytes, ctype: str, headers=None, cors=True):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if cors:
            self._cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj, cors=True):
        self._send(code, json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8"),
                   "application/json; charset=utf-8", cors=cors)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 2_000_000:
            raise ValueError("request too large")
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return {}
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("expected a JSON object")
        return data

    # -- verbs
    def do_OPTIONS(self):
        o = self.headers.get("Origin")
        if not self._host_ok() or not origin_allowed(o):
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", o)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urlsplit(self.path)
        path, q = u.path, parse_qs(u.query)
        try:
            if path.startswith("/api/"):
                if not self._guard():
                    return
                if path == "/api/ping":
                    return self._json(200, {"ok": True, "app": "ripstitch-engine", "version": VERSION})
                if path == "/api/health":
                    return self._json(200, health())
                if path == "/api/jobs":
                    return self._json(200, {"ok": True, "jobs": MANAGER.list()})
                if path.startswith("/api/log/"):
                    j = MANAGER.get(path.rsplit("/", 1)[-1])
                    if not j:
                        return self._json(404, {"ok": False, "error": "no such job"})
                    return self._json(200, {"ok": True, "log": j.log})
                if path in ("/api/files", "/api/file"):
                    if (q.get("t") or [""])[0] != TOKEN:
                        return self._json(403, {"ok": False, "error": "missing or stale token — reload the app"})
                    if path == "/api/files":
                        return self._json(200, {"ok": True, "files": list_files(), "out_dir": CFG["out_dir"]})
                    return self._file(q)
                return self._json(404, {"ok": False, "error": "unknown endpoint"})
            return self._static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except PermissionError as e:
            self._json(403, {"ok": False, "error": str(e)})
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"ok": False, "error": str(e)})

    def do_POST(self):
        path = urlsplit(self.path).path
        if not self._guard(write=True):
            return
        try:
            body = self._body()
        except Exception as e:
            return self._json(400, {"ok": False, "error": f"bad request: {e}"})
        try:
            if path == "/api/probe":
                url = str(body.get("url") or "").strip()
                if not re.match(r"^https?://", url, re.I):
                    return self._json(400, {"ok": False, "error": "That doesn't look like a web link (it should start with http)."})
                return self._json(200, {"ok": True, "result": probe(url, bool(body.get("playlist")))})
            if path == "/api/enqueue":
                items = body.get("items") or []
                if not items:
                    return self._json(400, {"ok": False, "error": "nothing to queue"})
                ids = []
                for i, it in enumerate(items):
                    url = str(it.get("url") or "")
                    if not re.match(r"^https?://", url, re.I):
                        continue
                    spec = {k: body.get(k) for k in ("mode", "quality", "format_id", "needs_audio", "section",
                                                      "label", "audio_only_format")}
                    spec.update(url=url, title=it.get("title"), thumb=it.get("thumb"))
                    if body.get("folder"):
                        spec.update(folder=str(body["folder"]), index=it.get("index"))
                    sec = spec.get("section")
                    if sec:
                        s, e = float(sec.get("start", 0)), float(sec.get("end", 0))
                        if e <= s:
                            return self._json(400, {"ok": False, "error": "Section end must be after its start"})
                        spec["section"] = {"start": s, "end": e, "precise": bool(sec.get("precise"))}
                    ids.append(MANAGER.add(spec).id)
                if not ids:
                    return self._json(400, {"ok": False, "error": "no usable links"})
                return self._json(200, {"ok": True, "ids": ids})
            if path in ("/api/cancel", "/api/retry", "/api/remove"):
                getattr(MANAGER, path.rsplit("/", 1)[-1])(str(body.get("id")))
                return self._json(200, {"ok": True})
            if path == "/api/clear":
                MANAGER.clear()
                return self._json(200, {"ok": True})
            if path == "/api/settings":
                clean = validate_config(body.get("config") or {}, partial=True)
                if "out_dir" in clean:
                    try:
                        Path(clean["out_dir"]).mkdir(parents=True, exist_ok=True)
                    except OSError as e:
                        return self._json(400, {"ok": False, "error": f"Can't use that folder: {e}"})
                with CFG_LOCK:
                    CFG.update(clean)
                save_config()
                with MANAGER.cv:
                    MANAGER.cv.notify_all()
                PROBE_CACHE.clear()
                return self._json(200, {"ok": True, "config": dict(CFG)})
            if path == "/api/update":
                before = RUNTIME["ytdlp"]
                ok, out = install_ytdlp()
                after = RUNTIME["ytdlp"]
                if ok:
                    save_state(dict(load_state(), ytdlp_checked=time.time()))
                PROBE_CACHE.clear()
                note = (f"yt-dlp {after} installed" if not before and after else
                        f"updated {before} → {after}" if before != after and after else
                        f"yt-dlp {after} is already the latest" if ok else "update failed")
                return self._json(200 if ok else 500, {"ok": ok, "note": note, "ytdlp": after,
                                                       "output": out[-4000:], "error": None if ok else out[-1500:]})
            if path == "/api/shutdown":
                self._json(200, {"ok": True})
                threading.Thread(target=SERVER.shutdown, daemon=True).start()
                return
            if path == "/api/engine-update":
                if busy():
                    return self._json(409, {"ok": False, "error": "Finish or stop the downloads in progress first."})
                updated, info = self_update()
                if not updated:
                    return self._json(200, {"ok": True, "updated": False, "note": info})
                self._json(200, {"ok": True, "updated": True, "version": info, "note": f"Engine updated to {info}"})
                RESTART["now"] = True
                threading.Thread(target=SERVER.shutdown, daemon=True).start()
                return
            if path == "/api/reveal":
                p = body.get("path")
                if body.get("id"):
                    j = MANAGER.get(str(body["id"]))
                    p = j.dest if j else None
                if body.get("rel"):
                    p = str(resolve_in_out_dir(str(body["rel"])))
                reveal(p)
                return self._json(200, {"ok": True})
            return self._json(404, {"ok": False, "error": "unknown endpoint"})
        except KeyError as e:
            return self._json(404, {"ok": False, "error": str(e).strip("'")})
        except ValueError as e:
            return self._json(400, {"ok": False, "error": str(e)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            if VERBOSE:
                traceback.print_exc()
            return self._json(500, {"ok": False, "error": str(e)})

    # -- files
    def _file(self, q):
        if q.get("job"):
            j = MANAGER.get(q["job"][0])
            if not j or not j.dest:
                return self._json(404, {"ok": False, "error": "that download has no file"})
            p = Path(j.dest)
        else:
            p = resolve_in_out_dir(unquote((q.get("p") or [""])[0]))
        if not p.is_file():
            return self._json(404, {"ok": False, "error": "file not found — it may have been moved or deleted"})
        size = p.stat().st_size
        ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        status = 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                elif m.group(2):
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
                if start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self._cors()
                    self.end_headers()
                    return
                status = 206
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Last-Modified", self.date_time_string(int(p.stat().st_mtime)))
        self.send_header("X-File-Name", quote(p.name))
        self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{quote(p.name)}")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self._cors()
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(p, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    # -- the app itself, when the engine runs from a checkout of the repo
    def _static(self, path):
        if not self._host_ok():
            return self._json(403, {"ok": False, "error": "bad host"}, cors=False)
        if SITE_DIR is None:
            html = (f"<!doctype html><meta charset=utf-8><title>RipStitch Engine</title>"
                    f"<body style='font:15px system-ui;background:#0a0d12;color:#e8edf3;display:grid;place-items:center;height:100vh;margin:0'>"
                    f"<div style='text-align:center'><h1 style='font-size:20px'>RipStitch Engine {VERSION} is running</h1>"
                    f"<p style='color:#7f8a9a'>Keep this window open and use the app:</p>"
                    f"<p><a style='color:#ffd21e' href='{APP_URL}'>{APP_URL}</a></p></div>")
            return self._send(200, html.encode(), "text/html; charset=utf-8")
        rel = unquote(path).lstrip("/") or "index.html"
        p = (SITE_DIR / rel).resolve()
        if SITE_DIR not in p.parents and p != SITE_DIR:
            return self._send(404, b"not found", "text/plain")
        if p.is_dir():
            p = p / "index.html"
        if not p.is_file():
            return self._send(404, b"not found", "text/plain")
        ctype = {".js": "text/javascript", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
                 ".css": "text/css", ".html": "text/html", ".py": "text/x-python"}.get(p.suffix.lower()) \
            or mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith(("json", "+xml", "javascript")):
            ctype += "; charset=utf-8"
        headers = {"Content-Disposition": "attachment"} if p.suffix == ".py" else None
        self._send(200, p.read_bytes(), ctype, headers=headers, cors=False)


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def color(s, c):
    if not getattr(sys.stdout, "isatty", lambda: False)() or os.environ.get("NO_COLOR"):
        return s
    return f"\x1b[{c}m{s}\x1b[0m"


def banner():
    o, y, d = "38;5;208", "38;5;220", "2"
    print()
    print("  " + color("▶ Rip", o) + color("Stitch", y) + color(f"  engine {VERSION}", d))
    print("  " + color("─" * 44, d))


def log_to_file():
    """Background mode has no console: everything printed goes to engine.log instead."""
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 2_000_000:
            os.replace(LOG_FILE, LOG_FILE.with_name("engine.old.log"))
    except OSError:
        pass
    f = open(LOG_FILE, "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = f
    print(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} · engine {VERSION} · {install_kind()} · python {platform.python_version()} ===")


def main():
    global MANAGER, SITE_DIR, PORT, VERBOSE, SERVER
    if "--worker" in sys.argv:
        sys.exit(worker_main())
    ap = argparse.ArgumentParser(description="RipStitch Engine: lets the RipStitch web app download with yt-dlp.")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port on 127.0.0.1 (default {DEFAULT_PORT})")
    ap.add_argument("--background", action="store_true", help="run quietly: no console, log to a file, no browser")
    ap.add_argument("--open", action="store_true", help="open the app in a browser once running (even in background)")
    ap.add_argument("--no-browser", action="store_true", help="don't open the app in a browser")
    ap.add_argument("--stop", action="store_true", help="stop the engine running on this computer, then exit")
    ap.add_argument("--allow-origin", action="append", default=[], metavar="URL",
                    help="also trust this site, e.g. https://you.github.io (repeatable)")
    ap.add_argument("--app-url", default=APP_URL, help="the hosted app to open on start")
    ap.add_argument("--out", help="output folder (saved for next time)")
    ap.add_argument("--install", action="store_true", help="install or update yt-dlp, then exit")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    ap.add_argument("--version", action="version", version=f"RipStitch Engine {VERSION}")
    args = ap.parse_args()
    VERBOSE, PORT = args.verbose, args.port
    EXTRA_ORIGINS.update(o.rstrip("/") for o in args.allow_origin)

    if args.stop:
        sys.exit(0 if stop_running(PORT) else 1)
    quiet = args.background or sys.stdout is None
    if quiet:
        log_to_file()
    else:
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    prepare_path()

    banner()
    load_config()
    if args.out:
        CFG.update(validate_config({"out_dir": args.out}))
        save_config()
    if not quiet:
        print(color("  checking tools…", "2"), end="\r", flush=True)
    find_runtime()
    check_tools(force=True)

    if args.install or not RUNTIME["py"]:
        ans = "y"
        if not RUNTIME["py"] and not args.install:
            print("  yt-dlp isn't installed yet — it does the actual downloading.")
            if quiet:
                print("  installing it now…")
            elif sys.stdin and sys.stdin.isatty():
                try:
                    ans = input("  Install it now? [Y/n] ").strip().lower() or "y"
                except EOFError:
                    ans = "n"
            else:
                ans = "n"
                print("  (not interactive — press “Install yt-dlp” in the app's Setup instead)")
        if ans.startswith("y"):
            ok, out = install_ytdlp(echo=lambda s: print("  " + s))
            print("  " + (color(f"✓ yt-dlp {RUNTIME['ytdlp']} ready", "32") if ok else color("✗ install failed:", "31")))
            if not ok:
                print("\n".join("    " + l for l in out.splitlines()[-12:]))
            elif args.install:
                save_state(dict(load_state(), ytdlp_checked=time.time()))
        if args.install:
            sys.exit(0 if RUNTIME["py"] else 1)

    here = ENGINE_PATH.parent
    for cand in (APP_DIR / "site", here.parent, here):
        if (cand / "index.html").is_file() and (cand / "js").is_dir():
            SITE_DIR = cand.resolve()
            break
    local = f"http://127.0.0.1:{PORT}/"
    app = local if SITE_DIR else args.app_url
    want_browser = args.open or not (args.no_browser or quiet)

    MANAGER = Manager()
    MANAGER.load()
    try:
        SERVER = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        print(color(f"  Port {PORT} is busy — the engine is probably already running.", "33"))
        if not quiet:
            print(f"  Open {args.app_url} (or start with --port 8732).")
        if want_browser:
            webbrowser.open(args.app_url)
        return
    SERVER.daemon_threads = True

    ok, bad = color("✓", "32"), color("✗", "31")
    if not quiet:
        print(" " * 30, end="\r")
    print(f"  {ok if RUNTIME['ytdlp'] else bad} yt-dlp   {RUNTIME['ytdlp'] or 'missing — install from the app'}"
          + (f" ({RUNTIME['where']})" if RUNTIME["where"] else ""))
    print(f"  {ok if TOOLS['ffmpeg'] else bad} ffmpeg   {TOOLS['ffmpeg_version'] if TOOLS['ffmpeg'] else 'missing — needed for HD merges and audio'}")
    print(f"  {ok if TOOLS['js'] else color('•', '33')} js       {TOOLS['js'] or 'none — install Deno for full YouTube support'}")
    print(f"  {color('→', '2')} saving to {CFG['out_dir']}")
    print()
    print("  " + color("Ready.", "1") + " Open the app: " + color(app, "4"))
    if SITE_DIR:
        print(color(f"  (also works with {args.app_url})", "2"))
    if not quiet:
        print(color("  Leave this window open while you use Rip. Ctrl+C stops the engine.", "2"))
        print()
    if want_browser:
        threading.Timer(0.6, lambda: webbrowser.open(app)).start()
    threading.Thread(target=auto_update_loop, daemon=True, name="auto-update").start()

    def stop(*_):
        raise KeyboardInterrupt

    try:
        signal.signal(signal.SIGTERM, stop)
    except Exception:
        pass
    try:
        SERVER.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\n  stopping…")
    finally:
        MANAGER.cancel_all()
        MANAGER._save()
        SERVER.server_close()
    print("  engine stopped")
    if RESTART["now"]:
        restart(quiet)


if __name__ == "__main__":
    main()
