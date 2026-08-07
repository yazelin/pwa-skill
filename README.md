# pwa-skill

靜態 PWA(GitHub Pages 這類)的離線 / 安裝 / 啟動守則，加一支跑得動的檢查器。

規則寫在 [SKILL.md](SKILL.md)，每一條都是上線後被使用者踩到才記下來的。檢查器
`tools/pwa-check.mjs` 負責把其中「壞掉時看不出來」的那幾條變成會紅的測試。

## pwa-check

```bash
NODE_PATH=$(npm root -g) node tools/pwa-check.mjs <站台目錄>
node tools/pwa-check.mjs <站台目錄> --static-only     # 不需要 playwright
node tools/pwa-check.mjs <站台目錄> --settle 40000    # 資產多、暖快取慢的站
node tools/pwa-check.mjs <站台目錄> --json
```

會自己找站台根目錄（`sw.js` 與 `index.html` 同在的那層，支援 `docs/`、`public/`、`web/`）。

**靜態檢查**（不開瀏覽器）

- 每個可被單獨分享的 HTML 都掛了 manifest 並註冊 SW，也有 `mobile-web-app-capable`
- manifest 必要欄位、192/512/maskable 齊全、icon 檔存在、**PNG 實際像素與宣告尺寸相符**
- `activate` 清快取有前綴保護（沒有的話會刪掉同 origin 其他站的離線包）
- 站內有媒體檔時，SW 的 `cache.match` 有 `ignoreVary`、有合成 206
- 沒有把字型掛在 Google Fonts CDN 上
- **改了被快取的檔卻沒 bump 版號**（對照 `origin/HEAD`，可用 `--base` 換基準）：
  `sw.js` 一個位元組都沒動 = 瀏覽器不知道有新版 → FAIL；`sw.js` 變了但快取名沒變 =
  cache-first 的資源仍回舊快取那份 → WARN

**執行期檢查**（Playwright + 仿 GitHub Pages headers 的本機 server）

- SW 真的接管了頁面
- 離線包覆蓋率：拿 SW 裡的資源清單回頭**逐項實查快取**，不採信 fetch 次數
- **不刪別站快取**：在同 origin 種一個鄰站快取，逼本站跑一次改版 activate，看它還在不在
- 斷網後首頁真的開得起來
- **斷網後最大的媒體檔真的能 decode**（命中快取不等於播得出來）

仿 Pages 的 headers（`Vary: Accept-Encoding` + Range + ETag）是關鍵：普通的
`python3 -m http.server` 對這幾類 bug 零鑑別力，問題會一路漏到線上。

### 可選設定

站台根目錄放 `.pwa-check.json`：

```json
{ "ignore": ["og-card.html", "verify.html"], "settleMs": 30000 }
```

`ignore` 列的 HTML 不當入口頁看待（產圖用的卡片、內部工具頁這類）。


## selfhost-font.py

把 Google Fonts 換成自架 woff2（外觀不變），只切這個站真的用得到的字。

```bash
# 靜態 UI 文字：只切 repo 裡出現過的字（通常 20–170KB）
python3 tools/selfhost-font.py --family "Noto Sans TC" --weights 400,700 \
    --out assets/fonts --url-prefix "assets/fonts/" --chars-from index.html app.js

# 會顯示使用者輸入 / AI 產生文字的字重：加 BIG5 常用字 5,401（約 800KB–1MB）
python3 tools/selfhost-font.py --family "Noto Sans TC" --weights 900 \
    --out assets/fonts --url-prefix "assets/fonts/" --chars-from index.html --common
```

woff2 產到 `--out`，對應的 `@font-face` CSS 印到 stdout，自己貼進頁面並刪掉 Google 的 link。
常用字表用 Python 內建的 big5 codec 反解，不需要外部字表。

需要 `pyftsubset`（`pip install "fonttools[woff]" brotli`）。


## sweep.sh

掃全機的 PWA，逐站跑 `pwa-check`，印成一張表。

```bash
bash tools/sweep.sh              # 掃 $HOME
bash tools/sweep.sh ~/projects   # 掃指定目錄
bash tools/sweep.sh --full       # 連執行期檢查一起跑（慢很多）
```

**清單靠掃描產生，不靠人列。**2026-08-07 那次「SW 互刪同 origin 別站快取」就是教訓：
原本以為只有 3 個站，掃過才知道 13 個站在互相清空離線包；後來加了這支 sweep，
又撈出 4 個手打清單沒有的站。

可選:`~/.pwa-sweep-ignore`(一行一個路徑片段)把不該進報告的站排除——例如留在本機當對照的**別人的 repo**。
被排除的會列在「跳過」區,不會靜靜消失。這個檔在家目錄、不在任何 repo 裡,換機要重建。

會處理兩種擺法上的麻煩：`sw.js` 不在 repo 根（`public/`、`static/`、`docs/`）時自動改用它的所在目錄；
同一個 repo 在磁碟上有多份工作副本時只留最後有 commit 的那份，**跳過的會列出來**——靜靜丟掉會讓人以為掃過了。

## 安裝

```bash
git clone https://github.com/yazelin/pwa-skill.git ~/pwa-skill
ln -s ~/pwa-skill ~/.claude/skills/pwa
```

其他 agent（Codex / Gemini）不吃 skill 機制的，直接讀 `SKILL.md` 照著跑腳本即可。

需求：Node 18+；執行期檢查需要 Playwright（`npm i -g playwright && npx playwright install chromium`）。

## License

MIT © 林亞澤

---

如果這個工具對你有幫助:
[GitHub](https://github.com/yazelin) · [Facebook](https://www.facebook.com/yaze.lin.gm) · [Buy Me a Coffee](https://buymeacoffee.com/yazelin)
