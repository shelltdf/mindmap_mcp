# Remove inline webview script block from panel.ts (lines 3411-8426), insert external refs.
import pathlib

root = pathlib.Path(__file__).resolve().parents[1]
panel = root / "src" / "panel.ts"
text = panel.read_text(encoding="utf-8")
lines = text.splitlines(keepends=True)

insert = """    <script nonce="${nonce}" type="application/json" id="mindmap-boot-json">${bootJsonForHtml}</script>
    <script nonce="${nonce}" src="${webviewAppUrl}"></script>
"""
# 0-based: keep 0..3409 (lines 1-3410), skip 3410..8425, keep 8426..
new_lines = lines[:3410] + [insert] + lines[8426:]
panel.write_text("".join(new_lines), encoding="utf-8")
print("patched", panel, "total lines", len(new_lines))
