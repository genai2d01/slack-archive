// 슬랙 자료방을 읽어 archive.html을 갱신하는 스크립트 (GitHub Actions가 매일 실행)
const fs = require('fs');

const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL_ID = 'C0BJU8K7LSH';          // 자료방 채널 고유번호
const CHANNEL_NAME = 'genai-2d_정보-공유';  // 화면 표시용 이름
const DATA_FILE = 'data/archive.json';
const STATE_FILE = 'data/state.json';
const FILES_DIR = 'files';
const HTML_FILE = 'archive.html';
const MAX_FILE_MB = 95; // GitHub 파일당 한도(100MB)보다 살짝 작게

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
  if ((f.size || 0) > MAX_FILE_MB * 1024 * 1024) return null; // 대용량은 저장 생략
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

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '링크'; }
}

function youtubeId(u) {
  const m = u.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
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
  return [...t].join(' ');
}

function searchKey(e) {
  const parts = [e.text, ...e.links, ...e.files.map(f => f.name)];
  return parts.join(' ').toLowerCase().replace(/\s+/g, '');
}

function renderEntry(e) {
  let btns = '';
  const ytThumbs = [];
  for (const u of e.links) {
    const yid = youtubeId(u);
    if (yid) ytThumbs.push(`<a class="yt" href="${esc(u)}" target="_blank" rel="noopener"><img src="https://i.ytimg.com/vi/${yid}/mqdefault.jpg" alt="YouTube 썸네일" loading="lazy"></a>`);
    btns += `<a class="btn" href="${esc(u)}" target="_blank" rel="noopener">${esc(domainOf(u))} ↗</a>`;
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
  return `<article class="entry" data-month="${e.date.slice(0, 7)}" data-types="${entryTypes(e)}" data-search="${esc(searchKey(e))}">
<div class="e-row"><span class="e-date">${e.date.slice(5)}</span><div class="e-body">
${e.text ? `<p class="e-text">${esc(e.text)}</p>` : ''}
${btns ? `<div class="e-btns">${btns}</div>` : ''}
${ytThumbs.length ? `<div class="yt-grid">${ytThumbs.join('')}</div>` : ''}
${attach ? `<div class="attach">${attach}</div>` : ''}
</div></div></article>`;
}

function renderHtml(archive) {
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
    monthOptions += `<option value="${key}">${y}년 ${parseInt(mo)}월</option>`;
    sections += `<section class="month"><div class="month-head"><h2>${y}년 ${parseInt(mo)}월</h2><span class="count">${entries.length}건</span></div>
${entries.map(renderEntry).join('\n')}
</section>\n`;
  }
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
  .wrap { max-width:1080px; margin:0 auto; padding:0 24px; }
  header { padding:44px 0 20px; }
  .eyebrow { font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:var(--accent); margin-bottom:10px; font-family:monospace; }
  h1 { font-size:30px; letter-spacing:-.02em; margin-bottom:6px; }
  .sub { color:var(--text-dim); font-size:14px; }
  .controls { position:sticky; top:0; z-index:20; background:rgba(15,17,21,.97); backdrop-filter:blur(4px);
    padding:14px 0; border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  #q { flex:1 1 260px; min-width:200px; background:var(--panel); border:1px solid var(--line); color:var(--text);
    padding:10px 14px; border-radius:9px; font-size:14px; outline:none; }
  #q:focus { border-color:var(--accent); }
  .chip { background:var(--panel); border:1px solid var(--line); color:var(--text-dim); padding:8px 15px;
    border-radius:999px; font-size:13px; cursor:pointer; }
  .chip.on { background:var(--accent); color:#0f1115; border-color:var(--accent); font-weight:700; }
  #monthSel { background:var(--panel); border:1px solid var(--line); color:var(--text); padding:9px 10px; border-radius:9px; font-size:13px; }
  .count-line { color:var(--text-mute); font-size:12.5px; margin-left:auto; }
  .count-line b { color:var(--accent); }
  .month { padding-top:32px; }
  .month-head { display:flex; align-items:baseline; gap:12px; padding-bottom:12px; }
  .month-head h2 { font-size:21px; }
  .month-head .count { font-family:monospace; font-size:13px; color:var(--text-mute); }
  .entry { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin-bottom:12px; }
  .e-row { display:flex; gap:14px; }
  .e-date { font-family:monospace; font-size:12px; color:var(--accent); white-space:nowrap; padding-top:4px; }
  .e-body { flex:1; min-width:0; }
  .e-text { white-space:pre-wrap; word-break:break-word; font-size:14.5px; line-height:1.7; margin-bottom:10px; }
  .e-btns { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
  .btn { display:inline-flex; align-items:center; gap:6px; background:var(--accent); color:#0f1115; font-weight:700;
    font-size:13px; padding:8px 15px; border-radius:9px; text-decoration:none; }
  .btn:hover { opacity:.85; }
  .btn-slack { background:#4A154B; color:#fff; }
  .yt-grid { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:10px; }
  .yt { position:relative; display:block; width:220px; border-radius:10px; overflow:hidden; border:1px solid var(--line); }
  .yt img { width:100%; display:block; }
  .yt::after { content:'▶'; position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    font-size:26px; color:#fff; background:rgba(0,0,0,.22); text-shadow:0 1px 8px rgba(0,0,0,.8); }
  .yt:hover::after { background:rgba(0,0,0,.05); }
  .attach { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-start; }
  .a-img { max-width:300px; max-height:220px; border-radius:10px; border:1px solid var(--line); display:block; }
  .v-wrap { margin:0; }
  .v-wrap video { max-width:460px; width:100%; border-radius:10px; border:1px solid var(--line); display:block; background:#000; }
  .v-wrap figcaption { font-size:12px; color:var(--text-mute); margin-top:5px; word-break:break-all; }
  .v-wrap figcaption a { color:var(--accent); }
  .file-link { display:inline-flex; align-items:center; gap:6px; background:var(--panel-2); border:1px solid var(--line);
    color:var(--text); padding:9px 13px; border-radius:9px; text-decoration:none; font-size:13px; word-break:break-all; }
  .file-link:hover { border-color:var(--accent); }
  footer { margin-top:48px; padding-top:18px; border-top:1px solid var(--line); color:var(--text-mute); font-size:12px; font-family:monospace; }
  @media (max-width:640px) { .e-row { flex-direction:column; gap:6px; } .count-line { margin-left:0; } }
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
    <button type="button" class="chip on" data-type="all">전체</button>
    <button type="button" class="chip" data-type="video">영상</button>
    <button type="button" class="chip" data-type="image">이미지</button>
    <button type="button" class="chip" data-type="doc">문서</button>
    <button type="button" class="chip" data-type="link">링크</button>
    <select id="monthSel">${monthOptions}</select>
    <span class="count-line">총 ${archive.length}건 중 <b id="resultCount">${archive.length}</b>건 표시</span>
  </div>
  ${sections}
  <footer>매일 자동 수집 · 최신순 정렬</footer>
</div>
<script>
(function () {
  var q = document.getElementById('q');
  var monthSel = document.getElementById('monthSel');
  var chips = document.querySelectorAll('.chip');
  var entries = document.querySelectorAll('.entry');
  var sections = document.querySelectorAll('.month');
  var countEl = document.getElementById('resultCount');
  var activeType = 'all';
  function norm(s) { return (s || '').toLowerCase().replace(/\\s+/g, ''); }
  function apply() {
    var nq = norm(q.value);
    var mon = monthSel.value;
    var shown = 0;
    entries.forEach(function (el) {
      var ok = true;
      if (nq && el.getAttribute('data-search').indexOf(nq) === -1) ok = false;
      if (ok && activeType !== 'all' && (' ' + el.getAttribute('data-types') + ' ').indexOf(' ' + activeType + ' ') === -1) ok = false;
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
  q.addEventListener('input', apply);
  monthSel.addEventListener('change', apply);
  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      chips.forEach(function (x) { x.classList.remove('on'); });
      c.classList.add('on');
      activeType = c.getAttribute('data-type');
      apply();
    });
  });
})();
</script>
</body>
</html>`;
}

(async () => {
  if (!TOKEN) { console.error('SLACK_BOT_TOKEN이 설정되지 않았습니다.'); process.exit(1); }
  fs.mkdirSync('data', { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });

  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const archive = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : [];
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
  fs.writeFileSync(DATA_FILE, JSON.stringify(archive, null, 2));
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastTs }));
  fs.writeFileSync(HTML_FILE, renderHtml(archive));
  console.log('완료: 총 ' + archive.length + '건, archive.html 갱신됨');
})().catch(e => { console.error(e.message || e); process.exit(1); });
