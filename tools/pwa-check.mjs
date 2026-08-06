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

console.log(`pwa-check — ${ROOT}`);
if (!existsSync(SW_PATH)) { fail('sw.js 存在', '找不到 sw.js,這站沒有 service worker'); report(); process.exit(1); }
const swSrc = readFileSync(SW_PATH, 'utf8');

// ---------- 1. 入口頁:任何可能被單獨開啟/分享的頁都要能安裝 ----------
// 只掛在首頁 = 從分享連結進來的章節頁/詳情頁完全看不到安裝選項。
for (const f of htmlFiles) {
  const src = readFileSync(f, 'utf8');
  const name = rel(f);
  const hasManifest = /<link[^>]+rel=["']?manifest/i.test(src);
  // 註冊可能寫在頁內,也可能在它載入的本地 js 裡
  let registers = /serviceWorker\s*\.\s*register/.test(src);
  if (!registers) {
    for (const m of src.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
      const p = join(dirname(f), m[1].split('?')[0]);
      if (existsSync(p) && /serviceWorker\s*\.\s*register/.test(readFileSync(p, 'utf8'))) { registers = true; break; }
    }
  }
  if (!hasManifest) fail(`入口頁掛 manifest:${name}`, '從分享連結單獨開這頁不會出現安裝選項');
  if (!registers) fail(`入口頁註冊 SW:${name}`, '這頁自己不註冊 SW,單獨開啟時離線不成立');
  if (hasManifest && registers) pass(`入口頁 ${name}`, 'manifest + SW 註冊');
  // Chrome 認的是 mobile-web-app-capable,只放已棄用的 apple- 版不算
  if (!/name=["']?mobile-web-app-capable/i.test(src)) {
    warn(`mobile-web-app-capable:${name}`, 'Android Chrome 選單可能不出現「安裝應用程式」');
  }
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
    for (const need of ['192x192', '512x512']) {
      if (!icons.some((i) => (i.sizes || '').split(/\s+/).includes(need))) fail(`icon ${need}`, '安裝門檻要求這個尺寸');
    }
    for (const i of icons) {
      const p = join(ROOT, i.src.replace(/^\.?\//, ''));
      if (!existsSync(p)) { fail(`icon 檔存在:${i.src}`, 'manifest 指到不存在的檔'); continue; }
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
    fail('跨站互刪防護', 'activate 無差別刪除:會清掉同 origin 其他站的離線包(功能正常、毫無徵兆)');
  }
}

// ---------- 4. 有媒體就必須 ignoreVary(Pages 的 Vary: Accept-Encoding) ----------
if (mediaFiles.length) {
  const matches = swSrc.match(/\.match\s*\(/g) || [];
  if (matches.length && !/ignoreVary/.test(swSrc)) {
    fail('cache.match 加 ignoreVary', `站內有 ${mediaFiles.length} 個媒體檔;Pages 回 Vary: Accept-Encoding,而 <audio> 送 identity,不加 ignoreVary 會整個 miss → 斷網 Format error`);
  } else if (matches.length) pass('cache.match ignoreVary', `站內 ${mediaFiles.length} 個媒體檔`);
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
if (!flag('--static-only')) await runtime();
report();

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
    let f = join(tmp, relp);
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
    if (!existsSync(f)) { res.writeHead(404); return res.end(); }
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
  const BASE = `http://127.0.0.1:${PORT}/`;
  const spent = () => { const b = hits.reduce((s, h) => s + h, 0); const n = hits.length; hits = []; return { n, b }; };
  const MB = (b) => (b / 1048576).toFixed(2) + ' MB';

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'load' });
    const controlled = await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 20000 })
      .then(() => true).catch(() => false);
    if (!controlled) { fail('SW 接管頁面', '20 秒內沒有 controller,離線一切免談'); return; }
    pass('SW 接管頁面');

    await page.waitForTimeout(Number(opt('--settle', CFG.settleMs || 15000)));  // 讓背景暖快取跑一段

    // 5-1 快取覆蓋率:拿 sw.js 裡寫死的資源清單,逐項回頭問快取「真的在嗎」
    // fetch 成功 ≠ cache.put 成功(配額不足、SW 被回收時 put 會靜默失敗),所以只認實查。
    const wanted = [...new Set((swSrc.match(/["'](\.{0,2}\/?[\w\-./]+\.(?:html|css|js|json|webp|png|jpg|jpeg|svg|woff2|mp3|ogg|m4a|wav|mp4|ico))["']/g) || [])
      .map((s) => s.slice(1, -1)))].filter((u) => existsSync(join(ROOT, u.replace(/^\.?\//, ''))));
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

    // 5-4 媒體:命中快取 ≠ 播得出來。挑站內最大的一個媒體檔真的去 decode。
    if (mediaFiles.length) {
      const biggest = mediaFiles.sort((a, b) => statSync(b).size - statSync(a).size)[0];
      const url = rel(biggest).split('/').map(encodeURIComponent).join('/');
      const inCache = await page.evaluate(async (u) => {
        for (const n of await caches.keys()) {
          if (await (await caches.open(n)).match(u, { ignoreSearch: true, ignoreVary: true })) return true;
        }
        return false;
      }, url);
      if (!inCache) info('斷網媒體解碼', `${rel(biggest)} 不在快取裡(可能是刻意延後暖載),跳過`);
      else {
        const verdict = await page.evaluate(async (u) => {
          const el = document.createElement(/\.(mp4|webm|mov)$/i.test(u) ? 'video' : 'audio');
          el.volume = 0; el.preload = 'auto'; el.src = u;
          const v = await new Promise((res) => {
            el.addEventListener('loadedmetadata', () => res('OK'));
            el.addEventListener('error', () => res('FAIL:' + (el.error && el.error.code)));
            setTimeout(() => res('TIMEOUT'), 12000);
          });
          el.removeAttribute('src'); el.load(); return v;
        }, url);
        if (verdict === 'OK') pass('斷網媒體真的能解碼', rel(biggest));
        else fail('斷網媒體真的能解碼', `${rel(biggest)} → ${verdict}(命中快取不等於播得出來)`);
      }
    }
    await ctx.setOffline(false);
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
