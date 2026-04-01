from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import TextIO
from urllib.parse import urlparse


def _bump_patch_version(version: str) -> str:
    """与 build.py 一致：x.y.z → x.y.(z+1)。"""
    parts = version.split(".")
    if len(parts) < 3:
        return version
    try:
        major = int(parts[0])
        minor = int(parts[1])
        patch = int(parts[2])
    except ValueError:
        return version
    return f"{major}.{minor}.{patch + 1}"


def _set_version_in_package_json(package_json_path: Path, new_version: str) -> None:
    text = package_json_path.read_text(encoding="utf-8")

    def repl(m: re.Match[str]) -> str:
        return m.group(1) + new_version + m.group(3)

    new_text, n = re.subn(r'("version"\s*:\s*")([^"]+)(")', repl, text, count=1)
    if n != 1 or new_text == text:
        raise RuntimeError(f"failed to update version in {package_json_path}")
    package_json_path.write_text(new_text, encoding="utf-8")


def _read_package_version(ext_dir: Path) -> str:
    """读取扩展 package.json 的 version 字段（用于日志对照，脚本本身无独立 semver）。"""
    package_json_path = ext_dir / "package.json"
    if not package_json_path.is_file():
        return "?"
    try:
        pkg = json.loads(package_json_path.read_text(encoding="utf-8"))
        return str(pkg.get("version", "?"))
    except (json.JSONDecodeError, OSError):
        return "?"


def _bump_extension_version(ext_dir: Path) -> str:
    """将 package.json 的 patch +1，返回当前新版本字符串。"""
    package_json_path = ext_dir / "package.json"
    if not package_json_path.is_file():
        print(f"error: missing {package_json_path}", file=sys.stderr)
        raise SystemExit(1)
    pkg = json.loads(package_json_path.read_text(encoding="utf-8"))
    ver = str(pkg.get("version", "0.0.0"))
    new_ver = _bump_patch_version(ver)
    if new_ver != ver:
        _set_version_in_package_json(package_json_path, new_ver)
        print(f"version bump: {ver} -> {new_ver} (package.json)", flush=True)
        return new_ver
    print(f"version unchanged: {ver} (not semver x.y.z)", flush=True)
    return ver


def _run(cmd: list[str], *, cwd: Path) -> None:
    print("+ " + " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=str(cwd), check=True)


def _find_exe(candidates: list[str]) -> str | None:
    for c in candidates:
        p = shutil.which(c)
        if p:
            return p
        cp = Path(c)
        if cp.is_file():
            return str(cp.resolve())
    return None


def _rm_tree(p: Path) -> None:
    if not p.exists():
        return
    if p.is_dir():
        shutil.rmtree(p, ignore_errors=True)
    else:
        try:
            p.unlink()
        except OSError:
            pass


def _ensure_jsmind_media(ext_dir: Path, npm_cmd: str) -> None:
    """Copy jsMind assets into media/jsmind (same as build.py) for offline HTTP serving."""
    node_modules = ext_dir / "node_modules"
    need_install = not node_modules.is_dir() or not (node_modules / "jsmind").is_dir()
    if need_install:
        _run([npm_cmd, "install"], cwd=ext_dir)

    jsmind_src_dir = ext_dir / "node_modules" / "jsmind"
    jsmind_js_src = jsmind_src_dir / "es6" / "jsmind.js"
    jsmind_css_src = jsmind_src_dir / "style" / "jsmind.css"
    media_jsmind_dir = ext_dir / "media" / "jsmind"

    if not jsmind_js_src.is_file() or not jsmind_css_src.is_file():
        print(
            f"error: missing jsMind assets: {jsmind_js_src} / {jsmind_css_src}",
            file=sys.stderr,
        )
        raise SystemExit(1)

    _rm_tree(media_jsmind_dir)
    media_jsmind_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(jsmind_js_src, media_jsmind_dir / "jsmind.js")
    shutil.copy2(jsmind_css_src, media_jsmind_dir / "jsmind.css")


def _gen_web_dev_html(ext_dir: Path, node_cmd: str, host: str, port: int) -> None:
    script = ext_dir / "scripts" / "gen_web_dev_html.js"
    if not script.is_file():
        print(f"error: missing {script}", file=sys.stderr)
        raise SystemExit(1)
    _run([node_cmd, str(script), host, str(port)], cwd=ext_dir)


def _page_url(host: str, port: int) -> str:
    # Use loopback for display/open when serving on all interfaces.
    open_host = "127.0.0.1" if host in ("0.0.0.0", "::", "[::]") else host
    return f"http://{open_host}:{port}/"


def _web_dev_meta_path(ext_dir: Path) -> Path:
    return ext_dir / "out" / "web_dev_meta.json"


def _write_web_dev_meta(ext_dir: Path, seq: int) -> None:
    p = _web_dev_meta_path(ext_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"seq": seq}, ensure_ascii=False), encoding="utf-8")


