from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path


def _run(cmd: list[str], *, cwd: Path) -> None:
    print("+ " + " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=str(cwd), check=True)


def _find_exe(candidates: list[str]) -> str | None:
    for c in candidates:
        # First: PATH lookup
        p = shutil.which(c)
        if p:
            return p
        # Second: absolute path check
        if Path(c).is_file():
            return str(Path(c).resolve())
    return None


def _load_package_json(package_json_path: Path) -> dict:
    return json.loads(package_json_path.read_text(encoding="utf-8"))


def _bump_patch_version(version: str) -> str:
    # Simple semver bump: x.y.z -> x.y.(z+1)
    # Only works when version starts with three numeric parts.
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
        # Use groups explicitly to avoid ambiguous backrefs like \10 when the replacement starts with digits.
        return m.group(1) + new_version + m.group(3)

    new_text, n = re.subn(r'("version"\s*:\s*")([^"]+)(")', repl, text, count=1)
    if n != 1 or new_text == text:
        raise RuntimeError(f"failed to update version in {package_json_path}")
    package_json_path.write_text(new_text, encoding="utf-8")


def _rm_tree(p: Path) -> None:
    # Best-effort recursive delete.
    if not p.exists():
        return
    if p.is_dir():
        shutil.rmtree(p, ignore_errors=True)
    else:
        try:
            p.unlink()
        except OSError:
            pass


def _update_changelog(ext_dir: Path, version: str) -> None:
    """
    Auto-maintain doc/CHANGELOG.md.
    - Create file if missing.
    - Insert a new version section when absent.
    - Keep newest version entry at the top.
    """
    doc_dir = ext_dir / "doc"
    doc_dir.mkdir(parents=True, exist_ok=True)
    changelog_path = doc_dir / "CHANGELOG.md"

    if changelog_path.is_file():
        current = changelog_path.read_text(encoding="utf-8")
    else:
        current = (
            "# Changelog\n\n"
            "本文件由构建流程自动维护版本条目；每次打包会自动插入当次版本节。\n\n"
        )

    heading = f"## v{version} - {date.today().isoformat()}"
    if heading in current or f"## v{version} -" in current:
        return

    entry = (
        f"{heading}\n\n"
        "- 自动记录：执行 build.py 触发版本打包。\n"
        "- 变更说明：请在此补充本次主要修改点。\n\n"
    )

    if current.startswith("# Changelog"):
        split_idx = current.find("\n\n")
        if split_idx != -1:
            prefix = current[: split_idx + 2]
            rest = current[split_idx + 2 :]
            new_text = prefix + entry + rest
        else:
            new_text = current + "\n\n" + entry
    else:
        new_text = "# Changelog\n\n" + entry + current

    changelog_path.write_text(new_text, encoding="utf-8")


def main() -> int:
    ext_dir = Path(__file__).resolve().parent
    package_json_path = ext_dir / "package.json"
    if not package_json_path.is_file():
        print(f"error: missing {package_json_path}", file=sys.stderr)
        return 1

    pkg = _load_package_json(package_json_path)
    ext_name = pkg.get("name", "mindmap-vscode")
    version = str(pkg.get("version", "0.0.0"))

    # Auto bump patch version before build/package.
    new_version = _bump_patch_version(version)
    if new_version != version:
        _set_version_in_package_json(package_json_path, new_version)
        version = new_version
    _update_changelog(ext_dir, version)

    out_dir = ext_dir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    vsix_path = out_dir / f"{ext_name}-{version}.vsix"

    npm_cmd = _find_exe(
        [
            "npm.cmd",
            "npm",
            r"C:\Program Files\nodejs\npm.cmd",
            r"C:\Program Files\nodejs\npm.ps1",
        ]
    )
    npx_cmd = _find_exe(
        [
            "npx.cmd",
            "npx",
            r"C:\Program Files\nodejs\npx.cmd",
        ]
    )
    if not npm_cmd:
        print("error: cannot find npm (npm.cmd). Please ensure Node.js is installed.", file=sys.stderr)
        return 1
    if not npx_cmd:
        print("error: cannot find npx (npx.cmd). Please ensure Node.js is installed.", file=sys.stderr)
        return 1

    # 1) Ensure deps
    node_modules = ext_dir / "node_modules"
    need_install = not node_modules.is_dir() or not (node_modules / "jsmind").is_dir()
    if need_install:
        _run([npm_cmd, "install"], cwd=ext_dir)
    else:
        # lightweight check: keep as-is to avoid churn
        pass

    # 2) Compile TS -> dist
    _run([npm_cmd, "run", "compile"], cwd=ext_dir)

    # 2.3) Build Pencil-style MCP stdio server (tools/mindmap_vscode/mcp-server)
    mcp_dir = ext_dir / "mcp-server"
    mcp_nm = mcp_dir / "node_modules"
    if mcp_dir.is_dir() and (mcp_dir / "package.json").is_file():
        if not mcp_nm.is_dir():
            _run([npm_cmd, "install"], cwd=mcp_dir)
        _run([npm_cmd, "run", "build"], cwd=mcp_dir)

    # 2.5) Copy jsMind assets into extension bundle (offline support)
    jsmind_src_dir = ext_dir / "node_modules" / "jsmind"
    # jsMind package layout differs by distribution; for v0.9.1 it is usually:
    # - es6/jsmind.js
    # - style/jsmind.css
    jsmind_js_src = jsmind_src_dir / "es6" / "jsmind.js"
    jsmind_css_src = jsmind_src_dir / "style" / "jsmind.css"
    media_jsmind_dir = ext_dir / "media" / "jsmind"

    if not jsmind_js_src.is_file() or not jsmind_css_src.is_file():
        print(f"error: missing jsMind assets: {jsmind_js_src} / {jsmind_css_src}", file=sys.stderr)
        return 1

    _rm_tree(media_jsmind_dir)
    media_jsmind_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(jsmind_js_src, media_jsmind_dir / "jsmind.js")
    shutil.copy2(jsmind_css_src, media_jsmind_dir / "jsmind.css")

    # 3) Package to VSIX via vsce (downloaded via npx)
    # Note: vsce is free to use for packaging.
    _run(
        [
            npx_cmd,
            "vsce",
            "package",
            "--out",
            str(vsix_path),
            "--dependencies",
            "--allow-missing-repository",
            "--no-update-package-json",
            version,
        ],
        cwd=ext_dir,
    )

    print(f"build ok: {vsix_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

