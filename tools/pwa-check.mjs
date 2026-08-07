#!/usr/bin/env node
// pwa-check — 靜態 PWA(GitHub Pages 這類)的離線/安裝實測檢查器。
//
// 為什麼要有這支:SKILL.md 那份清單裡最貴的幾條(Pages 的 Vary 害音檔播不出來、
// SW 互刪同 origin 別站的快取、icon 尺寸對不上)壞掉時**功能看起來完全正常**,
// 靠翻頁、看截圖、按一按都驗不出來。所以規則要有一支跑得動的檢查配對。
//
// 用法:
//   node pwa-check.mjs [站台目錄]            預設 cwd,自動找 index.html + sw.js
//   node pwa-check.mjs . --static-only       只跑靜態檢查(不需要 playwright)
//   node pwa-check.mjs . --settle 30000      暖快取等久一點
//   node pwa-check.mjs . --json              機器可讀輸出
//
// 可選設定檔 <站台目錄>/.pwa-check.json:
//   { "ignore": ["og-card.html"], "settleMs": 20000, "sharedOrigin": true }
//   ignore  —— 不當「入口頁」看待的 HTML(範本、產圖用的卡片、內部工具頁)
//
// 退出碼 0=全過(WARN 不算失敗),1=有 FAIL。
import { readFileSync, existsSync, statSync, readdirSync, cpSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { join, extname, dirname, relative, resolve } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import http from 'http';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SITE = resolve(argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--settle' && argv[argv.indexOf(a) - 1] !== '--root') || '.');

const results = [];
const add = (level, name, detail = '') => { results.push({ level, name, detail }); };
const pass = (n, d) => add('PASS', n, d);
const fail = (n, d) => add('FAIL', n, d);
const warn = (n, d) => add('WARN', n, d);
const info = (n, d) => add('INFO', n, d);

// ---------- 找站台根目錄:sw.js 跟 index.html 都在的那一層 ----------
function findRoot(base) {
  const cands = ['.', 'docs', 'public', 'web', 'dist', 'src'];
  for (const c of cands) {
    const d = join(base, c);
    if (existsSync(join(d, 'sw.js')) && existsSync(join(d, 'index.html'))) return d;
  }
  for (const c of cands) {
    const d = join(base, c);
    if (existsSync(join(d, 'index.html'))) return d;
  }
  return base;
}
const ROOT = resolve(opt('--root', findRoot(SITE)));
const CFG = existsSync(join(ROOT, '.pwa-check.json'))
  ? JSON.parse(readFileSync(join(ROOT, '.pwa-check.json'), 'utf8')) : {};
const IGNORE = new Set(CFG.ignore || []);
const SKIP_DIRS = new Set(['node_modules', '.git', 'tools', 'scripts', 'partials', 'templates', 'test', 'tests', '__pycache__']);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out); }
    else out.push(join(dir, e.name));
  }
  return out;
}
const FILES = existsSync(ROOT) ? walk(ROOT) : [];
const rel = (f) => relative(ROOT, f);
const MEDIA_EXT = new Set(['.mp3', '.ogg', '.m4a', '.wav', '.mp4', '.webm', '.mov']);
const mediaFiles = FILES.filter((f) => MEDIA_EXT.has(extname(f)));
const htmlFiles = FILES.filter((f) => extname(f) === '.html' && !IGNORE.has(rel(f)));
const SW_PATH = join(ROOT, 'sw.js');

