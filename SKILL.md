---
name: pwa
description: Use when 開新 PWA、修離線/安裝/啟動、或改 service worker / manifest / icon。靜態站(GitHub Pages 這類)的離線與安裝實戰守則,附一支跑得動的檢查器 pwa-check。觸發詞:PWA、service worker、離線、安裝不出來、快取、manifest、maskable、beforeinstallprompt、斷網。
---

# PWA 離線 / 安裝 / 啟動

這份清單裡的每一條都是**上線後才被使用者踩到**才寫下來的。共同特徵是:壞掉的時候
**功能看起來完全正常**——圖照顯示、頁照開、fetch 照回 200——只有真的斷網、真的用
媒體元素播、真的用手機裝，才會現形。所以規則配一支檢查器,別靠記性。

## 先跑檢查器

```bash
NODE_PATH=$(npm root -g) node ~/pwa-skill/tools/pwa-check.mjs <站台目錄>
node ~/pwa-skill/tools/pwa-check.mjs <站台目錄> --static-only    # 不需要 playwright
bash ~/pwa-skill/tools/sweep.sh                                 # 掃全機所有 PWA,印成一張表
```

**要判斷「所有站是不是都合規」就跑 sweep,不要自己列清單** —— 手列一定會漏(實測漏了 4 個站)。

它會起一個**仿 GitHub Pages headers** 的本機 server(`Vary: Accept-Encoding` + Range + ETag),
用 Playwright 裝 SW、模擬一次改版、斷網,然後驗:入口頁都掛得起來、manifest/icon 沒說謊、
不會刪掉同 origin 別站的快取、離線包實查完整、媒體真的能解碼。

**普通的本機 `python3 -m http.server` 對這幾類 bug 零鑑別力**——不回 `Vary`,問題就永遠不出現。

## Service Worker

- **每個可能被單獨開啟或分享的頁都是入口**(章節頁、詳情頁、攻略頁、`home.html`),
  每一頁都要各自掛 manifest + icon links + 註冊 SW。只掛首頁 = 從分享連結進來的人
  **完全看不到安裝選項**。做法:把這道轉換寫進建置/同步腳本,別靠人記得。
- **activate 清舊快取一定要限定自己的前綴**:`CacheStorage 是 per-origin`,
  `<user>.github.io` 底下所有專案共用同一份(SW 的 scope 只管 fetch,管不到快取)。
  無差別 `caches.delete` = 每次改版把別站的離線包整包清空,而且毫無徵兆。
  ```js
  keys.filter(k => k.startsWith('myapp-') && !KEEP.includes(k)).map(k => caches.delete(k))
  ```
  前綴要**跨專案唯一**(`cs-` 這種兩字母的很容易撞)。
- **快取按「壽命」分層**,不要全部綁同一個版本名:`SHELL`(HTML/JS/data,每次部署 bump)
  + `ASSET`(圖/音,只有同名檔換內容才 bump)。
  **gewu-jianghu-web 實測**(見該 repo `NOTES.md`):兩者共用一個 `CACHE` 而它每次部署都 bump,
  `activate` 就把 `assets/` 整包 33MB 刪掉重抓;改版後若瀏覽器 HTTP 快取已被清,實抓 **28.86MB**,
  分層之後同樣情境是 **0.84MB**(分層後 SHELL 只剩約 0.4MB)。
  省流量還是其次,**真正的問題是每次重寫 33MB 都在製造掉檔窗口**:`cache.put` 失敗
  (配額不足、SW 被回收)是靜默的,排最後、檔案最大的音檔最容易掉,結果就是「圖都在、音樂不能播」。
  改成分層的那一版要**一次性接手舊快取**的資產,否則修好的那次反而讓既有使用者再付一次全量。
- 路由策略:**HTML network-first**(線上拿最新、離線吃快取)、**hashed 資源 cache-first**。
- 版號**用內容 hash 由腳本產生**,別手動 bump——手動的遲早會忘。
  沒有 build step、非手動不可的 repo,就讓 `pwa-check` 的「版號 bump 檢查」把關:
  它比對 `origin/HEAD`,只要動到 precache 清單裡的檔而 `sw.js` 沒動就 FAIL
  (瀏覽器根本不會知道有新版),`sw.js` 動了但快取名沒變則 WARN(cache-first 的資源吃舊的)。
