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
