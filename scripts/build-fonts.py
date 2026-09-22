#!/usr/bin/env python3
"""
Generate the ten static font files the proposal template needs.

    python3 -m venv .venv && ./.venv/bin/pip install fonttools
    ./.venv/bin/python scripts/build-fonts.py

Why this exists at all: the brief requires static weight files rather than
variable fonts in the PDF pipeline, and two of the three families ship from Google
Fonts as variable-only. IBM Plex Mono has real statics; Bricolage Grotesque and
Hanken Grotesk must be instanced from their variable masters.

The interesting axis is Bricolage's `opsz` (optical size, 12-96). Every named
instance Google ships sits at opsz=14 — a text cut. The Safeside cover sets its
title at 56pt, and the redesign document uses a face named "Bricolage Display"
there, distinct from the SemiBold and Bold used elsewhere. Rendering the cover
with a text cut scaled up gives tighter spacing and heavier hairlines than the
designer chose: wrong in a way that is hard to name but easy to see side by side.

Output lands in templates/fonts/ and IS committed. These are OFL fonts, bundled
deliberately: fetching them from the web at render time means output that differs
between machines, or silently falls back to a system face.
"""
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "templates" / "fonts"
CACHE = ROOT / ".font-cache"

GF = "https://raw.githubusercontent.com/google/fonts/main/ofl"

VARIABLE_SOURCES = {
    "bricolage": f"{GF}/bricolagegrotesque/BricolageGrotesque%5Bopsz,wdth,wght%5D.ttf",
    "hanken": f"{GF}/hankengrotesk/HankenGrotesk%5Bwght%5D.ttf",
    "hanken-italic": f"{GF}/hankengrotesk/HankenGrotesk-Italic%5Bwght%5D.ttf",
}

STATIC_SOURCES = {
    "IBMPlexMono-Regular.ttf": f"{GF}/ibmplexmono/IBMPlexMono-Regular.ttf",
    "IBMPlexMono-Medium.ttf": f"{GF}/ibmplexmono/IBMPlexMono-Medium.ttf",
    "IBMPlexMono-SemiBold.ttf": f"{GF}/ibmplexmono/IBMPlexMono-SemiBold.ttf",
}

LICENSES = {
    "OFL-BricolageGrotesque.txt": f"{GF}/bricolagegrotesque/OFL.txt",
    "OFL-HankenGrotesk.txt": f"{GF}/hankengrotesk/OFL.txt",
    "OFL-IBMPlexMono.txt": f"{GF}/ibmplexmono/OFL.txt",
}

# (source, output name, axis settings)
#
# NOTE on Bricolage Display: opsz=96 is the display end of the optical axis, and
# wght=400 is an assumption. The sample PDF's font descriptors report StemV=80 for
# every face, so the exporter wrote no usable weight metadata and the real value
# cannot be recovered from the document. Verify against the sample cover page in
# M5 and adjust here — not in CSS — if it reads too light or too heavy.
INSTANCES = [
    ("bricolage", "BricolageGrotesque-Display.ttf", {"opsz": 96, "wght": 400, "wdth": 100}),
    ("bricolage", "BricolageGrotesque-SemiBold.ttf", {"opsz": 14, "wght": 600, "wdth": 100}),
    ("bricolage", "BricolageGrotesque-Bold.ttf", {"opsz": 14, "wght": 700, "wdth": 100}),
    ("hanken", "HankenGrotesk-Regular.ttf", {"wght": 400}),
    ("hanken", "HankenGrotesk-Medium.ttf", {"wght": 500}),
    ("hanken", "HankenGrotesk-SemiBold.ttf", {"wght": 600}),
    ("hanken-italic", "HankenGrotesk-Italic.ttf", {"wght": 400}),
]


def fetch(url: str, dest: Path) -> Path:
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  fetch {dest.name}")
    with urllib.request.urlopen(url) as r, dest.open("wb") as f:
        shutil.copyfileobj(r, f)
    return dest


def main() -> int:
    try:
        from fontTools import varLib  # noqa: F401
    except ImportError:
        print("fonttools is not installed.\n  python3 -m venv .venv && ./.venv/bin/pip install fonttools")
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)

    print("Sources:")
    masters = {k: fetch(u, CACHE / f"{k}.ttf") for k, u in VARIABLE_SOURCES.items()}

    print("\nInstancing variable fonts:")
    for key, out_name, axes in INSTANCES:
        spec = [f"{a}={v}" for a, v in axes.items()]
        subprocess.run(
            [sys.executable, "-m", "fontTools.varLib.instancer",
             str(masters[key]), *spec, "-o", str(OUT / out_name)],
            check=True, capture_output=True,
        )
        print(f"  {out_name:<38} {' '.join(spec)}")

    print("\nStatic families (no instancing needed):")
    for name, url in STATIC_SOURCES.items():
        fetch(url, OUT / name)
        print(f"  {name}")

    print("\nLicenses:")
    for name, url in LICENSES.items():
        fetch(url, OUT / name)
        print(f"  {name}")

    fonts = sorted(p for p in OUT.glob("*.ttf"))
    total = sum(p.stat().st_size for p in fonts)
    print(f"\n{len(fonts)} static fonts in templates/fonts/ ({total // 1024} KB)")
    if len(fonts) != 10:
        print(f"WARNING: expected 10 faces to match the sample document, got {len(fonts)}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