- `install` 用 `Promise.allSettled(...c.add)` 取代 `addAll`:單一檔失敗不整批擋掉更新。
- `cache.put` 一律 await + catch,並用**同步呼叫**的 `event.waitUntil` 佔住 SW 壽命
  (await 之後才叫可能拿到 InvalidStateError)。
- 自動重載要監聽 **`controllerchange`**,不是 `state === 'installed'`——後者新 SW 還沒接管,
  reload 仍被舊 SW 控制拿舊快取。並且只在「已有舊 SW 時偵測到新版」才重載,首次造訪不要。

## GitHub Pages + 媒體檔:`ignoreVary` 不是選配

Pages 對每個檔都回 `Vary: Accept-Encoding`。暖快取用 `fetch()` 存進去時帶 `gzip/br`,
而 **`<audio>`/`<video>` 送的是 `Accept-Encoding: identity`** → `cache.match(request)`
因 Vary 比對失敗而 **miss** → 掉到 `fetch()` → 斷網失敗 → `MEDIA_ELEMENT_ERROR: Format error`。

- 症狀極具誤導性:**快取裡的位元組完全正確**,「命中快取」「fetch 回 200」這類檢查全部照過,
  小檔(約 144KB)還會過、大檔(≥464KB)全掛,看起來像「只有某幾首沒聲」。
- 正解:資產以 URL 為鍵,一律 `{ ignoreSearch: true, ignoreVary: true }`。
- **但 `ignoreVary` 到底有沒有在治這個症狀,存疑(2026-08-07 實測)**:把 gewu 的 `ignoreVary`
  拿掉後,預設比對照樣命中、斷網照樣播得出來,負控制**沒有重現**。合理解釋是 `Accept-Encoding`
  屬 forbidden header、由網路層送出時才加,Cache API 比 Vary 時兩邊 Request 物件都沒有這欄位。
  當初 gewu 是線上真實觀察到的症狀,同一批還加了 206 合成 —— **真正治好的可能是 206 那條**。
  結論:`ignoreVary` 照加(無害、成本零),但別把它當保證;會不會播,只有真的 decode 過才知道。
- 從快取回應帶 `Range` 的請求要**自己合成 206**(補 `Content-Range`/`Content-Length`);
  回「200 但沒有 Content-Range」有些情境會被媒體端拒收。
- 導覽 fallback 也要 `ignoreSearch`,否則 `preview.html?city=x` 這種帶 query 的路由
  離線時 miss → 掉到首頁 → 開錯頁。

## 離線完整度:徽章不准自我宣告

- `fetch()` 成功 **≠** 存進快取:配額不足、SW 被回收時 `cache.put` 會失敗,而 `fetch` 照回 200。
  數「fetch 成功次數」當完成度會謊報(實際撞過 ready=true 但快取只有 151/160)。
- 正解:暖完回頭問 SW 逐項 `cache.match` **實查**,一個不缺才顯示「已可離線」,補不齊就顯示真實數字。
- 重資產排在 precache 清單最後 = 最容易掉的就是它們。開場會用到的要提到最前面。

## 字型

- 換自架的做法:`tools/selfhost-font.py`(下載 TTF → pyftsubset → woff2 + @font-face)。
  **切多少字看那個字重服務誰**:靜態 UI 文字切 repo 出現過的字就好;
  使用者輸入、AI 產生、每天長大的資料會用到的字重,要切 BIG5 常用字 5,401(約 800KB–1MB)。
  切太省的後果不是壞掉,是**部分字掉到系統字型**——同一行字兩種臉,比全用系統字型還難看。
- **別用 Google Fonts CDN**:跨域 → SW 不能快取 → 每次連外網 + 離線壞。**自架 woff2**
  (用 `pyftsubset` 只 subset repo 出現過的字)。
- 大 CJK 字型切兩份、同 family 用 `unicode-range`:**UI 子集 preload**(小)+ 完整檔不 preload。

## Icon / Favicon