def _scan_out_max_mtime(ext_dir: Path) -> float:
    """out 下编译产物与 web_dev.html 的最新修改时间，用于检测 tsc / 生成 HTML 是否完成。"""
    out_dir = ext_dir / "out"
    if not out_dir.is_dir():
        return 0.0
    mt = 0.0
    for sub in out_dir.rglob("*.js"):
        try:
            mt = max(mt, sub.stat().st_mtime)
        except OSError:
            pass
    wd = out_dir / "web_dev.html"
    if wd.is_file():
        try:
            mt = max(mt, wd.stat().st_mtime)
        except OSError:
            pass
    return mt


def _run_web_dev_watch(
    ext_dir: Path,
    npm_cmd: str,
    node_cmd: str,
    gen_host: str,
    port: int,
    stop_event: threading.Event,
) -> tuple[subprocess.Popen | None, threading.Thread | None, TextIO | None]:
    """
    后台 tsc --watch；轮询 src/panel.ts 与 out/ 产物。
    任意源码保存后经 tsc 更新 out/；panel.ts 变更时重生成 web_dev.html；
    out 或 web_dev.html 变更则递增 web_dev_meta.json seq，供页面轮询刷新（与 package.json 版本无关）。
    """
    seq_holder: dict[str, int] = {"seq": 1}
    debounce_timer: list[threading.Timer | None] = [None]

    def bump_seq() -> None:
        seq_holder["seq"] += 1
        s = seq_holder["seq"]
        _write_web_dev_meta(ext_dir, s)
        print(f"[watch] web_dev_meta.json seq={s}", flush=True)

    def schedule_bump() -> None:
        t = debounce_timer[0]
        if t is not None:
            t.cancel()

        def fire() -> None:
            debounce_timer[0] = None
            bump_seq()

        debounce_timer[0] = threading.Timer(0.35, fire)
        debounce_timer[0].daemon = True
        debounce_timer[0].start()

    _write_web_dev_meta(ext_dir, seq_holder["seq"])

    log_path = ext_dir / "out" / "web_dev_tsc_watch.log"
    watch_log_fp: TextIO | None = None
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        watch_log_fp = open(log_path, "a", encoding="utf-8")
        watch_log_fp.write("\n--- run_web " + time.strftime("%Y-%m-%d %H:%M:%S") + " ---\n")
        watch_log_fp.flush()
        watch_proc = subprocess.Popen(
            [npm_cmd, "run", "watch"],
            cwd=str(ext_dir),
            stdout=watch_log_fp,
            stderr=subprocess.STDOUT,
        )
    except OSError as e:
        if watch_log_fp is not None:
            try:
                watch_log_fp.close()
            except OSError:
                pass
        print(f"error: cannot start npm run watch: {e}", file=sys.stderr)
        return None, None, None

    panel_ts = ext_dir / "src" / "panel.ts"
    panel_js = ext_dir / "out" / "panel.js"

    def loop() -> None:
        last_panel_mtime = panel_ts.stat().st_mtime if panel_ts.is_file() else 0.0
        last_panel_js_mtime = panel_js.stat().st_mtime if panel_js.is_file() else 0.0
        last_out_mtime = _scan_out_max_mtime(ext_dir)
        while not stop_event.wait(0.45):
            try:
                pm = panel_ts.stat().st_mtime if panel_ts.is_file() else 0.0
            except OSError:
                pm = 0.0
            if pm > last_panel_mtime + 1e-6:
                last_panel_mtime = pm
                try:
                    _gen_web_dev_html(ext_dir, node_cmd, gen_host, port)
                    print("[watch] regenerated out/web_dev.html (panel.ts changed)", flush=True)
                except (subprocess.CalledProcessError, OSError) as e:
                    print(f"[watch] gen_web_dev_html failed: {e}", file=sys.stderr)
                schedule_bump()

            # tsc 成功写入 out/panel.js 后再补一次生成，避免仅依赖 mtime 偶发未触发时页面已刷新却仍是旧 HTML
            try:
                pj = panel_js.stat().st_mtime if panel_js.is_file() else 0.0
            except OSError:
                pj = 0.0
            if pj > last_panel_js_mtime + 1e-6:
                last_panel_js_mtime = pj
                try:
                    _gen_web_dev_html(ext_dir, node_cmd, gen_host, port)
                    print("[watch] regenerated out/web_dev.html (out/panel.js updated)", flush=True)
                except (subprocess.CalledProcessError, OSError) as e:
                    print(f"[watch] gen_web_dev_html failed: {e}", file=sys.stderr)
                schedule_bump()

            om = _scan_out_max_mtime(ext_dir)
            if om > last_out_mtime + 1e-6:
                last_out_mtime = om
                schedule_bump()

    th = threading.Thread(target=loop, name="web-dev-watch", daemon=True)
    th.start()
    return watch_proc, th, watch_log_fp