// 把 HTML 裡的 src/href 解到磁碟上的檔。絕對路徑要當心:Vite 這類 build 會輸出
// base 前綴(/awei-voice/assets/x.js),直接接在站台根目錄後面會找不到 —— 逐段剝掉
// 前綴再試,否則整站會被誤判成「沒有註冊 SW」(2026-08-07 就是這樣誤報 awei-voice)。
function resolveLocal(url, fromFile) {
  const clean = url.split('?')[0].split('#')[0];
  if (/^(https?:)?\/\//.test(clean)) return null;                 // 跨域的不算本地檔
  const cands = [];
  if (clean.startsWith('/')) {
    const segs = clean.replace(/^\/+/, '').split('/');
    for (let i = 0; i < segs.length; i++) cands.push(join(ROOT, segs.slice(i).join('/')));
  } else {
    cands.push(join(dirname(fromFile), clean), join(ROOT, clean));
  }
  return cands.find((p) => existsSync(p) && statSync(p).isFile()) || null;
}

console.log(`pwa-check — ${ROOT}`);
// dist/ 是 build 產物:沒重新 build 就測,測到的是上一版,結論會是假的(踩過一次)
if (/\/(dist|build|out)$/.test(ROOT)) warn('測的是 build 產物', `${ROOT} —— 先跑一次 build,否則測到的是舊版`);
if (!existsSync(SW_PATH)) { fail('sw.js 存在', '找不到 sw.js,這站沒有 service worker'); report(); process.exit(1); }
const swSrc = readFileSync(SW_PATH, 'utf8');

// ---------- 1. 入口頁:任何可能被單獨開啟/分享的頁都要能安裝 ----------
// 只掛在首頁 = 從分享連結進來的章節頁/詳情頁完全看不到安裝選項。
let anyRegisters = false;
const noReg = [];
for (const f of htmlFiles) {
  const src = readFileSync(f, 'utf8');
  const name = rel(f);
  const hasManifest = /<link[^>]+rel=["']?manifest/i.test(src);
  // 註冊可能寫在頁內,也可能在它載入的本地 js 裡。bundler 打包過的站(vite-plugin-pwa
  // 走 workbox-window,而且是動態 import 的 chunk)靜態追不到那一行 —— 那種情況只出
  // WARN,交給執行期的「SW 接管頁面」驗,不要誤判成沒註冊。
  const bodies = [src];
  for (const m of src.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    const p = resolveLocal(m[1], f);
    if (p) bodies.push(readFileSync(p, 'utf8'));
  }
  const registers = bodies.some((b) => /serviceWorker\s*\.\s*register/.test(b));
  const maybe = !registers && bodies.some((b) => /serviceWorker|workbox|registerSW/i.test(b));
  if (registers || maybe) anyRegisters = true;
  if (!hasManifest) fail(`入口頁掛 manifest:${name}`, '從分享連結單獨開這頁不會出現安裝選項');
  if (maybe) warn(`入口頁註冊 SW:${name}`, '看得到 serviceWorker/workbox 的痕跡但找不到 register 那一行(多半是打包過),執行期檢查會驗');
  else if (!registers) noReg.push(name);
  if (hasManifest && registers) pass(`入口頁 ${name}`, 'manifest + SW 註冊');
  // Chrome 認的是 mobile-web-app-capable,只放已棄用的 apple- 版不算
  if (!/name=["']?mobile-web-app-capable/i.test(src)) {
    warn(`mobile-web-app-capable:${name}`, 'Android Chrome 選單可能不出現「安裝應用程式」');
  }
}
// 沒有任何一頁註冊 SW = 這站根本沒有離線;某幾頁沒註冊只影響「第一次就直接開那頁」的人
// (SW 一旦被註冊過就控制整個 scope),所以分兩級,不要一律判 FAIL。
if (noReg.length) {
  if (!anyRegisters) fail('註冊 SW', `${noReg.join(' ')} 都沒註冊 —— 全站沒有一頁註冊,離線不成立`);
  else warn('入口頁註冊 SW', `${noReg.join(' ')} 自己不註冊;別的頁註冊過之後這些頁也歸 SW 管,但「第一次就開這頁」的人拿不到離線`);
}

// ---------- 2. manifest ----------
const manifestPath = ['manifest.json', 'manifest.webmanifest'].map((n) => join(ROOT, n)).find(existsSync);
if (!manifestPath) fail('manifest 檔存在', '找不到 manifest.json / manifest.webmanifest');
else {
  let mf = null;
  try { mf = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (e) { fail('manifest 是合法 JSON', String(e.message)); }
  if (mf) {
    for (const k of ['name', 'start_url', 'scope', 'display', 'icons']) {
      if (!mf[k]) fail(`manifest.${k}`, '缺這個欄位');
    }
    // id 缺了:日後改 start_url 等於換一個 app,已安裝的變孤兒
    if (!mf.id) warn('manifest.id', '沒有 id,app 身份綁在 start_url 上,改路徑就會變成另一個 app');
    if (!mf.screenshots) warn('manifest.screenshots', 'Android 拿不到豐富安裝卡(只有陽春提示)');
    const icons = mf.icons || [];
    const purposes = icons.flatMap((i) => (i.purpose || 'any').split(/\s+/));
    if (!purposes.includes('maskable')) fail('maskable icon', 'Android 會自己套遮罩,沒有 maskable 版會被切');
    // 一張 sizes:"any" 的 SVG 就能滿足 Chrome 的安裝門檻,不必然要 PNG。但 Android 桌面
    // 對點陣圖比較穩,所以缺 192/512 時只出 WARN,不判 FAIL。
    const anySvg = icons.some((i) => /svg/.test(i.type || '') && (i.sizes || '').split(/\s+/).includes('any'));
    for (const need of ['192x192', '512x512']) {
      if (icons.some((i) => (i.sizes || '').split(/\s+/).includes(need))) continue;
      if (anySvg) warn(`icon ${need}`, '有 sizes:"any" 的 SVG 可以過安裝門檻,但補一張 PNG 在 Android 桌面比較穩');
      else fail(`icon ${need}`, '安裝門檻要求這個尺寸');
    }
    for (const i of icons) {
      const p = resolveLocal(i.src, manifestPath);
      if (!p) { fail(`icon 檔存在:${i.src}`, 'manifest 指到不存在的檔'); continue; }
      if (extname(p) === '.png') {
        // PNG 的 IHDR 就在檔頭,寬高各 4 bytes big-endian。宣告尺寸與實際不符是安裝失敗的常見隱形原因。
        const b = readFileSync(p);
        const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
        const declared = (i.sizes || '').split(/\s+/)[0];
        if (declared && declared !== 'any' && declared !== `${w}x${h}`) {
          fail(`icon 實際尺寸:${i.src}`, `宣告 ${declared},實際 ${w}x${h}`);
        }
      }
    }
    if (!results.some((r) => r.level === 'FAIL' && r.name.startsWith('icon'))) pass('manifest icons', `${icons.length} 個、含 maskable`);
  }
}

// ---------- 3. 跨站互刪:activate 清快取要限定自己的前綴 ----------
// CacheStorage 是 per-origin。<user>.github.io 底下所有專案共用同一份,
// SW 的 scope 只管 fetch、管不到快取。無差別刪 = 每次改版清掉別站的離線包。
{
  const act = /addEventListener\(\s*["']activate["']([\s\S]*?)(?=addEventListener\(\s*["'](?:fetch|message|push|sync)["']|$)/.exec(swSrc);
  const body = act ? act[1] : '';
  if (!/caches\.delete/.test(body)) {
    info('activate 清舊快取', 'activate 裡沒有 caches.delete(不刪就不會誤刪別站,但舊版會一直堆著)');
  } else if (/startsWith\s*\(|CACHE_PREFIX|\.test\s*\(\s*k/.test(body)) {
    pass('跨站互刪防護', 'activate 的刪除有前綴限定');
  } else {
    // 這條只有「跟別站共用 origin」時才是災難。<user>.github.io/<repo>/ 這種專案頁必然共用;
    // 自架在自己網域、或 Pages 根網域的站,整個 origin 就它一個,刪光也只是刪自己的舊快取。
    // 掃所有頁,不是只看 index.html —— 站台根目錄不一定有 index.html(public/ 這種擺法)
    const canon = htmlFiles.flatMap((f) => readFileSync(f, 'utf8').match(/https?:\/\/[^"'\s)]+/g) || [])
      .find((u) => /\.github\.io\/[^/"']+\//.test(u) || /\.pages\.dev\//.test(u));
    if (canon) fail('跨站互刪防護', `activate 無差別刪除,而這站在 ${canon.match(/https?:\/\/[^/]+\/[^/]+\//)[0]} —— 會清掉同 origin 其他專案的離線包(功能正常、毫無徵兆)`);
    else warn('跨站互刪防護', 'activate 無差別刪除;看不出這站跟誰共用 origin,若之後搬到 <user>.github.io/<repo>/ 這種專案頁就會清掉別站的離線包');
  }
}

// ---------- 4. 有媒體就必須 ignoreVary(Pages 的 Vary: Accept-Encoding) ----------
// Vary 比對比的是「存進去時的 request」與「查詢用的 request」的 header。
// 兩邊都用 URL 字串當鍵 → 兩邊都沒有 Accept-Encoding → 比對成立,不需要 ignoreVary
// (mandarin-taigi/hakka 實測 plain match 命中)。只要有一邊傳的是真的 Request
// (帶著 <audio> 的 Accept-Encoding: identity),沒 ignoreVary 就會 miss。
if (mediaFiles.length) {
  const calls = [...swSrc.matchAll(/\.(match|put)\s*\(\s*([^,)\s]+)/g)];
  const isStringKey = (a) => /^["'`]/.test(a) || /\.url$|\.href$/.test(a) || /^(u|url|href|path|p)$/.test(a);
  const isRequestKey = (a) => /^(req|request|r)$/.test(a) || /^(e|event)\.request$/.test(a);
  const reqKeyed = calls.filter((c) => isRequestKey(c[2]));
  const unknown = calls.filter((c) => !isStringKey(c[2]) && !isRequestKey(c[2]));
  if (!calls.length) { /* 沒碰快取 API */ }
  else if (/ignoreVary/.test(swSrc)) pass('cache.match ignoreVary', `站內 ${mediaFiles.length} 個媒體檔`);
  else if (reqKeyed.length || unknown.length) {
    // 靜態只能看到「有沒有寫 ignoreVary」,看不出這個 match 服務的是不是媒體路徑
    // (泛用 helper 如 matchBestEffort(cacheName, request) 兩種鍵都會經過它)。
    // 所以這裡只出聲,真正的判定交給執行期那條:線上播一次 → 用預設比對回查快取。
    const sig = (l) => l.slice(0, 4).map((c) => `.${c[1]}(${c[2]})`).join(' ');
    warn('沒有 ignoreVary', `${sig([...reqKeyed, ...unknown])};媒體若走 Request 當鍵的路徑就會踩 Vary miss —— 執行期檢查會實測`);
  } else pass('快取以 URL 字串為鍵', `${mediaFiles.length} 個媒體檔;兩端都不帶 header,Vary 比對不成立,毋須 ignoreVary`);
  if (!/content-range/i.test(swSrc)) {
    warn('Range 請求合成 206', '從快取回 200 但沒有 Content-Range,Chrome 對較大的音檔會判 Format error');
  }
}
if ((swSrc.match(/\.match\s*\(/g) || []).length && !/ignoreSearch/.test(swSrc)) {
  warn('cache.match 加 ignoreSearch', '帶 query 的路由(?city=、?utm=)離線時會 miss,掉到首頁開錯頁');
}

// ---------- 5. 字型不可走 CDN(跨域 → SW 不能快取 → 離線壞) ----------
for (const f of htmlFiles) {
  const src = readFileSync(f, 'utf8');
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(src)) {
    fail(`自架字型:${rel(f)}`, 'Google Fonts CDN 是跨域,SW 快取不到,離線一定壞');
  }
}

// ---------- 執行期檢查 ----------
// ---------- 6. 改了被快取的檔卻沒 bump 版號 ----------
// 手動 bump 的 repo(AGENTS.md 寫「改到被快取的檔就把版號 +1」)遲早會忘。
// 忘記的後果分兩級,這裡分開報:
//   sw.js 位元組沒變 → 瀏覽器根本不知道有新版,使用者永遠停在舊的(硬傷)
//   sw.js 變了但快取名沒變 → 新 SW 會裝,但 cache-first 的資源仍回舊快取裡那份
gitBumpCheck();
function gitBumpCheck() {
  const raw = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' });
  const git = (...a) => raw(...a).trim();   // 注意:比對檔案內容要用 raw,trim 會吃掉尾端換行 → 永遠判定「有改」
  let repoRoot, base;
  try { repoRoot = git('rev-parse', '--show-toplevel'); } catch { return info('版號 bump 檢查', '不是 git repo,跳過'); }
  try { base = opt('--base', git('rev-parse', '--abbrev-ref', 'origin/HEAD')); } catch { base = opt('--base', 'HEAD'); }
  let changed, swAtBase;
  try {
    changed = new Set([
      ...git('diff', '--name-only', base, '--').split('\n'),
      ...git('ls-files', '--others', '--exclude-standard').split('\n'),
    ].filter(Boolean));
    swAtBase = raw('show', `${base}:${relative(repoRoot, SW_PATH)}`);
  } catch {
    let ignored = false;
    try { execFileSync('git', ['-C', ROOT, 'check-ignore', '-q', SW_PATH]); ignored = true; } catch { /* 沒被忽略 */ }
    return info('版號 bump 檢查', ignored
      ? `${relative(repoRoot, SW_PATH)} 是 build 產物(gitignored),版號要對源頭那份跑`
      : `拿不到基準 ${base} 的內容,跳過`);
  }
  if (!changed.size) return pass('版號 bump 檢查', `與 ${base} 相同,沒有待部署的改動`);

  // 被快取的檔 = SW 原始碼裡寫死的那份清單(同覆蓋率檢查用的來源)
  const cachedRepoPaths = new Set(precacheList().map((u) => relative(repoRoot, join(ROOT, u.replace(/^\.?\//, '')))));
  const touched = [...changed].filter((f) => cachedRepoPaths.has(f));
  if (!touched.length) return pass('版號 bump 檢查', `改動沒碰到被快取的檔(對照 ${base})`);

  const names = (src) => (src.match(/["'`][\w.-]*(?:v\d+|[0-9a-f]{6,})[\w.-]*["'`]/g) || []).join('|');
  const swChanged = readFileSync(SW_PATH, 'utf8') !== swAtBase;
  const list = touched.slice(0, 5).join(' ') + (touched.length > 5 ? ` …共 ${touched.length}` : '');
  if (!swChanged) fail('版號沒 bump', `${list} 改了,但 sw.js 一個位元組都沒動 → 瀏覽器不會知道有新版,使用者停在舊版`);
  else if (names(readFileSync(SW_PATH, 'utf8')) === names(swAtBase)) {
    warn('快取名沒變', `${list} 改了,sw.js 也改了,但快取名一樣 → 新 SW 會裝,但 cache-first 的資源仍吃舊快取那份`);
  } else pass('版號 bump 檢查', `${touched.length} 個被快取的檔有改動,快取名也跟著變了`);
}

if (!flag('--static-only')) await runtime();
report();

// build 產物常帶 base 前綴(/<repo>/assets/x.js)。從首頁的絕對路徑資產反推那個前綴:
// 拿掉第一段之後檔案在站台根目錄找得到,就認定它是 base。
function detectBasePath() {
  const idx = join(ROOT, 'index.html');
  if (!existsSync(idx)) return '';
  const src = readFileSync(idx, 'utf8');
  for (const m of src.matchAll(/(?:src|href)=["'](\/[^"']+)["']/g)) {
    const segs = m[1].replace(/^\/+/, '').split('/');
    if (segs.length < 2) continue;
    if (existsSync(join(ROOT, segs.join('/')))) return '';              // 本來就掛在根目錄
    if (existsSync(join(ROOT, segs.slice(1).join('/')))) return '/' + segs[0];
  }
  return '';
}

// SW 原始碼裡寫死的資源清單(站台根目錄相對路徑),且該檔真的存在
function precacheList() {
  return [...new Set((swSrc.match(/["'](\.{0,2}\/?[\w\-./]+\.(?:html|css|js|json|webp|png|jpg|jpeg|svg|woff2|mp3|ogg|m4a|wav|mp4|ico))["']/g) || [])
    .map((s) => s.slice(1, -1)))].filter((u) => existsSync(join(ROOT, u.replace(/^\.?\//, ''))));
}

async function runtime() {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch {
    try { ({ chromium } = (await import(join(process.env.NODE_PATH || '/usr/lib/node_modules', 'playwright/index.js'))).default); }
    catch { warn('執行期檢查', '找不到 playwright,只跑了靜態檢查(NODE_PATH=$(npm root -g) 可帶進來)'); return; }
  }

  // 複製到暫存目錄再測:等一下要動 sw.js 模擬部署,不碰工作區
  const tmp = mkdtempSync(join(tmpdir(), 'pwa-check-'));
  cpSync(ROOT, tmp, { recursive: true, filter: (s) => !s.includes('/.git') });

  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp4': 'video/mp4' };
  let hits = [];
  const srv = http.createServer((req, res) => {
    const relp = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
    // base path:Vite 這類 build 會輸出 /<repo>/assets/x.js 這種絕對路徑,而這裡是把
    // 站台根目錄掛在 /。找不到就逐段剝掉前綴再試 —— 否則整包 JS 都 404,SW 根本不會
    // 被註冊,執行期檢查會把「有 base 的站」全部誤判成沒有 service worker。
    let f = null;
    const segs = relp.split('/');
    for (let i = 0; i < segs.length && !f; i++) {
      let c = join(tmp, segs.slice(i).join('/'));
      if (existsSync(c) && statSync(c).isDirectory()) c = join(c, 'index.html');
      if (existsSync(c) && statSync(c).isFile()) f = c;
    }
    if (!f) { res.writeHead(404); return res.end(); }
    const st = statSync(f), etag = `"${st.size}-${st.mtimeMs}"`;
    // 仿 GitHub Pages:每個檔都回 Vary: Accept-Encoding + 支援 Range + ETag。
    // 少了這幾樣,本機測試對「斷網大音檔播不出來」零鑑別力——那個 bug 就是這樣漏上線的。
    const base = { 'cache-control': 'max-age=600', etag, 'content-type': MIME[extname(f)] || 'application/octet-stream', vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === etag) { hits.push(0); res.writeHead(304, base); return res.end(); }
    const buf = readFileSync(f);
    const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (m) {
      const s = Number(m[1] || 0), e = m[2] ? Number(m[2]) : buf.length - 1, sl = buf.slice(s, e + 1);
      hits.push(sl.length);
      res.writeHead(206, { ...base, 'accept-ranges': 'bytes', 'content-range': `bytes ${s}-${e}/${buf.length}`, 'content-length': sl.length });
      return res.end(sl);
    }
    hits.push(buf.length);
    res.writeHead(200, { ...base, 'accept-ranges': 'bytes', 'content-length': buf.length });
    res.end(buf);
  });
  const PORT = Number(opt('--port', 8123));
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  // 站台的 base path 要照原樣掛。把 /awei-voice/ 的站掛在 / 底下,資產靠剝前綴還是抓得到,
  // 但 SW 註冊的是 /awei-voice/sw.js、scope 就是 /awei-voice/,而頁面在 / —— 不在 scope 裡,
  // 永遠不會被接管,整個執行期檢查會誤判成「這站沒有 service worker」。
  const BASE = `http://127.0.0.1:${PORT}${detectBasePath()}/`;
  const spent = () => { const b = hits.reduce((s, h) => s + h, 0); const n = hits.length; hits = []; return { n, b }; };
  const MB = (b) => (b / 1048576).toFixed(2) + ' MB';

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'load' });
    // 沒有 skipWaiting 的站(vite-plugin-pwa 的 registerType:"prompt" 就是)第一次載入
    // 不會被接管 —— 新 SW 裝好後在 waiting,要下一次導覽才控制頁面。所以等不到就重載一次
    // 再等,只有「重載後仍然沒有」才算真的沒註冊。
    const waitCtl = (ms) => page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: ms })
      .then(() => true).catch(() => false);
    let controlled = await waitCtl(20000);
    let viaReload = false;
    if (!controlled) {
      const registered = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r).catch(() => false));
      if (registered) {
        await page.reload({ waitUntil: 'load' });
        controlled = await waitCtl(15000);
        viaReload = controlled;
      }
    }
    if (!controlled) { fail('SW 接管頁面', '重載一次後仍然沒有 controller,離線一切免談'); return; }
    pass('SW 接管頁面', viaReload ? '第二次載入才接管(沒有 skipWaiting,prompt 模式的正常行為)' : '');

    await page.waitForTimeout(Number(opt('--settle', CFG.settleMs || 15000)));  // 讓背景暖快取跑一段

    // 5-1 快取覆蓋率:拿 sw.js 裡寫死的資源清單,逐項回頭問快取「真的在嗎」
    // fetch 成功 ≠ cache.put 成功(配額不足、SW 被回收時 put 會靜默失敗),所以只認實查。
    const wanted = precacheList();
    if (wanted.length) {
      const missing = await page.evaluate(async (list) => {
        const names = await caches.keys();
        const out = [];
        for (const u of list) {
          let hit = false;
          for (const n of names) {
            if (await (await caches.open(n)).match(u, { ignoreSearch: true, ignoreVary: true })) { hit = true; break; }
          }
          if (!hit) out.push(u);
        }
        return out;
      }, wanted);
      const done = wanted.length - missing.length;
      if (missing.length) info('離線包覆蓋率', `${done}/${wanted.length} 在快取裡,缺:${missing.slice(0, 6).join(' ')}${missing.length > 6 ? ` …共 ${missing.length}` : ''}`);
      else pass('離線包覆蓋率', `${done}/${done} 全部實查命中`);
    }

    // 5-2 鄰站快取:先在同 origin 種一個別站的快取,再逼本站 SW 跑一次 activate,看它會不會順手刪掉
    await page.evaluate(async () => {
      const c = await caches.open('pwacheck-neighbor-probe-v1');
      await c.put('/__pwacheck_probe', new Response('x'));
    });
    appendFileSync(join(tmp, 'sw.js'), `\n// pwa-check deploy ${'' + wanted.length}\n`);   // 位元組變了 = 瀏覽器認得新版
    spent();
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(4000);
    const deploy = spent();
    const probeAlive = await page.evaluate(async () => (await caches.keys()).includes('pwacheck-neighbor-probe-v1'));
    if (probeAlive) pass('不刪別站快取', '同 origin 的鄰站快取在本站改版後存活');
    else fail('不刪別站快取', '本站 SW 的 activate 把同 origin 別站的快取刪掉了(功能正常、毫無徵兆)');
    info('改版重抓量', `${deploy.n} 個請求、${MB(deploy.b)}(只有 sw.js 位元組變,理想值接近 0)`);

    // 5-3 斷網:首頁真的開得起來
    await ctx.setOffline(true);
    const offlineOK = await page.reload({ waitUntil: 'domcontentloaded' }).then(() => true).catch(() => false);
    const bodyLen = offlineOK ? await page.evaluate(() => document.body.innerText.trim().length).catch(() => 0) : 0;
    if (offlineOK && bodyLen > 0) pass('斷網後首頁開得起來', `${bodyLen} 字內容`);
    else fail('斷網後首頁開得起來', '離線導覽 fallback 沒接上');

    await ctx.setOffline(false);

    // 5-4 媒體:先線上用 <audio> 播一次(跟真實使用者同一種請求形狀),再用**預設比對**
    // 回查快取。plain miss 但 ignoreVary 命中 = 踩到 Vary 坑,斷網就會 Format error。
    //
    // 【這條的負控制沒有重現,2026-08-07】把 gewu 的 ignoreVary 拿掉後,預設比對照樣命中、
    // 斷網照樣播得出來。合理的解釋是 Accept-Encoding 屬 forbidden header,由網路層在送出
    // 時才加,Cache API 比 Vary 時兩邊的 Request 物件都沒有這個欄位 → 永遠相等。
    // 所以:這條檢查真的紅時是真問題,但它綠不代表安全 —— 別把它當保證。
    // 斷網解碼那條(下面)才是有鑑別力的那個。
    if (mediaFiles.length) {
      const biggest = mediaFiles.sort((a, b) => statSync(b).size - statSync(a).size)[0];
      const url = rel(biggest).split('/').map(encodeURIComponent).join('/');
      const decode = (u) => page.evaluate(async (v) => {
        const el = document.createElement(/\.(mp4|webm|mov)$/i.test(v) ? 'video' : 'audio');
        el.volume = 0; el.preload = 'auto'; el.src = v;
        const r = await new Promise((res) => {
          el.addEventListener('loadedmetadata', () => res('OK'));
          el.addEventListener('error', () => res('FAIL:' + (el.error && el.error.code)));
          setTimeout(() => res('TIMEOUT'), 15000);
        });
        el.removeAttribute('src'); el.load(); return r;
      }, u);
      await decode(url);
      await page.waitForTimeout(12000);   // 206 的話 SW 要另抓整檔補存,給它時間
      const keys = await page.evaluate(async (u) => {
        const out = { plain: false, lax: false };
        for (const n of await caches.keys()) {
          const c = await caches.open(n);
          if (await c.match(u)) out.plain = true;
          if (await c.match(u, { ignoreSearch: true, ignoreVary: true })) out.lax = true;
        }
        return out;
      }, url);
      if (!keys.lax) info('媒體離線', `${rel(biggest)} 沒進快取(可能是刻意讓使用者自己按下載),跳過`);
      else if (!keys.plain) {
        fail('媒體的 Vary 比對', `${rel(biggest)} 在快取裡,但預設比對 miss、只有 ignoreVary 才命中 —— 斷網會 Format error`);
      } else {
        pass('媒體的 Vary 比對', `${rel(biggest)} 預設比對就命中`);
        await ctx.setOffline(true);
        const verdict = await decode(url);
        if (verdict === 'OK') pass('斷網媒體真的能解碼', rel(biggest));
        else fail('斷網媒體真的能解碼', `${rel(biggest)} → ${verdict}(命中快取不等於播得出來)`);
        await ctx.setOffline(false);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    srv.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

function report() {
  if (flag('--json')) { console.log(JSON.stringify(results, null, 2)); }
  else {
    console.log('');
    for (const r of results) console.log(`${r.level.padEnd(4)}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  const f = results.filter((r) => r.level === 'FAIL').length;
  const w = results.filter((r) => r.level === 'WARN').length;
  const p = results.filter((r) => r.level === 'PASS').length;
  console.log(`\n=== PASS ${p} / WARN ${w} / FAIL ${f} ===`);
  if (f) process.exit(1);
}
