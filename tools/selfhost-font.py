#!/usr/bin/env python3
"""把 Google Fonts 的字型自架下來(外觀不變),並只切出這個站真的用得到的字。

為什麼:掛 Google Fonts CDN 是跨域,SW 快取不到 → 每次都要連外網、離線一定壞。
自架 + subset 之後,字型跟著離線包一起走。

用法:
  # UI 文字是靜態的站:只切 repo 裡出現過的字(通常 20–60KB)
  selfhost-font.py --family "Noto Sans TC" --weights 400,700 \\
      --out assets/fonts --chars-from index.html app.js

  # 會顯示使用者輸入 / AI 產生文字的站:再加上 BIG5 常用字 5,401(約 800KB)
  selfhost-font.py --family "Noto Sans TC" --weights 900 \\
      --out assets/fonts --chars-from index.html --common

輸出 woff2 到 --out,並把對應的 @font-face CSS 印到 stdout(自己貼進頁面)。
需要:pyftsubset(pip install "fonttools[woff]" brotli)。
"""
import argparse, pathlib, re, subprocess, sys, urllib.request

CSS_API = "https://fonts.googleapis.com/css2?family={}:wght@{}"
# 舊 UA 才會拿到 .ttf(現代 UA 拿到的是已經切好 unicode-range 的 woff2 分片,不能再 subset)
OLD_UA = "Mozilla/4.0"
PUNCT = "　，。、；：？！…—～「」『』（）〈〉《》・‧’“”％＋－×÷＝•‥《》〔〕【】"


def big5_level1() -> set:
    """BIG5 第一階(常用字 5,401)——用內建 codec 反解,不必外掛字表。"""
    out = set()
    for hi in range(0xA4, 0xC7):
        for lo in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
            try:
                ch = bytes([hi, lo]).decode("big5")
            except Exception:
                continue
            if "一" <= ch <= "鿿":
                out.add(ch)
    return out


def ttf_url(family: str, weight: str) -> str:
    req = urllib.request.Request(CSS_API.format(family.replace(" ", "+"), weight),
                                 headers={"User-Agent": OLD_UA})
    css = urllib.request.urlopen(req, timeout=60).read().decode("utf-8")
    m = re.search(r"https://[^)\s]+\.ttf", css)
    if not m:
        sys.exit(f"拿不到 {family} {weight} 的 ttf —— 檢查字型名稱與字重是否存在")
    return m.group(0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--family", required=True)
    ap.add_argument("--weights", required=True, help="逗號分隔,如 400,700,900")
    ap.add_argument("--out", required=True)
    ap.add_argument("--chars-from", nargs="*", default=[], help="從這些檔案取出用到的字")
    ap.add_argument("--common", action="store_true", help="加上 BIG5 常用字(使用者/AI 產生的文字要用)")
    ap.add_argument("--url-prefix", default="", help="CSS src 的路徑前綴,如 assets/fonts/")
    ap.add_argument("--display", default="swap")
    a = ap.parse_args()

    chars = set(chr(c) for c in range(0x20, 0x7F)) | set(PUNCT)
    for f in a.chars_from:
        p = pathlib.Path(f)
        if p.exists():
            chars |= set(p.read_text(encoding="utf-8", errors="ignore"))
    if a.common:
        chars |= big5_level1()
    chars = {c for c in chars if c.isprintable() and c not in "\r\n\t"}

    outdir = pathlib.Path(a.out)
    outdir.mkdir(parents=True, exist_ok=True)
    txt = outdir / ".subset-chars.txt"
    txt.write_text("".join(sorted(chars)), encoding="utf-8")

    slug = a.family.lower().replace(" ", "-")
    css = []
    for w in a.weights.split(","):
        w = w.strip()
        url = ttf_url(a.family, w)
        raw = outdir / f".{slug}-{w}.ttf"
        raw.write_bytes(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": OLD_UA}), timeout=180).read())
        dst = outdir / f"{slug}-{w}.woff2"
        subprocess.run(["pyftsubset", str(raw), f"--text-file={txt}", "--flavor=woff2",
                        "--layout-features=", "--no-hinting", "--desubroutinize",
                        f"--output-file={dst}"], check=True)
        raw.unlink()
        print(f"  {dst}  {dst.stat().st_size // 1024} KB  ({len(chars)} 字)", file=sys.stderr)
        css.append(f"""@font-face{{font-family:"{a.family}";font-style:normal;font-weight:{w};
  font-display:{a.display};src:url("{a.url_prefix}{dst.name}") format("woff2")}}""")
    txt.unlink()
    print("\n".join(css))


if __name__ == "__main__":
    main()
