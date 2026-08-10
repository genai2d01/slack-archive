// 슬랙 자료방을 읽어 archive.html을 갱신하는 스크립트 (GitHub Actions가 매일 실행)
const fs = require('fs');
const crypto = require('crypto');

const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL_ID = 'C0BJU8K7LSH';          // 자료방 채널 고유번호
const CHANNEL_NAME = 'genai-2d_정보-공유';  // 화면 표시용 이름
const DATA_FILE = 'data/archive.json';
const STATE_FILE = 'data/state.json';
const THUMBS_FILE = 'data/thumbs.json';
const FILES_DIR = 'files';
const THUMBS_DIR = 'files/thumbs';
const HTML_FILE = 'archive.html';
const MAX_FILE_MB = 95;
const THUMB_BUDGET = 40;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// 사이트별 고유색 [배경, 글자색]
const BRAND = {
  'youtube.com': ['#FF0000', '#fff'], 'youtu.be': ['#FF0000', '#fff'],
  'linkedin.com': ['#0A66C2', '#fff'],
  'github.com': ['#24292F', '#fff'],
  'huggingface.co': ['#FFB000', '#1b1f23'],
  'pinterest.com': ['#E60023', '#fff'],
  'instagram.com': ['#C13584', '#fff'],
  'notion.site': ['#787774', '#fff'], 'notion.so': ['#787774', '#fff'],
  'vimeo.com': ['#1AB7EA', '#0f1115'],
  'x.com': ['#14171A', '#fff'], 'twitter.com': ['#1DA1F2', '#fff'],
  'tistory.com': ['#EB531F', '#fff'],
  'drive.google.com': ['#1FA463', '#fff'],
  'docs.google.com': ['#4285F4', '#fff'],
  'reddit.com': ['#FF4500', '#fff'],
  'medium.com': ['#191919', '#fff'],
  'openai.com': ['#10A37F', '#fff'],
  'anthropic.com': ['#D97757', '#fff'],
  'lumalabs.ai': ['#B36AE2', '#fff'],
};

// 월별 톤온톤 포인트 컬러 (월 숫자 기준 고정 — 7월은 항상 같은 색)
const MONTH_COLORS = ['#7dd3c0', '#8fb8de', '#b3a1e0', '#d9c08a', '#d99aa8', '#93c99a'];

// 주제 자동 분류 규칙 (위에서부터 순서대로 검사, 여러 주제에 동시 포함 가능)
const TOPICS = [
  { name: 'AI영상생성', keywords: ['seedance', 'runway', 'luma', 'kling', 'veo', 'ltx', 'wan', 'higgsfield', 'sora', 'midjourney', 'nano banana', 'ai video', 'aivideo', 'reve', 'decart', 'vace'] },
  { name: 'ComfyUI·워크플로우', keywords: ['comfyui', 'griptape', 'workflow', '워크플로우', 'prism', 'kitsu', 'pipeline'] },
  { name: 'VFX·합성', keywords: ['nuke', 'vfx', 'roto', 'comp', 'mocha', 'katana', 'mari', 'copycat', 'relight', 'keying', 'tracking', '합성'] },
  { name: '3D·CG', keywords: ['blender', 'unreal', 'houdini', 'gaussian', 'splat', 'hunyuan', '3d', 'multiview'] },
  { name: 'AI툴·LLM', keywords: ['gpt', 'claude', 'gemini', 'llm', 'chatgpt', 'prompt', '프롬프트', 'mcp', 'ocr', 'glm'] },
];

async function slack(method, params = {}) {
  const url = new URL('https://slack.com/api/' + method);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const json = await res.json();
  if (!json.ok) throw new Error(method + ' 실패: ' + json.error);
  return json;
}

