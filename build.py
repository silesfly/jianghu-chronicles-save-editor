#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC_HTML = ROOT / "src" / "editor-page.html"
SRC_DIR = ROOT / "src"
DIST_HTML = ROOT / "dist" / "JianghuChroniclesSaveEditor-v1.0.1.html"
JS_FILES = ["nrbf-codec.js", "catalog-data.js", "editor-core.js", "editor-ui.js"]

HANZI_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\ufaff]")
KANA_RE = re.compile(r"[\u3040-\u30FF]")
URL_RE = re.compile(r"https?://", re.IGNORECASE)


def verify(bundled: str) -> None:
    errors = []
    if re.search(r"<script\s+src\s*=", bundled, re.IGNORECASE):
        errors.append("External script reference remains.")
    if re.search(r'<link\s+rel\s*=\s*["\']stylesheet["\']', bundled, re.IGNORECASE):
        errors.append("Stylesheet link remains.")
    if "default-src 'none'" not in bundled:
        errors.append("CSP is missing default-src 'none'.")
    if "connect-src 'none'" not in bundled:
        errors.append("CSP is missing connect-src 'none'.")
    if HANZI_RE.search(bundled):
        errors.append("Hanzi characters remain.")
    if KANA_RE.search(bundled):
        errors.append("Kana characters remain.")
    if URL_RE.search(bundled):
        errors.append("HTTP(S) URLs remain.")

    opening_scripts = len(re.findall(r"<script\b", bundled, re.IGNORECASE))
    closing_scripts = len(re.findall(r"</script\s*>", bundled, re.IGNORECASE))
    if opening_scripts != closing_scripts:
        errors.append("Opening and closing script tag counts differ.")

    for match in re.finditer(r"<script\b[^>]*>(.*?)</script\s*>", bundled, re.IGNORECASE | re.DOTALL):
        if re.search(r"</script", match.group(1), re.IGNORECASE):
            errors.append("Raw closing script tag found inside a script body.")
            break

    if errors:
        raise ValueError("\n".join(errors))


def build() -> str:
    bundled = SRC_HTML.read_text(encoding="utf-8")
    for name in JS_FILES:
        pattern = re.compile(
            rf"<script\s+src\s*=\s*([\"']){re.escape(name)}\1\s*>\s*</script\s*>",
            re.IGNORECASE,
        )
        content = (SRC_DIR / name).read_text(encoding="utf-8")
        content = re.sub(r"</script", lambda _m: r"<\/script", content, flags=re.IGNORECASE)
        bundled, count = pattern.subn(lambda _m, c=content: f"<script>\n{c}\n</script>", bundled)
        if count != 1:
            raise ValueError(f"Expected exactly one script reference for {name}; found {count}.")
    return bundled


def write_atomic(destination: Path, content: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
            temp_file.write(content)
            temp_file.flush()
            os.fsync(temp_file.fileno())
        os.replace(temp_path, destination)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="강호록 세이브 에디터 단일 HTML 번들러")
    parser.add_argument("--check", action="store_true", help="기존 산출물 또는 새로 빌드한 결과를 검증")
    args = parser.parse_args()

    if args.check and DIST_HTML.exists():
        bundled = DIST_HTML.read_text(encoding="utf-8")
    else:
        bundled = build()

    verify(bundled)
    if not args.check:
        write_atomic(DIST_HTML, bundled)
    print(f"OK: {DIST_HTML} ({len(bundled.encode('utf-8')):,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