- **icon 裡面不要再畫一層圓角卡片**:iOS/Android 會在外面套自己的遮罩 → 雙層圓角,
  卡片自己的外陰影還會被切掉。要用現成卡片式素材就把中間擷出來(往內縮約 0.5r 再裁)。
- **maskable 安全區是中央 80%**,內容寬控在 72–76%。素材不夠大就邊緣複製往外補,不要硬縮。
- **置中要用實際 ink 邊界算**,不要目測、也別信 CSS 置中(負字距、side bearing 都會偏)。
- **白底白字靠影子的 icon,32px favicon 要另做一版**(對比拉開約 2 倍再縮)。
- **換 icon 內容一定要改檔名**(`icon-192.png` → `icon-v6-192.png`)。瀏覽器的 favicon
  資料庫特別頑固、常無視快取標頭;SW 是 cache-first;已安裝的 PWA icon 更是安裝當下就烤進去。
  **不要用 `?v=` 查詢字串**。`favicon.ico` 不能改名,只能換內容。
- 改完記得同步:manifest、SW precache 清單、**所有**入口頁的 `<link rel=icon>`、同步腳本。
- manifest 宣告的 `sizes` 與 PNG 實際像素不符 = 安裝門檻靜默不過(`pwa-check` 會讀 IHDR 比對)。

## manifest / 安裝

- `id` 缺了 = app 身份綁在 `start_url` 上,日後改路徑等於變成另一個 app,已安裝的變孤兒。
- `screenshots` 有的話會給**豐富安裝卡**(Play 商店式預覽),沒有就只有陽春提示列。**但要分兩個版位**:
  - `form_factor: "narrow"` = **手機**直式;`form_factor: "wide"`(或不標,規範預設當 wide)= **桌機**橫式。
  - **缺哪一邊,那個平台的安裝就退回陽春**。手機桌機各配至少一張才算完整——只放 narrow 桌機沒卡、只放 wide 手機沒卡(這兩種各自踩過)。
  - 尺寸給實際像素(手機約 540×1110、桌機約 1280×800),`type` 對(webp 也行),截圖只在安裝卡閃現一次、不進 app、不必高品質,轉 webp 省八成。
  - screenshots 不烤進 app、也不必進 SW precache(瀏覽器在安裝提示時自己抓);烤進 app 的是 **icon**。
- **「Android Chrome 選單根本不出現安裝選項」→ 先查 `<meta name="mobile-web-app-capable">`**。
  Chrome 認的是這個,只放已棄用的 `apple-mobile-web-app-capable` 不算。
- **橫式全螢幕**:`display: standalone` 會留一條系統列。加 `display_override: ["fullscreen","standalone"]`。
- **manifest 改動要移除重裝才生效**(安裝當下就烤進去),推上去不會自己變。
- 自家安裝鈕走 `beforeinstallprompt`。**三態**持久化:`'installed'`=永久不再問
  (只在 `appinstalled` 或 `userChoice === 'accepted'` 時寫)/ 時間戳=在這之前安靜 / 空=正常顯示。
- **但「取消靜音」只適用於自動跳的橫幅**。**使用者自己點的安裝鈕,取消原生對話框不得寫任何持久靜音**
  ——他就是想裝才點的,取消常常只是誤觸,結果按鈕消失兩週像壞掉。只在當次瀏覽收起。
- 已安裝之後 Chrome **不會再送 `beforeinstallprompt`**,清 localStorage 也叫不回來(要先移除應用程式)。
- `[hidden]` 會被 `display:flex` 蓋過(橫幅關不掉的常見真因)。

## SEO / OG:PWA 與一般 GitHub Pages 都要,但有分層

`pwa-check` 現在會一起查(靜態,只掃首頁)。哪些是「只要是對外網頁就該有」、哪些是「PWA 特有」,分清楚:

