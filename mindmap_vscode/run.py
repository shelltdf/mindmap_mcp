from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def _run(cmd: list[str], cwd: Path) -> None:
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Run desktop mode for mindmap-vscode.")
    parser.add_argument(
        "--build-desktop",
        action="store_true",
        help="Build desktop distributables instead of launching dev app.",
    )
    parser.add_argument(
        "--target",
        choices=["win", "linux", "mac"],
        default="win",
        help="Desktop package target when --build-desktop is set.",
    )
    args = parser.parse_args()

    ext_dir = Path(__file__).resolve().parent
    desktop_dir = ext_dir / "desktop"
    if not desktop_dir.is_dir():
        print(f"error: desktop dir not found: {desktop_dir}", file=sys.stderr)
        return 1

    npm_cmd = _find_exe(
        [
            "npm.cmd",
            "npm",
            r"C:\Program Files\nodejs\npm.cmd",
            r"C:\Program Files\nodejs\npm.ps1",
        ]
    )
    if not npm_cmd:
        print("error: npm not found. Please install Node.js.", file=sys.stderr)
        return 1

    # Ensure extension TS is compiled so desktop can reuse dist/shared/mindmapCore.js
    _run([npm_cmd, "run", "compile"], cwd=ext_dir)

    if not (desktop_dir / "node_modules").is_dir():
        _run([npm_cmd, "install"], cwd=desktop_dir)

    if args.build_desktop:
        script = {
            "win": "build:win",
            "linux": "build:linux",
            "mac": "build:mac",
        }[args.target]
        _run([npm_cmd, "run", script], cwd=desktop_dir)
    else:
        _run([npm_cmd, "run", "start"], cwd=desktop_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