async function fetchNewMessages(channelId, oldest) {
  const msgs = [];
  let cursor;
  do {
    const r = await slack('conversations.history', {
      channel: channelId, limit: 200,
      ...(oldest ? { oldest } : {}), ...(cursor ? { cursor } : {}),
    });
    msgs.push(...r.messages);
    cursor = r.has_more && r.response_metadata ? r.response_metadata.next_cursor : null;
  } while (cursor);
  const skip = ['channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name'];
  return msgs.filter(m => !skip.includes(m.subtype || ''));
}

function cleanText(raw) {
  let t = raw || '';
  t = t.replace(/<(https?:\/\/[^>|]+)\|([^>]*)>/g, '$2');
  t = t.replace(/<(https?:\/\/[^>|]+)>/g, '$1');
  t = t.replace(/<[@#!][^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return t.trim();
}

function extractLinks(raw) {
  const links = [];
  const re = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/g;
  let m;
  while ((m = re.exec(raw || ''))) links.push(m[1].replace(/&amp;/g, '&'));
  return [...new Set(links)];
}

function fmtDate(ts) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(parseFloat(ts) * 1000));
}

async function downloadFile(f, ts) {
  if ((f.size || 0) > MAX_FILE_MB * 1024 * 1024) return null;
  const safe = (f.name || 'file').replace(/[\\/:*?"<>|]/g, '_');
  const rel = FILES_DIR + '/' + ts.replace('.', '_') + '_' + safe;
  if (fs.existsSync(rel)) return rel;
  const res = await fetch(f.url_private_download || f.url_private, {
    headers: { Authorization: 'Bearer ' + TOKEN },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  fs.writeFileSync(rel, Buffer.from(await res.arrayBuffer()));
  return rel;
}

// ---------- 링크 썸네일 ----------
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal, redirect: 'follow' }); }
  finally { clearTimeout(t); }
}