- **不分 PWA、任何對外站都要**:`<meta name="description">`(搜尋摘要,缺了 Google 亂抓)、OG 三件 `og:title/description/image`(FB/Line/Telegram 分享卡)、`twitter:card`(Twitter 大圖)、`canonical`(避免多網址稀釋收錄)、`robots.txt`+`sitemap.xml`(搜尋收錄入口)。
  - **OG 圖是 1200×630 橫幅**,不是 app 圖示。拿方形 icon 當 og:image,分享時會被裁成小方塊或裂圖。要標 `og:image:width/height`(有些平台首次抓圖沒尺寸會裂)。
  - OG 圖進 SW precache(可選)讓爬蟲取圖穩定;`og:image` 用絕對網址。
- **PWA 特有(一般靜態站沒有)**:manifest、SW、screenshots、maskable icon、`mobile-web-app-capable`、離線快取——這些是「能不能裝、能不能離線」的事,純展示站不需要。
- 共通雷:**OG 圖指到不存在的檔**——路徑錯了分享就沒圖,肉眼在自己站上看不出來(那張圖根本不會在頁面顯示),只有 pwa-check 或真的去分享才會現形。

## viewport-fit:預設用 standard,沉浸式才 cover

- **不開 `viewport-fit=cover`(standard,建議預設)**:iOS 全螢幕(加主畫面)時系統自動在瀏海/動態島處留一條安全邊,內容永遠在安全區內——**零維護、任何裝置都不會壞**。那條邊會是背景/`theme_color`,設對就像正常狀態列著色,不醜。大多數內容站/工具站用這個。
- **開 `viewport-fit=cover`(沉浸式)**:內容鋪滿到瀏海底下(背景填滿瀏海旁,好看),但**每個貼頂/貼底的固定元件都得自己用 `env(safe-area-inset-*)` 閃避**,漏一個 iOS 全螢幕就被動態島蓋住、按鈕點不到。只有「背景就是主視覺、要滿版才好看」的 app(深色頻譜播放器、遊戲)才值得,用了就必須處理所有貼邊元件 + 真機測一次。
- **實測數據(2026-08 一輪 23 站)**:開 cover 的 7 站有 4 站是壞的(沒配 env top),standard 的十幾站零問題。**cover 是不主動維護就會咬人的陷阱**——不確定就別開。
- **env() 不需 JS 偵測機型**:它在 Android/無瀏海裝置自動=0、瀏海 iPhone 自動=安全區高;不同 iPhone 瀏海高度不一,寫死數字或看 UA 會錯。
- **RWD 覆寫的雷**:若貼頂元件在窄螢幕斷點有 padding 覆寫,只改基礎那行會在真手機被覆寫掉失效——每個會生效的斷點都要補 env。
- `pwa-check` 會抓:用了 cover 卻整站找不到任何 `safe-area-inset-top` → WARN。

## 手機版面

- **`height:100%` 在手機不等於可見高度**(會解到含瀏覽器 chrome 的大視窗)。用 **`100dvh`**,
  前一行留 `height:100%` 當舊瀏覽器 fallback。殼與 iframe 都要改。
- **要像 app 就別讓整頁捲**:`html,body{height:100dvh;overflow:hidden;overscroll-behavior:none}`
  + body `flex column`,只讓內容清單自己 `overflow-y:auto`,header/footer `flex:none` 釘住。
- **`padding:16vh` 這種在手機是災難**(844 高的機器等於空 135px);手機斷點改 `rem + env(safe-area-inset-*)`。
- `env(safe-area-inset-*)` 只放對的邊(頂部 bar 用 `-top`),放錯邊會在捲動時抖。
- 固定浮動鈕要有退場態;多顆鈕用 flex 容器排,別各自 `position:fixed` 硬算偏移(按鈕文字會變,硬算必撞)。

## 啟動速度

- 快取只省「下載」,**省不了 JS parse/執行**。重 bundle(three.js 等)要**動態 import 延後**,
  首屏先用靜態 HTML 畫好,引擎背景載。
- 被 gating 的按鈕(「開始」)在重資源就緒前顯示 loading 態,別讓人點空。

## 驗收鐵則

- **命中快取 ≠ 播得出來**:媒體一定要真的用 `<audio>`/`<video>` decode 過才算驗過。
- **本機測試 server 必須仿 Pages 的 headers**,否則對這類 bug 零鑑別力。
- **偵測類的檢查要配負控制**:把修正還原成舊版,確認檢查真的會紅,再相信它的綠。
