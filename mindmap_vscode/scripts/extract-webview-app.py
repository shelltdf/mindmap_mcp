# One-off: extract webview inline script from panel.ts -> media/webview-app.js
import pathlib

root = pathlib.Path(__file__).resolve().parents[1]
panel = root / "src" / "panel.ts"
out = root / "media" / "webview-app.js"
lines = panel.read_text(encoding="utf-8").splitlines(keepends=True)
# Lines 3413-8425 inclusive (1-based) -> slice [3412:8425]
chunk = "".join(lines[3412:8425])
prepend = """var el = document.getElementById('mindmap-boot-json');
var __MINDMAP_BOOT__ = {};
if (el && el.textContent) {
  try {
    __MINDMAP_BOOT__ = JSON.parse(el.textContent);
  } catch (e0) {}
}

"""
out.write_text(prepend + chunk, encoding="utf-8")
print(out, "bytes", len(prepend + chunk))
