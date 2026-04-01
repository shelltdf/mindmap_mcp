from __future__ import annotations

import argparse
import http.server
import os
import shutil
import socketserver
import subprocess
import sys
import webbrowser
from pathlib import Path
from urllib.parse import urlparse


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
    args = parser.parse_args()

    ext_dir = Path(__file__).resolve().parent

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

    # HTML 内资源 URL 必须与访问主机一致；全接口监听时仍用 127.0.0.1 生成，本机访问无误。
    gen_host = "127.0.0.1" if args.host in ("0.0.0.0", "::", "[::]") else args.host
    _gen_web_dev_html(ext_dir, node_cmd, gen_host, args.port)

    url = _page_url(args.host, args.port)

    handler = _make_web_dev_handler(ext_dir)
    try:
        httpd = socketserver.ThreadingTCPServer((args.host, args.port), handler)
    except OSError as e:
        print(f"error: cannot bind {args.host}:{args.port} — {e}", file=sys.stderr)
        return 1
    httpd.allow_reuse_address = True
    print(
        f"+ http.server ThreadingTCPServer {args.host}:{args.port} (GET / → out/web_dev.html)",
        flush=True,
    )
    print(f"(cwd: {ext_dir})", flush=True)

    try:
        print(f"Web dev URL: {url}", flush=True)
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
        httpd.shutdown()
        httpd.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
