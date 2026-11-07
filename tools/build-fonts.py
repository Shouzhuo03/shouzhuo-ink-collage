#!/usr/bin/env python3
"""Rebuild the subset font in ../fonts from the original OFL release.

Needs:  pip install fonttools brotli

Source (download it next to this script first):
  SourceHanSerifCN-Medium.otf
    https://raw.githubusercontent.com/adobe-fonts/source-han-serif/release/SubsetOTF/CN/SourceHanSerifCN-Medium.otf
  Other weights live next to it (Regular, SemiBold, Bold, ...); add a line to JOBS for each.

What it does:
  1. Builds the character set: all 6763 GB2312 hanzi, the GB2312 symbol rows,
     printable ASCII and common CJK punctuation.
  2. Subsets the font to that set as WOFF2.
  3. Renames the family (InkSerif SC). The original is SIL OFL 1.1 with the
     Reserved Font Name "Source", and a subset counts as a modified version,
     so it may not keep the original name.

To cover more characters, add them to EXTRA below (or swap GB2312 for GBK).
"""
import pathlib
import subprocess
import sys

from fontTools.ttLib import TTFont

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "fonts"
EXTRA = "，。、；：？！“”‘’（）《》〈〉【】「」『』…—·～￥　〇"

JOBS = [
    # source file,                  output,           family,        postscript name
    ("SourceHanSerifCN-Medium.otf", "InkSerif.woff2", "InkSerif SC", "InkSerifSC-Medium"),
]


def charset() -> str:
    chars = set()
    for hi in range(0xA1, 0xF8):          # A1-A9 symbols, B0-F7 hanzi
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    chars.update(chr(c) for c in range(0x20, 0x7F))
    chars.update(EXTRA)
    return "".join(sorted(chars))


def rename(path: pathlib.Path, family: str, ps: str) -> None:
    f = TTFont(path)
    sub = "Medium" if ps.endswith("Medium") else "Regular"
    for rec in f["name"].names:
        nid = rec.nameID
        if nid in (1, 16, 21):
            rec.string = family
        elif nid == 2:
            rec.string = "Regular"
        elif nid in (17, 22):
            rec.string = sub
        elif nid == 4:
            rec.string = f"{family} {sub}"
        elif nid == 6:
            rec.string = ps
        elif nid == 3:
            rec.string = f"{ps};subset-gb2312"
    if "CFF " in f:
        cff = f["CFF "].cff
        cff.fontNames = [ps]
        top = cff.topDictIndex[0]
        for k in ("FullName", "FamilyName"):
            if hasattr(top, k):
                setattr(top, k, family)
    f.flavor = "woff2"
    f.save(path)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    text_file = HERE / "chars.txt"
    text_file.write_text(charset(), encoding="utf-8")
    for src, out, family, ps in JOBS:
        src_path = HERE / src
        if not src_path.exists():
            sys.exit(f"missing {src_path} (see the URLs at the top of this file)")
        out_path = OUT / out
        subprocess.run([
            sys.executable, "-m", "fontTools.subset", str(src_path),
            f"--text-file={text_file}", "--flavor=woff2", "--layout-features=*",
            "--no-hinting", "--desubroutinize", f"--output-file={out_path}",
        ], check=True)
        rename(out_path, family, ps)
        print(f"{out_path.name}: {out_path.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
