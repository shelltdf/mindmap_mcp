from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
import json


def _find_cursor_executable() -> str | None:
    # First: try PATH lookup
    for cand in ["cursor", "Cursor", "cursor.cmd", "Cursor.exe", "cursor.cmd"]:
        p = shutil.which(cand)
        if p:
            return p

    # Fallback common install path (Windows)
    candidates: list[str] = []
    username = os.environ.get("USERNAME") or ""
    localapp = os.environ.get("LOCALAPPDATA") or ""
    programfiles = os.environ.get("ProgramFiles") or ""
    programfilesx86 = os.environ.get("ProgramFiles(x86)") or ""

    if programfiles:
        candidates += [
            fr"{programfiles}\\cursor\\resources\\app\\bin\\cursor.cmd",
            fr"{programfiles}\\cursor\\resources\\app\\bin\\cursor.exe",
        ]
    if programfilesx86:
        candidates += [
            fr"{programfilesx86}\\cursor\\resources\\app\\bin\\cursor.cmd",
            fr"{programfilesx86}\\cursor\\resources\\app\\bin\\cursor.exe",
        ]
    if localapp and username:
        candidates += [
            fr"{localapp}\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd",
            fr"{localapp}\\Programs\\cursor\\resources\\app\\bin\\cursor.exe",
        ]

    for p in candidates:
        if p and os.path.isfile(p):
            return p

    return None


def _find_code_executable() -> str | None:
    # Try shutil.which (handles PATHEXT on Windows).
    for cand in ["code", "Code", "code.cmd", "Code.exe", "code.cmd"]:
        p = shutil.which(cand)
        if p:
            return p

    # Fallback common install paths (Windows).
    username = os.environ.get("USERNAME") or ""
    localapp = os.environ.get("LOCALAPPDATA") or ""
    programfiles = os.environ.get("ProgramFiles") or ""
    programfilesx86 = os.environ.get("ProgramFiles(x86)") or ""

    candidates = []
    if localapp:
        candidates += [
            fr"{localapp}\\Programs\\Microsoft VS Code\\bin\\code.cmd",
            fr"{localapp}\\Programs\\Microsoft VS Code\\bin\\Code.exe",
            fr"{localapp}\\Programs\\Microsoft VS Code\\bin\\code.exe",
        ]
    if programfiles:
        candidates += [
            fr"{programfiles}\\Microsoft VS Code\\bin\\code.cmd",
            fr"{programfiles}\\Microsoft VS Code\\bin\\code.exe",
        ]
    if programfilesx86:
        candidates += [
            fr"{programfilesx86}\\Microsoft VS Code\\bin\\code.cmd",
            fr"{programfilesx86}\\Microsoft VS Code\\bin\\code.exe",
        ]

    candidates += [
        rf"C:\Users\{username}\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd",
        rf"C:\Users\{username}\AppData\Local\Programs\Microsoft VS Code\bin\code.exe",
    ]

    for p in candidates:
        if p and os.path.isfile(p):
            return p

    return None


def main() -> int:
    ext_dir = Path(__file__).resolve().parent
    out_dir = ext_dir / "out"
    if not out_dir.is_dir():
        print(f"error: missing out dir: {out_dir}", file=sys.stderr)
        return 1

    pkg_path = ext_dir / "package.json"
    pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    publisher = pkg.get("publisher", "ai-dev")
    name = pkg.get("name", "mindmap-vscode")
    version = str(pkg.get("version", "0.0.0"))
    ext_id = f"{publisher}.{name}"

    # Prefer installing the vsix that matches current package.json version.
    expected_vsix = out_dir / f"{name}-{version}.vsix"
    if expected_vsix.is_file():
        vsix_path = expected_vsix.resolve()
    else:
        # Fallback: install newest vsix to keep behavior robust.
        vsix_files = sorted(out_dir.glob("*.vsix"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not vsix_files:
            print(f"error: no .vsix under {out_dir}", file=sys.stderr)
            return 1
        vsix_path = vsix_files[0].resolve()
        print(
            f"warning: expected vsix not found: {expected_vsix}. "
            f"falling back to newest: {vsix_path.name}",
            file=sys.stderr,
        )

    cursor_exe = _find_cursor_executable()
    code_exe = _find_code_executable()

    if not cursor_exe and not code_exe:
        print("error: cannot find `cursor` and `code` executable.", file=sys.stderr)
        return 1

    def install_into(exe: str) -> None:
        print(f"installing: {vsix_path} -> {exe}", flush=True)
        subprocess.run(
            [exe, "--install-extension", str(vsix_path), "--force"],
            cwd=str(ext_dir),
            check=True,
        )
        print(f"install ok: {exe}", flush=True)

    if cursor_exe:
        install_into(cursor_exe)
    if code_exe:
        install_into(code_exe)

    # Best-effort: verify installed version (may not reflect activation without reload).
    def list_versions(exe: str) -> str:
        p = subprocess.run(
            [exe, "--list-extensions", "--show-versions"],
            cwd=str(ext_dir),
            capture_output=True,
            text=True,
        )
        return (p.stdout or "") + (p.stderr or "")

    ver_text_cursor = list_versions(cursor_exe) if cursor_exe else ""
    ver_text_code = list_versions(code_exe) if code_exe else ""

    ok_cursor = (f"{ext_id}@{version}" in ver_text_cursor) if cursor_exe else True
    ok_code = (f"{ext_id}@{version}" in ver_text_code) if code_exe else True

    if cursor_exe and not ok_cursor:
        print(f"warning: cursor does not show expected version {ext_id}@{version}", file=sys.stderr)
    if code_exe and not ok_code:
        print(f"warning: vscode does not show expected version {ext_id}@{version}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