def _make_web_dev_handler(ext_dir: Path):
    """GET / 与 GET /out/web_dev.html 等价，避免根路径出现目录列表。"""

    class WebDevHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ext_dir), **kwargs)

        def _map_root(self) -> None:
            u = urlparse(self.path)
            if u.path in ("/", ""):
                self.path = "/out/web_dev.html" + (("?" + u.query) if u.query else "")

        def do_GET(self) -> None:  # noqa: N802
            self._map_root()
            super().do_GET()

        def do_HEAD(self) -> None:  # noqa: N802
            self._map_root()
            super().do_HEAD()

    return WebDevHandler


def _copy_clipboard(text: str) -> bool:
    if sys.platform == "win32":
        try:
            # Use single-quoted here-string so URLs are not expanded by PowerShell ($ etc.).
            if "@'" in text or "'@" in text:
                return False
            ps = "Set-Clipboard -Value @'\n" + text + "\n'@"
            r = subprocess.run(
                ["powershell", "-NoProfile", "-STA", "-Command", ps],
                cwd=os.getcwd(),
                capture_output=True,
            )
            return r.returncode == 0
        except OSError:
            return False
    if shutil.which("wl-copy"):
        try:
            subprocess.run(["wl-copy"], input=text.encode("utf-8"), check=True)
            return True
        except (OSError, subprocess.CalledProcessError):
            pass
    if shutil.which("xclip"):
        try:
            subprocess.run(["xclip", "-selection", "clipboard"], input=text.encode("utf-8"), check=True)
            return True
        except (OSError, subprocess.CalledProcessError):
            pass
    return False


