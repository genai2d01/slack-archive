// 슬랙 자료방을 읽어 archive.html을 갱신하는 스크립트 (GitHub Actions가 격주 금요일 실행)
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL_ID = 'C0BJU8K7LSH';          // 자료방 채널 고유번호
const CHANNEL_NAME = 'genai-2d_정보-공유';  // 화면 표시용 이름
const DATA_FILE = 'data/archive.json';
const STATE_FILE = 'data/state.json';
const THUMBS_FILE = 'data/thumbs.json';
const TITLES_FILE = 'data/titles.json';
const FILES_DIR = 'files';
const THUMBS_DIR = 'files/thumbs';
const HTML_FILE = 'archive.html';
const MAX_FILE_MB = 95;
const THUMB_BUDGET = 40;
const TITLE_BUDGET = 60;   // 실행 1회당 유튜브 제목 조회 최대 개수
const CONVERT_BUDGET = 20; // 실행 1회당 영상 변환 최대 개수

// 검사를 통과했는데도 화면이 안 나오는 영상 — 여기에 파일명을 적으면 무조건 재인코딩함
const FORCE_CONVERT = [
  'Emotion_Flow.mp4',
];

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

// 월별 톤온톤 포인트 컬러 (월 숫자 기준 고정)
const MONTH_COLORS = ['#7dd3c0', '#8fb8de', '#b3a1e0', '#d9c08a', '#d99aa8', '#93c99a'];

// 주제 자동 분류 규칙 (여러 주제에 동시 포함 가능)
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

// ---------- 영상 코덱 검사·변환 ----------
function ffprobeInfo(p) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'csv=p=0', p]).toString().trim();
    const [codec, pix] = out.split(',');
    return { codec: (codec || '').trim(), pix: (pix || '').trim() };
  } catch { return null; }
}

function isWebPlayable(info) {
  if (!info) return true;
  const okCodec = ['h264', 'vp8', 'vp9', 'av1'].includes(info.codec);
  const okPix = info.pix === 'yuv420p' || info.pix === 'yuvj420p';
  return okCodec && okPix;
}

function ensureWebVideos(archive) {
  let budget = CONVERT_BUDGET;
  for (const e of archive) {
    for (const f of e.files) {
      if (f.oversized) continue;
      if (!(f.mimetype || '').startsWith('video/')) continue;
      if (!f.path || !fs.existsSync(f.path)) { f.webok = true; continue; }
      const force = FORCE_CONVERT.includes(f.name) && !f.path.endsWith('_web2.mp4') && !f.path.endsWith('_web3.mp4');
      if (!force && f.webok) continue;
      if (budget <= 0) continue;
      const info = ffprobeInfo(f.path);
      if (!force && isWebPlayable(info)) { f.webok = true; continue; }
      budget--;
      const suffix = force ? '_web3.mp4' : '_web2.mp4';
      const out = f.path.replace(/(_web2?)?\.[^.]+$/, '') + suffix;
      const codecInfo = info ? info.codec + '/' + info.pix : '판별불가';
      try {
        execFileSync('ffmpeg', ['-y', '-i', f.path,
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-profile:v', 'high', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-movflags', '+faststart', out], { stdio: 'ignore' });
        if (fs.statSync(out).size > MAX_FILE_MB * 1024 * 1024) {
          fs.unlinkSync(out); f.webok = true;
          console.log('변환 결과가 너무 커서 원본 유지: ' + f.name);
          continue;
        }
        fs.unlinkSync(f.path);
        f.path = out; f.mimetype = 'video/mp4'; f.webok = true;
        console.log((force ? '강제 ' : '') + '영상 변환 완료(' + codecInfo + ' → h264/yuv420p): ' + f.name);
      } catch {
        f.tries = (f.tries || 0) + 1;
        if (f.tries >= 3) { f.webok = true; console.warn('변환 3회 실패, 포기: ' + f.name); }
        else console.warn('변환 실패(다음 실행 때 재시도): ' + f.name + ' (' + codecInfo + ')');
      }
    }
  }
}

