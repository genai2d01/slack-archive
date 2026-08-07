// 슬랙 자료방을 읽어 archive.html을 갱신하는 스크립트 (GitHub Actions가 매일 실행)
const fs = require('fs');

const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL_ID = 'C0BJU8K7LSH';          // 자료방 채널 고유번호
const CHANNEL_NAME = 'genai-2d_정보-공유';  // 화면 표시용 이름
const DATA_FILE = 'data/archive.json';
const STATE_FILE = 'data/state.json';
const FILES_DIR = 'files';
const HTML_FILE = 'archive.html';

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

function renderHtml(archive) {
  const months = new Map();
  for (const e of archive) {
    const key = e.date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(e);
  }
  let sections = '';
  for (const [key, entries] of [...months.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    const [y, mo] = key.split('-');
    let rows = '';
    for (const e of entries) {
      const badges = e.links.map(u =>
        `<a class="src-badge" href="${esc(u)}" target="_blank" rel="noopener">${esc(domainOf(u))}</a>`).join(' ');
      let attach = '';
      for (const f of e.files) {
        const src = encodeURI(f.path);
        if (f.mimetype.startsWith('image/')) attach += `<a href="${src}" target="_blank"><img src="${src}" alt="${esc(f.name)}"></a>`;
        else if (f.mimetype.startsWith('video/')) attach += `<video src="${src}" controls preload="metadata"></video>`;
        else attach += `<a class="file-link" href="${src}" download>📎 ${esc(f.name)}</a>`;
      }
      rows += `<tr><td class="date">${e.date.slice(5)}</td><td class="content">${esc(e.text) || '<span class="dim">(첨부만 있음)</span>'}${attach ? `<div class="attach">${attach}</div>` : ''}</td><td class="link">${badges || '<span class="dim">—</span>'}</td></tr>\n`;
    }
    sections += `<section class="month"><div class="month-head"><h2>${y}년 ${parseInt(mo)}월</h2><span class="count">${entries.length}건</span></div><div class="card"><table><tbody>${rows}</tbody></table></div></section>\n`;
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
  body { background:var(--bg); color:var(--text); font-family:system-ui,'Apple SD Gothic Neo','Malgun Gothic',sans-serif; line-height:1.5; padding:0 0 6rem; }
  .wrap { max-width:980px; margin:0 auto; padding:0 24px; }
  header { padding:48px 0 28px; border-bottom:1px solid var(--line); }
  .eyebrow { font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:var(--accent); margin-bottom:12px; font-family:monospace; }
  h1 { font-size:32px; letter-spacing:-.02em; margin-bottom:8px; }
  .sub { color:var(--text-dim); font-size:14px; }
  .month { padding-top:36px; }
  .month-head { display:flex; align-items:baseline; gap:12px; padding-bottom:12px; }
  .month-head h2 { font-size:22px; }
  .month-head .count { font-family:monospace; font-size:13px; color:var(--text-mute); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:6px 14px; }
  table { width:100%; border-collapse:collapse; }
  tbody tr { border-bottom:1px solid var(--line-soft); }
  tbody tr:last-child { border-bottom:none; }
  tbody tr:hover { background:var(--panel-2); }
  td { padding:11px 8px; vertical-align:top; font-size:14px; }
  td.date { font-family:monospace; font-size:12px; color:var(--text-mute); white-space:nowrap; width:52px; }
  td.link { width:110px; text-align:right; }
  .src-badge { display:inline-block; font-family:monospace; font-size:10.5px; color:#0f1115; background:var(--accent); padding:2px 7px; border-radius:4px; text-decoration:none; margin:1px 0; }
  .src-badge:hover { opacity:.85; }
  .dim { color:var(--text-mute); font-size:12px; }
  .attach { margin-top:8px; display:flex; flex-wrap:wrap; gap:8px; }
  .attach img { max-width:260px; max-height:180px; border-radius:8px; border:1px solid var(--line); display:block; }
  .attach video { max-width:420px; width:100%; border-radius:8px; border:1px solid var(--line); }
  .file-link { color:var(--accent); text-decoration:none; font-size:13px; }
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
  ${sections}
  <footer>매일 자동 수집 · 최신순 정렬</footer>
</div>
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
        entry.files.push({ path: rel, name: f.name || 'file', mimetype: f.mimetype || '' });
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