def _open_edge_app_windows(url: str) -> bool:
    candidates = [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
    ]
    for edge in candidates:
        p = Path(edge)
        if p.is_file():
            try:
                subprocess.Popen([str(p), f"--app={url}"], close_fds=True)
                return True
            except OSError:
                pass
    return False


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "本地 HTTP 提供脑图 Web 调试页（out/web_dev.html），便于浏览器 / VS Code Simple Browser 开发调试。"
            "最终网页是否更新取决于源码保存后的 tsc 编译与（默认开启的）watch/轮询，"
            "与 package.json 的 version 是否递增无关。"
        )
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="http.server 绑定地址（默认 127.0.0.1）。",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="HTTP 端口（默认 8765，与 gen_web_dev_html.js 一致）。",
    )
    parser.add_argument(
        "--browser",
        choices=("system", "ide", "edge-app", "none"),
        default="ide",
        help=(
            "打开方式：ide=复制 URL 并提示用 VS Code/Cursor「Simple Browser」打开（内置网页视图）；"
            "system=系统默认浏览器；edge-app=Windows 下 Edge 应用窗口；none=仅打印 URL。"
        ),
    )
    parser.add_argument(
        "--bump-version",
        action="store_true",
        help="将 package.json 的 patch +1（与 build.py 类似；日常调试默认不改版本号）。",
    )
    parser.add_argument(
        "--no-watch",
        action="store_true",
        help="不启动 tsc --watch 与文件轮询（关闭保存后自动编译与浏览器自动刷新）。",
    )
    args = parser.parse_args()

    ext_dir = Path(__file__).resolve().parent

    if args.bump_version:
        _bump_extension_version(ext_dir)

    npm_cmd = _find_exe(
        [
            "npm.cmd",
            "npm",
            r"C:\Program Files\nodejs\npm.cmd",
            r"C:\Program Files\nodejs\npm.ps1",
        ]
    )
    node_cmd = _find_exe(
        [
            "node",
            "node.exe",
            r"C:\Program Files\nodejs\node.exe",
        ]
    )
    if not npm_cmd:
        print("error: npm not found. Please install Node.js.", file=sys.stderr)
        return 1
    if not node_cmd:
        print("error: node not found. Please install Node.js.", file=sys.stderr)
        return 1

    # Same as run.py: extension compile needs local devDependencies.
    _ensure_jsmind_media(ext_dir, npm_cmd)
    _run([npm_cmd, "run", "compile"], cwd=ext_dir)
    print(
        "热更新说明：保存项目源码后，由 tsc（及默认的 watch）更新 out/ 与 web_dev.html，"
        "再通过 web_dev_meta.json 触发浏览器刷新；与是否修改 package.json 版本号无关。",
        flush=True,
    )
    print(f"当前 package.json version（仅供参考）: {_read_package_version(ext_dir)}", flush=True)

    # HTML 内资源 URL 必须与访问主机一致；全接口监听时仍用 127.0.0.1 生成，本机访问无误。
    gen_host = "127.0.0.1" if args.host in ("0.0.0.0", "::", "[::]") else args.host
    _gen_web_dev_html(ext_dir, node_cmd, gen_host, args.port)

    url = _page_url(args.host, args.port)

    handler = _make_web_dev_handler(ext_dir)
    try:
        httpd = socketserver.ThreadingTCPServer((args.host, args.port), handler)
    except OSError as e:
        print(f"error: cannot bind {args.host}:{args.port} — {e}", file=sys.stderr)
        print(f"预期访问地址（未成功监听）: {url}", file=sys.stderr, flush=True)
        return 1
    httpd.allow_reuse_address = True
    print(
        f"+ http.server ThreadingTCPServer {args.host}:{args.port} (GET / → out/web_dev.html)",
        flush=True,
    )
    print(f"(cwd: {ext_dir})", flush=True)
    # 放在 watch 与 serve_forever 之前，避免被 tsc 输出顶掉、或误以为没有地址
    print("", flush=True)
    print("------------------------------------------------------------", flush=True)
    print(f"  访问地址: {url}", flush=True)
    print("------------------------------------------------------------", flush=True)
    print("", flush=True)

    stop_event = threading.Event()
    watch_proc: subprocess.Popen | None = None
    watch_log_fp: TextIO | None = None
    if not args.no_watch:
        watch_proc, _watch_th, watch_log_fp = _run_web_dev_watch(
            ext_dir, npm_cmd, node_cmd, gen_host, args.port, stop_event
        )
        if watch_proc:
            log_rel = Path("out") / "web_dev_tsc_watch.log"
            print(
                f"+ 已后台运行 npm run watch（tsc --watch）；输出写入 {log_rel}，避免刷屏覆盖上方访问地址。",
                flush=True,
            )
            print(
                "+ 修改 src 后将自动编译；panel.ts 变更会重生成 web_dev.html，页面约 0.6s 内自动刷新。",
                flush=True,
            )

    try:
        if args.browser == "ide":
            if _copy_clipboard(url):
                print("已将 URL 复制到剪贴板。", flush=True)
            print(
                "在 VS Code / Cursor 内置 Simple Browser 中打开："
                "Ctrl+Shift+P → 输入并选择「Simple Browser: Show」→ 粘贴 URL（若未复制请手动粘贴上方地址）。",
                flush=True,
            )
        elif args.browser == "system":
            webbrowser.open(url)
        elif args.browser == "edge-app":
            if sys.platform == "win32" and _open_edge_app_windows(url):
                print("已用 Edge 应用窗口打开。", flush=True)
            else:
                print("warning: Edge --app 不可用，改用系统默认浏览器。", file=sys.stderr)
                webbrowser.open(url)
        else:
            pass

        print("按 Ctrl+C 停止本地 HTTP 服务。", flush=True)
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("", flush=True)
    finally:
        stop_event.set()
        if watch_proc is not None:
            watch_proc.terminate()
            try:
                watch_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                watch_proc.kill()
        if watch_log_fp is not None:
            try:
                watch_log_fp.close()
            except OSError:
                pass
        httpd.shutdown()
        httpd.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