// ---------- 링크 썸네일·유튜브 제목 ----------
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

async function collectTitles(archive, titles) {
  let budget = TITLE_BUDGET;
  for (const e of archive) {
    for (const u of e.links) {
      if (!youtubeId(u) || u in titles || budget <= 0) continue;
      budget--;
      try {
        const res = await fetchWithTimeout('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(u),
          { headers: { 'User-Agent': UA } });
        titles[u] = res.ok ? ((await res.json()).title || null) : null;
      } catch { titles[u] = null; }
      console.log('유튜브 제목 ' + (titles[u] ? 'OK' : '없음') + ': ' + u.slice(0, 60));
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
  const hasYt = e.links.some(u => youtubeId(u));
  const hasVidFile = e.files.some(f => (f.mimetype || '').startsWith('video/'));
  if (hasYt || hasVidFile) t.add('video');
  if (e.links.some(u => !youtubeId(u))) t.add('link');
  for (const f of e.files) {
    if ((f.mimetype || '').startsWith('image/')) t.add('image');
    else if (!(f.mimetype || '').startsWith('video/')) t.add('doc');
  }
  if (!e.links.length && !e.files.length && e.text) t.add('text');
  return [...t].join(' ');
}

function entryTopics(e) {
  const hay = [e.text, ...e.links, ...e.files.map(f => f.name)].join(' ').toLowerCase();
  const names = TOPICS.filter(tp => tp.keywords.some(k => hay.includes(k))).map(tp => tp.name);
  return names.length ? names.join(' ') : '기타';
}

function searchKey(e, titles) {
  const ytTitles = e.links.map(u => titles[u] || '');
  return [e.text, ...e.links, ...ytTitles, ...e.files.map(f => f.name)].join(' ').toLowerCase().replace(/\s+/g, '');
}

function renderEntry(e, thumbs, titles) {
  let btns = '';
  const thumbCards = [];
  for (const u of e.links) {
    const host = domainOf(u);
    const [bg, fg] = brandFor(host);
    btns += `<a class="btn" style="background:${bg};color:${fg}" href="${esc(u)}" target="_blank" rel="noopener">${esc(host)} ↗</a>`;
    const th = thumbs[u];
    if (th) {
      const src = th.startsWith('http') ? esc(th) : encodeURI(th);
      const yt = youtubeId(u) && titles[u] ? `<span class="th-title">${esc(titles[u])}</span>` : '';
      thumbCards.push(`<a class="thumb" href="${esc(u)}" target="_blank" rel="noopener">${yt}<img src="${src}" alt="" loading="lazy"><span class="th-tag" style="background:${bg};color:${fg}">${esc(host)}</span></a>`);
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
      attach += `<figure class="v-wrap"><video src="${src}" controls preload="metadata"></video><figcaption>🎬 ${esc(f.name)}</figcaption></figure>`;
    } else {
      attach += `<a class="file-link" href="${src}" download>📎 ${esc(f.name)}</a>`;
    }
  }
  const title = (e.text || e.links.map(u => titles[u] || domainOf(u)).join(', ') || (e.files[0] && e.files[0].name) || '').slice(0, 60);
  return `<article class="entry" data-ts="${e.ts}" data-month="${e.date.slice(0, 7)}" data-types="${entryTypes(e)}" data-topics="${esc(entryTopics(e))}" data-search="${esc(searchKey(e, titles))}">
<div class="e-head"><span class="e-date">${e.date.slice(5)}</span><span class="e-title">${esc(title)}</span><button type="button" class="e-tgl">▾</button></div>
<div class="e-body">
${e.text ? `<p class="e-text">${esc(e.text)}</p>` : ''}
${btns ? `<div class="e-btns">${btns}</div>` : ''}
${thumbCards.length ? `<div class="thumb-grid">${thumbCards.join('')}</div>` : ''}
${attach ? `<div class="attach">${attach}</div>` : ''}
</div>
</article>`;
}

function renderHtml(archive, thumbs, titles) {
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
    sections += `<section class="month" data-key="${key}" style="--maccent:${color}"><div class="month-head"><h2>${y}년 ${parseInt(mo)}월</h2><span class="count">${entries.length}건</span><button type="button" class="m-tgl">▾ 접기</button></div>
<div class="m-body">
${entries.map(e => renderEntry(e, thumbs, titles)).join('\n')}
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
<title>#${esc(CHANNEL_NAME)} — 슬랙 아카이브</title>
<style>
  :root { --bg:#0f1115; --panel:#161a21; --panel-2:#1c212a; --line:#262c37; --line-soft:#1f242e;
    --text:#e6e9ef; --text-dim:#9aa4b2; --text-mute:#6b7482; --accent:#7dd3c0; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:system-ui,'Apple SD Gothic Neo','Malgun Gothic',sans-serif; line-height:1.55; padding:0 0 6rem; }
  .wrap { max-width:1720px; margin:0 auto; padding:0 28px; }
  header { padding:44px 0 20px; }
  .eyebrow { font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:var(--accent); margin-bottom:10px; font-family:monospace; }
  h1 { font-size:30px; letter-spacing:-.02em; margin-bottom:6px; }
  .sub { color:var(--text-dim); font-size:14px; }
  .controls { position:sticky; top:0; z-index:20; background:rgba(15,17,21,.97); backdrop-filter:blur(4px);
    padding:14px 0; border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  #q { flex:1 1 220px; min-width:170px; background:var(--panel); border:1px solid var(--line); color:var(--text);
    padding:10px 14px; border-radius:9px; font-size:14px; outline:none; }
  #q:focus { border-color:var(--accent); }
  .chip { background:var(--panel); border:1px solid var(--line); color:var(--text-dim); padding:8px 15px;
    border-radius:999px; font-size:13px; cursor:pointer; }
  .chip.on { background:var(--accent); color:#0f1115; border-color:var(--accent); font-weight:700; }
  .lbl { font-size:12px; color:var(--text-mute); margin-left:2px; }
  .vgroup { display:flex; gap:6px; align-items:center; }
  .sub-btn { background:var(--panel-2); border:1px dashed var(--line); color:var(--text-dim); padding:7px 13px;
    border-radius:999px; font-size:12.5px; cursor:pointer; }
  .sub-btn:hover { border-color:var(--accent); color:var(--accent); }
  select { background:var(--panel); border:1px solid var(--line); color:var(--text); padding:9px 10px; border-radius:9px; font-size:13px; }
  .count-line { color:var(--text-mute); font-size:12.5px; margin-left:auto; }
  .count-line b { color:var(--accent); }
  .month { padding-top:34px; }
  .month-head { display:flex; align-items:center; gap:12px; padding:11px 16px; margin-bottom:16px; border-radius:11px;
    background:color-mix(in srgb, var(--maccent) 15%, var(--bg));
    border:1px solid color-mix(in srgb, var(--maccent) 40%, var(--line)); }
  .month-head h2 { font-size:22px; color:var(--maccent); }
  .month-head .count { font-family:monospace; font-size:13px; color:var(--text-dim); }
  .m-tgl { margin-left:auto; background:none; border:1px solid color-mix(in srgb, var(--maccent) 45%, var(--line));
    color:var(--maccent); padding:6px 14px; border-radius:8px; cursor:pointer; font-size:12.5px; font-weight:700; }
  .m-tgl:hover { background:color-mix(in srgb, var(--maccent) 18%, var(--bg)); }
  .month.closed .m-body { display:none !important; }
  .m-body { columns:4; column-gap:16px; }
  @media (max-width:1500px) { .m-body { columns:3; } #archiveRoot.view-fixed .m-body { grid-template-columns:repeat(3,1fr); } }
  @media (max-width:1050px) { .m-body { columns:2; } #archiveRoot.view-fixed .m-body { grid-template-columns:repeat(2,1fr); } }
  @media (max-width:680px)  { .m-body { columns:1; } #archiveRoot.view-fixed .m-body { grid-template-columns:1fr; } }
  #archiveRoot.view-fixed .m-body { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; columns:auto; }
  #archiveRoot.view-fixed .entry { height:360px; overflow-y:auto; margin:0; }
  .entry { background:var(--panel); background:color-mix(in srgb, var(--maccent) 7%, var(--panel));
    border:1px solid color-mix(in srgb, var(--maccent) 22%, var(--line));
    border-left:4px solid var(--maccent);
    border-radius:12px; padding:15px 17px; margin:0 0 16px; break-inside:avoid; }
  .e-head { display:flex; align-items:center; gap:10px; margin-bottom:7px; }
  .e-date { font-family:monospace; font-size:16px; font-weight:800; color:var(--maccent); letter-spacing:.02em; white-space:nowrap; }
  .e-title { display:none; font-size:13px; color:var(--text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; }
  .e-tgl { display:none; margin-left:auto; background:none; border:none; color:var(--maccent); font-size:15px; cursor:pointer; }
  #archiveRoot.view-collapse .e-tgl { display:inline-block; }
  #archiveRoot.view-collapse .e-head { cursor:pointer; }
  #archiveRoot.view-collapse .entry.closed .e-title { display:block; }
  .entry.closed .e-body { display:none; }
  .entry.closed { padding-bottom:12px; }
  .e-text { white-space:pre-wrap; word-break:break-word; font-size:14px; line-height:1.65; margin-bottom:10px; }
  .e-btns { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:10px; }
  .btn { display:inline-flex; align-items:center; gap:6px; font-weight:700; font-size:12.5px;
    padding:7px 13px; border-radius:8px; text-decoration:none; }
  .btn:hover { opacity:.82; }
  .btn-slack { background:#4A154B; color:#fff; }
  .thumb-grid { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:10px; }
  .thumb { position:relative; display:block; width:100%; max-width:340px; border-radius:10px; overflow:hidden;
    border:1px solid var(--line); background:var(--panel-2); }
  .thumb img { width:100%; display:block; }
  .thumb .th-title { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
    font-size:12px; line-height:1.45; color:var(--text); padding:7px 10px; border-bottom:1px solid var(--line); }
  .thumb .th-tag { position:absolute; left:8px; bottom:8px; font-family:monospace; font-size:10.5px;
    font-weight:700; padding:3px 8px; border-radius:5px; opacity:.94; }
  .thumb:hover img { opacity:.85; }
  .attach { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-start; }
  .a-img { max-width:100%; max-height:260px; border-radius:10px; border:1px solid var(--line); display:block; }
  .v-wrap { margin:0; width:100%; }
  .v-wrap video { width:100%; border-radius:10px; border:1px solid var(--line); display:block; background:#000; }
  .v-wrap figcaption { font-size:12px; color:var(--text-mute); margin-top:5px; word-break:break-all; }
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
    <h1>#${esc(CHANNEL_NAME)} 채널</h1>
    <p class="sub">슬랙 아카이브 · 총 ${archive.length}건 · 마지막 갱신 ${now} (KST)</p>
  </header>
  <div class="controls">
    <input id="q" type="search" placeholder="검색 — 제목·링크·파일명 (띄어쓰기 무관)">
    <span class="lbl">보기</span>
    <div class="vgroup">
      <button type="button" id="viewCollapse" class="chip on">접기식</button>
      <button type="button" id="btnCloseAll" class="sub-btn">모두 접기</button>
      <button type="button" id="btnOpenAll" class="sub-btn">모두 펼치기</button>
      <button type="button" id="viewFixed" class="chip">균일 크기</button>
    </div>
    <select id="sortSel">
      <option value="new">최신순</option>
      <option value="old">오래된순</option>
    </select>
    <select id="topicSel">${topicOptions}</select>
    <select id="monthSel">${monthOptions}</select>
    <button type="button" class="chip on" data-type="all">전체</button>
    <button type="button" class="chip" data-type="video">영상/유튜브</button>
    <button type="button" class="chip" data-type="image">이미지</button>
    <button type="button" class="chip" data-type="doc">문서</button>
    <button type="button" class="chip" data-type="link">링크</button>
    <button type="button" class="chip" data-type="text">텍스트</button>
    <span class="count-line">총 ${archive.length}건 중 <b id="resultCount">${archive.length}</b>건 표시</span>
  </div>
  <main id="archiveRoot" class="view-collapse">
  ${sections}
  </main>
  <footer>격주 금요일 자동 수집 · 최신순 정렬</footer>
</div>
<button id="toTop" title="맨 위로">↑</button>
<script>
(function () {
  var q = document.getElementById('q');
  var viewCollapse = document.getElementById('viewCollapse');
  var viewFixed = document.getElementById('viewFixed');
  var btnCloseAll = document.getElementById('btnCloseAll');
  var btnOpenAll = document.getElementById('btnOpenAll');
  var sortSel = document.getElementById('sortSel');
  var topicSel = document.getElementById('topicSel');
  var monthSel = document.getElementById('monthSel');
  var chips = document.querySelectorAll('.chip[data-type]');
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
  function setView(mode) {
    root.classList.remove('view-collapse', 'view-fixed');
    root.classList.add('view-' + mode);
    viewCollapse.classList.toggle('on', mode === 'collapse');
    viewFixed.classList.toggle('on', mode === 'fixed');
    var showSub = mode === 'collapse' ? '' : 'none';
    btnCloseAll.style.display = showSub;
    btnOpenAll.style.display = showSub;
    if (mode !== 'collapse') {
      entries.forEach(function (el) { el.classList.remove('closed'); });
    }
  }
  q.addEventListener('input', apply);
  monthSel.addEventListener('change', apply);
  topicSel.addEventListener('change', apply);
  sortSel.addEventListener('change', resort);
  viewCollapse.addEventListener('click', function () { setView('collapse'); });
  viewFixed.addEventListener('click', function () { setView('fixed'); });
  btnCloseAll.addEventListener('click', function () {
    entries.forEach(function (el) { el.classList.add('closed'); });
  });
  btnOpenAll.addEventListener('click', function () {
    entries.forEach(function (el) { el.classList.remove('closed'); });
  });
  document.querySelectorAll('.e-head').forEach(function (h) {
    h.addEventListener('click', function () {
      if (!root.classList.contains('view-collapse')) return;
      h.parentElement.classList.toggle('closed');
    });
  });
  document.querySelectorAll('.m-tgl').forEach(function (b) {
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var sec = b.closest('.month');
      sec.classList.toggle('closed');
      b.textContent = sec.classList.contains('closed') ? '▸ 펼치기' : '▾ 접기';
    });
  });
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
  setView('collapse');
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
  const titles = fs.existsSync(TITLES_FILE) ? JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8')) : {};
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
  ensureWebVideos(archive);
  await collectThumbs(archive, thumbs);
  await collectTitles(archive, titles);

  fs.writeFileSync(DATA_FILE, JSON.stringify(archive, null, 2));
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastTs }));
  fs.writeFileSync(THUMBS_FILE, JSON.stringify(thumbs, null, 2));
  fs.writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
  fs.writeFileSync(HTML_FILE, renderHtml(archive, thumbs, titles));
  console.log('완료: 총 ' + archive.length + '건, archive.html 갱신됨');
})().catch(e => { console.error(e.message || e); process.exit(1); });