function youtubeId(u) {
  const m = u.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function ogImageUrl(pageUrl) {
  const res = await fetchWithTimeout(pageUrl, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en' } });
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return null;
  const html = (await res.text()).slice(0, 400000);
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["'][^>]*content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)/i);
  if (!m) return null;
  try { return new URL(m[1].replace(/&amp;/g, '&'), pageUrl).href; } catch { return null; }
}

async function downloadThumb(imgUrl, key) {
  const res = await fetchWithTimeout(imgUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  if (!ct.startsWith('image/')) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000 || buf.length > 5 * 1024 * 1024) return null;
  const ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : ct.includes('gif') ? '.gif' : '.jpg';
  const rel = THUMBS_DIR + '/' + key + ext;
  fs.writeFileSync(rel, buf);
  return rel;
}

async function collectThumbs(archive, thumbs) {
  let budget = THUMB_BUDGET;
  for (const e of archive) {
    for (const u of e.links) {
      if (u in thumbs || budget <= 0) continue;
      budget--;
      const yid = youtubeId(u);
      if (yid) { thumbs[u] = 'https://i.ytimg.com/vi/' + yid + '/mqdefault.jpg'; continue; }
      try {
        const og = await ogImageUrl(u);
        thumbs[u] = og ? await downloadThumb(og, crypto.createHash('md5').update(u).digest('hex').slice(0, 16)) : null;
      } catch { thumbs[u] = null; }
      console.log('썸네일 ' + (thumbs[u] ? 'OK' : '없음') + ': ' + u.slice(0, 60));
    }
  }
}

// ---------- HTML 생성 ----------
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '링크'; }
}

function brandFor(host) {
  for (const [k, v] of Object.entries(BRAND)) {
    if (host === k || host.endsWith('.' + k)) return v;
  }
  return ['#7dd3c0', '#0f1115'];
}

function entryTypes(e) {
  const t = new Set();
  if (e.links.length) t.add('link');
  if (e.links.some(u => youtubeId(u))) t.add('video');
  for (const f of e.files) {
    if ((f.mimetype || '').startsWith('image/')) t.add('image');
    else if ((f.mimetype || '').startsWith('video/')) t.add('video');
    else t.add('doc');
  }
  if (!e.links.length && !e.files.length && e.text) t.add('text');
  return [...t].join(' ');
}

function entryTopics(e) {
  const hay = [e.text, ...e.links, ...e.files.map(f => f.name)].join(' ').toLowerCase();
  const names = TOPICS.filter(tp => tp.keywords.some(k => hay.includes(k))).map(tp => tp.name);
  return names.length ? names.join(' ') : '기타';
}

function searchKey(e) {
  return [e.text, ...e.links, ...e.files.map(f => f.name)].join(' ').toLowerCase().replace(/\s+/g, '');
}

function renderEntry(e, thumbs) {
  let btns = '';
  const thumbCards = [];
  for (const u of e.links) {
    const host = domainOf(u);
    const [bg, fg] = brandFor(host);
    btns += `<a class="btn" style="background:${bg};color:${fg}" href="${esc(u)}" target="_blank" rel="noopener">${esc(host)} ↗</a>`;
    const th = thumbs[u];
    if (th) {
      const src = th.startsWith('http') ? esc(th) : encodeURI(th);
      thumbCards.push(`<a class="thumb" href="${esc(u)}" target="_blank" rel="noopener"><img src="${src}" alt="" loading="lazy"><span class="th-tag" style="background:${bg};color:${fg}">${esc(host)}</span></a>`);
    }
  }
  let attach = '';
  for (const f of e.files) {
    if (f.oversized) {
      attach += `<a class="btn btn-slack" href="${esc(f.permalink || '#')}" target="_blank" rel="noopener">📦 ${esc(f.name)} — 슬랙에서 열기 (대용량)</a>`;
      continue;
    }
    const src = encodeURI(f.path);
    const mt = f.mimetype || '';
    if (mt.startsWith('image/')) {
      attach += `<a href="${src}" target="_blank"><img class="a-img" src="${src}" alt="${esc(f.name)}" loading="lazy"></a>`;
    } else if (mt.startsWith('video/')) {
      attach += `<figure class="v-wrap"><video src="${src}" controls preload="metadata"></video><figcaption>🎬 ${esc(f.name)} · <a href="${src}" download>다운로드</a></figcaption></figure>`;
    } else {
      attach += `<a class="file-link" href="${src}" download>📎 ${esc(f.name)}</a>`;
    }
  }
  return `<article class="entry" data-ts="${e.ts}" data-month="${e.date.slice(0, 7)}" data-types="${entryTypes(e)}" data-topics="${esc(entryTopics(e))}" data-search="${esc(searchKey(e))}">
<div class="e-head"><span class="e-date">${e.date.slice(5)}</span></div>
${e.text ? `<p class="e-text">${esc(e.text)}</p>` : ''}
${btns ? `<div class="e-btns">${btns}</div>` : ''}
${thumbCards.length ? `<div class="thumb-grid">${thumbCards.join('')}</div>` : ''}
${attach ? `<div class="attach">${attach}</div>` : ''}
</article>`;
}

function renderHtml(archive, thumbs) {
  const months = new Map();
  for (const e of archive) {
    const key = e.date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(e);
  }
  const sortedMonths = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  let sections = '';
  let monthOptions = '<option value="all">전체 기간</option>';
  for (const [key, entries] of sortedMonths) {
    const [y, mo] = key.split('-');
    const color = MONTH_COLORS[parseInt(mo) % MONTH_COLORS.length];
    monthOptions += `<option value="${key}">${y}년 ${parseInt(mo)}월</option>`;
    sections += `<section class="month" data-key="${key}" style="--maccent:${color}"><div class="month-head"><h2>${y}년 ${parseInt(mo)}월</h2><span class="count">${entries.length}건</span></div>
<div class="m-body">
${entries.map(e => renderEntry(e, thumbs)).join('\n')}
</div></section>\n`;
  }
  const topicOptions = ['<option value="all">주제: 전체</option>']
    .concat(TOPICS.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`), ['<option value="기타">기타</option>'])
    .join('');
  const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>슬랙 아카이브 — ${esc(CHANNEL_NAME)}</title>
<style>
  :root { --bg:#0f1115; --panel:#161a21; --panel-2:#1c212a; --line:#262c37; --line-soft:#1f242e;
    --text:#e6e9ef; --text-dim:#9aa4b2; --text-mute:#6b7482; --accent:#7dd3c0; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:system-ui,'Apple SD Gothic Neo','Malgun Gothic',sans-serif; line-height:1.55; padding:0 0 6rem; }
  .wrap { max-width:1520px; margin:0 auto; padding:0 28px; }
  header { padding:44px 0 20px; }
  .eyebrow { font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:var(--accent); margin-bottom:10px; font-family:monospace; }
  h1 { font-size:30px; letter-spacing:-.02em; margin-bottom:6px; }
  .sub { color:var(--text-dim); font-size:14px; }
  .controls { position:sticky; top:0; z-index:20; background:rgba(15,17,21,.97); backdrop-filter:blur(4px);
    padding:14px 0; border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  #q { flex:1 1 240px; min-width:180px; background:var(--panel); border:1px solid var(--line); color:var(--text);
    padding:10px 14px; border-radius:9px; font-size:14px; outline:none; }
  #q:focus { border-color:var(--accent); }
  .chip { background:var(--panel); border:1px solid var(--line); color:var(--text-dim); padding:8px 15px;
    border-radius:999px; font-size:13px; cursor:pointer; }
  .chip.on { background:var(--accent); color:#0f1115; border-color:var(--accent); font-weight:700; }
  select { background:var(--panel); border:1px solid var(--line); color:var(--text); padding:9px 10px; border-radius:9px; font-size:13px; }
  .count-line { color:var(--text-mute); font-size:12.5px; margin-left:auto; }
  .count-line b { color:var(--accent); }
  .month { padding-top:34px; }
  .month-head { display:flex; align-items:center; gap:12px; padding:11px 16px; margin-bottom:16px; border-radius:11px;
    background:color-mix(in srgb, var(--maccent) 15%, var(--bg));
    border:1px solid color-mix(in srgb, var(--maccent) 40%, var(--line)); }
  .month-head h2 { font-size:22px; color:var(--maccent); }
  .month-head .count { font-family:monospace; font-size:13px; color:var(--text-dim); }
  .m-body { columns:430px; column-gap:16px; }
  .entry { background:var(--panel); background:color-mix(in srgb, var(--maccent) 7%, var(--panel));
    border:1px solid color-mix(in srgb, var(--maccent) 22%, var(--line));
    border-left:4px solid var(--maccent);
    border-radius:12px; padding:15px 17px; margin:0 0 16px; break-inside:avoid; }
  .e-head { margin-bottom:7px; }
  .e-date { font-family:monospace; font-size:16px; font-weight:800; color:var(--maccent); letter-spacing:.02em; }
  .e-text { white-space:pre-wrap; word-break:break-word; font-size:14px; line-height:1.65; margin-bottom:10px; }
  .e-btns { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:10px; }
  .btn { display:inline-flex; align-items:center; gap:6px; font-weight:700; font-size:12.5px;
    padding:7px 13px; border-radius:8px; text-decoration:none; }
  .btn:hover { opacity:.82; }
  .btn-slack { background:#4A154B; color:#fff; }
  .thumb-grid { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:10px; }
  .thumb { position:relative; display:block; width:100%; max-width:340px; border-radius:10px; overflow:hidden;
    border:1px solid var(--line); }
  .thumb img { width:100%; display:block; }
  .thumb .th-tag { position:absolute; left:8px; bottom:8px; font-family:monospace; font-size:10.5px;
    font-weight:700; padding:3px 8px; border-radius:5px; opacity:.94; }
  .thumb:hover img { opacity:.85; }
  .attach { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-start; }
  .a-img { max-width:100%; max-height:260px; border-radius:10px; border:1px solid var(--line); display:block; }
  .v-wrap { margin:0; width:100%; }
  .v-wrap video { width:100%; border-radius:10px; border:1px solid var(--line); display:block; background:#000; }
  .v-wrap figcaption { font-size:12px; color:var(--text-mute); margin-top:5px; word-break:break-all; }
  .v-wrap figcaption a { color:var(--accent); }
  .file-link { display:inline-flex; align-items:center; gap:6px; background:var(--panel-2); border:1px solid var(--line);
    color:var(--text); padding:9px 13px; border-radius:9px; text-decoration:none; font-size:13px; word-break:break-all; }
  .file-link:hover { border-color:var(--accent); }
  #toTop { position:fixed; right:26px; bottom:26px; z-index:30; width:48px; height:48px; border-radius:50%;
    border:none; background:var(--accent); color:#0f1115; font-size:20px; font-weight:800; cursor:pointer;
    box-shadow:0 4px 14px rgba(0,0,0,.45); opacity:0; pointer-events:none; transition:opacity .25s; }
  #toTop.show { opacity:1; pointer-events:auto; }
  #toTop:hover { opacity:.85; }
  footer { margin-top:48px; padding-top:18px; border-top:1px solid var(--line); color:var(--text-mute); font-size:12px; font-family:monospace; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">Slack Auto Archive</div>
    <h1>슬랙 아카이브</h1>
    <p class="sub">#${esc(CHANNEL_NAME)} 채널 · 총 ${archive.length}건 · 마지막 갱신 ${now} (KST)</p>
  </header>
  <div class="controls">
    <input id="q" type="search" placeholder="검색 — 제목·링크·파일명 (띄어쓰기 무관)">
    <select id="sortSel">
      <option value="new">최신순</option>
      <option value="old">오래된순</option>
    </select>
    <select id="topicSel">${topicOptions}</select>
    <select id="monthSel">${monthOptions}</select>
    <button type="button" class="chip on" data-type="all">전체</button>
    <button type="button" class="chip" data-type="video">영상</button>
    <button type="button" class="chip" data-type="image">이미지</button>
    <button type="button" class="chip" data-type="doc">문서</button>
    <button type="button" class="chip" data-type="link">링크</button>
    <button type="button" class="chip" data-type="text">텍스트</button>
    <span class="count-line">총 ${archive.length}건 중 <b id="resultCount">${archive.length}</b>건 표시</span>
  </div>
  <main id="archiveRoot">
  ${sections}
  </main>
  <footer>매일 자동 수집 · 최신순 정렬</footer>
</div>
<button id="toTop" title="맨 위로">↑</button>
<script>
(function () {
  var q = document.getElementById('q');
  var sortSel = document.getElementById('sortSel');
  var topicSel = document.getElementById('topicSel');
  var monthSel = document.getElementById('monthSel');
  var chips = document.querySelectorAll('.chip');
  var entries = document.querySelectorAll('.entry');
  var sections = document.querySelectorAll('.month');
  var countEl = document.getElementById('resultCount');
  var toTop = document.getElementById('toTop');
  var root = document.getElementById('archiveRoot');
  var activeType = 'all';
  function norm(s) { return (s || '').toLowerCase().replace(/\\s+/g, ''); }
  function hasWord(attr, w) { return (' ' + attr + ' ').indexOf(' ' + w + ' ') !== -1; }
  function apply() {
    var nq = norm(q.value);
    var mon = monthSel.value;
    var topic = topicSel.value;
    var shown = 0;
    entries.forEach(function (el) {
      var ok = true;
      if (nq && el.getAttribute('data-search').indexOf(nq) === -1) ok = false;
      if (ok && activeType !== 'all' && !hasWord(el.getAttribute('data-types'), activeType)) ok = false;
      if (ok && topic !== 'all' && !hasWord(el.getAttribute('data-topics'), topic)) ok = false;
      if (ok && mon !== 'all' && el.getAttribute('data-month') !== mon) ok = false;
      el.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    sections.forEach(function (sec) {
      var any = false;
      sec.querySelectorAll('.entry').forEach(function (el) { if (el.style.display !== 'none') any = true; });
      sec.style.display = any ? '' : 'none';
    });
    countEl.textContent = shown;
  }
  function resort() {
    var dir = sortSel.value;
    var secs = Array.prototype.slice.call(root.querySelectorAll('.month'));
    secs.sort(function (a, b) {
      var x = a.getAttribute('data-key'), y = b.getAttribute('data-key');
      return dir === 'new' ? y.localeCompare(x) : x.localeCompare(y);
    });
    secs.forEach(function (s) { root.appendChild(s); });
    secs.forEach(function (s) {
      var body = s.querySelector('.m-body');
      var es = Array.prototype.slice.call(body.querySelectorAll('.entry'));
      es.sort(function (a, b) {
        var x = parseFloat(a.getAttribute('data-ts')), y = parseFloat(b.getAttribute('data-ts'));
        return dir === 'new' ? y - x : x - y;
      });
      es.forEach(function (e) { body.appendChild(e); });
    });
  }
  q.addEventListener('input', apply);
  monthSel.addEventListener('change', apply);
  topicSel.addEventListener('change', apply);
  sortSel.addEventListener('change', resort);
  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      chips.forEach(function (x) { x.classList.remove('on'); });
      c.classList.add('on');
      activeType = c.getAttribute('data-type');
      apply();
    });
  });
  window.addEventListener('scroll', function () {
    if (window.scrollY > 600) toTop.classList.add('show');
    else toTop.classList.remove('show');
  });
  toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
})();
</script>
</body>
</html>`;
}

// ---------- 메인 ----------
(async () => {
  if (!TOKEN) { console.error('SLACK_BOT_TOKEN이 설정되지 않았습니다.'); process.exit(1); }
  fs.mkdirSync('data', { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.mkdirSync(THUMBS_DIR, { recursive: true });

  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const archive = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : [];
  const thumbs = fs.existsSync(THUMBS_FILE) ? JSON.parse(fs.readFileSync(THUMBS_FILE, 'utf8')) : {};
  const seen = new Set(archive.map(e => e.ts));

  const messages = await fetchNewMessages(CHANNEL_ID, state.lastTs);
  console.log('새 메시지 ' + messages.length + '건');

  let lastTs = state.lastTs || '0';
  for (const m of messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))) {
    if (parseFloat(m.ts) > parseFloat(lastTs)) lastTs = m.ts;
    if (seen.has(m.ts)) continue;
    const entry = { ts: m.ts, date: fmtDate(m.ts), text: cleanText(m.text), links: extractLinks(m.text), files: [] };
    for (const f of m.files || []) {
      try {
        const rel = await downloadFile(f, m.ts);
        if (rel) {
          entry.files.push({ path: rel, name: f.name || 'file', mimetype: f.mimetype || '' });
        } else {
          entry.files.push({ path: '', name: f.name || 'file', mimetype: f.mimetype || '', oversized: true, permalink: f.permalink || '' });
          console.log('용량 초과로 링크만 기록: ' + (f.name || ''));
        }
      } catch (e) { console.warn('파일 다운로드 실패: ' + (f.name || '') + ' — ' + e.message); }
    }
    if (entry.text || entry.links.length || entry.files.length) archive.push(entry);
  }

  archive.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
  await collectThumbs(archive, thumbs);

  fs.writeFileSync(DATA_FILE, JSON.stringify(archive, null, 2));
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastTs }));
  fs.writeFileSync(THUMBS_FILE, JSON.stringify(thumbs, null, 2));
  fs.writeFileSync(HTML_FILE, renderHtml(archive, thumbs));
  console.log('완료: 총 ' + archive.length + '건, archive.html 갱신됨');
})().catch(e => { console.error(e.message || e); process.exit(1); });
