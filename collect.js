// 슬랙 자료방을 읽어 archive.html(다크) + archive_light.html(라이트)을 갱신하는 스크립트
// RUN_MODE=full: 전체 수집 (격주 금요일·수동 실행) / RUN_MODE=linkcheck: 유튜브 링크 점검만 (매일)
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TOKEN = process.env.SLACK_BOT_TOKEN;
const MODE = process.env.RUN_MODE === 'linkcheck' ? 'linkcheck' : 'full';
const CHANNEL_ID = 'C0BJU8K7LSH';          // 자료방 채널 고유번호
const CHANNEL_NAME = 'genai-2d_정보-공유';  // 화면 표시용 이름
const DATA_FILE = 'data/archive.json';
const STATE_FILE = 'data/state.json';
const THUMBS_FILE = 'data/thumbs.json';
const TITLES_FILE = 'data/titles.json';
const FILES_DIR = 'files';
const THUMBS_DIR = 'files/thumbs';
const MAX_FILE_MB = 95;
const THUMB_BUDGET = 40;
const CONVERT_BUDGET = 20;  // 실행 1회당 영상 변환 최대 개수
const COMMENT_BUDGET = 30;  // 실행 1회당 댓글 갱신 최대 카드 수

// 검사를 통과했는데도 화면이 안 나오는 영상 — 여기에 파일명을 적으면 무조건 재인코딩함
const FORCE_CONVERT = [];

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

const PRETENDARD = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">';
const FONT_STACK = "'Pretendard',system-ui,'Apple SD Gothic Neo','Malgun Gothic',sans-serif";

// 테마 정의 (다크/라이트 두 파일 생성) — 포털에서 추출한 정확한 색상값 사용
const THEMES = {
  dark: {
    name: 'dark',
    file: 'archive.html',
    vars: { bg: '#0c0f1e', panel: '#1c2237', panel2: '#262c45', line: '#2e3654', lineSoft: '#232a44',
      text: '#f1f5f9', textDim: '#98a3b7', textMute: '#404c65', accent: '#385cf5' },
    onAccent: '#ffffff',
    ctrlBg: 'rgba(12,15,30,.97)',
    headBg: '#182240',
    months: ['#5d7bff'],   // 월별 컬러 통일 (다크 배경에서 읽히도록 살짝 밝은 블루)
    fontLink: PRETENDARD,
    fontFamily: FONT_STACK,
    cardShadow: 'none',
    hoverCss: '.entry:hover { border-color:var(--accent); }',
  },
  light: {
    name: 'light',
    file: 'archive_light.html',
    vars: { bg: '#eff2f7', panel: '#ffffff', panel2: '#e3e8f0', line: '#dbe2ec', lineSoft: '#e6ebf3',
      text: '#374154', textDim: '#6b7689', textMute: '#94a3b8', accent: '#385cf5' },
    onAccent: '#ffffff',
    ctrlBg: 'rgba(239,242,247,.97)',
    headBg: '#e2eafc',
    months: ['#385cf5'],   // 월별 컬러 통일
    fontLink: PRETENDARD,
    fontFamily: FONT_STACK,
    cardShadow: '0 1px 3px rgba(16,24,40,.06)',
    hoverCss: '.entry:hover { background:#e2eafc; }',
  },
};

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

// ---------- 댓글(스레드 답글) 수집 ----------
async function syncComments(archive) {
  const parents = new Map();
  let cursor;
  do {
    const r = await slack('conversations.history', {
      channel: CHANNEL_ID, limit: 200, ...(cursor ? { cursor } : {}),
    });
    for (const m of r.messages) if (m.reply_count) parents.set(m.ts, m.reply_count);
    cursor = r.has_more && r.response_metadata ? r.response_metadata.next_cursor : null;
  } while (cursor);

  let budget = COMMENT_BUDGET;
  for (const e of archive) {
    const rc = parents.get(e.ts) || 0;
    const cur = (e.comments || []).length;
    if (rc === 0) { if (cur) e.comments = []; continue; }
    if (rc === cur) continue;
    if (budget-- <= 0) continue;
    try {
      const r = await slack('conversations.replies', { channel: CHANNEL_ID, ts: e.ts, limit: 200 });
      e.comments = (r.messages || [])
        .filter(m => m.ts !== e.ts)
        .map(m => ({ date: fmtDate(m.ts), text: cleanText(m.text) }))
        .filter(c => c.text);
      console.log('댓글 갱신: ' + e.date + ' 카드 — ' + e.comments.length + '개');
    } catch (err) { console.warn('댓글 조회 실패: ' + err.message); }
  }
}

// ---------- 영상 코덱 검사·변환·손상 복구 ----------
function ffmpegAvailable() {
  try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function ffprobeInfo(p) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'csv=p=0', p]).toString().trim();
    if (!out) return null;
    const [codec, pix] = out.split(',');
    return { codec: (codec || '').trim(), pix: (pix || '').trim() };
  } catch { return null; }
}

function isWebPlayable(info) {
  const okCodec = ['h264', 'vp8', 'vp9'].includes(info.codec); // av1 제외!
  const okPix = info.pix === 'yuv420p' || info.pix === 'yuvj420p';
  return okCodec && okPix;
}

// 비정상 vpcC 박스(빈 VP9 코덱 설정)를 'free' 박스로 바꿔서 파서가 건너뛰게 하는 구조 패치
function tryPatchVpcc(p) {
  try {
    const buf = fs.readFileSync(p);
    const needle = Buffer.from('vpcC');
    let idx = -1, n = 0;
    while ((idx = buf.indexOf(needle, idx + 1)) !== -1) { buf.write('free', idx, 'ascii'); n++; }
    if (!n) return false;
    fs.writeFileSync(p, buf);
    return true;
  } catch { return false; }
}

// 손상된 파일을 슬랙에서 다시 다운로드
async function refetchFromSlack(e, f) {
  const r = await slack('conversations.replies', { channel: CHANNEL_ID, ts: e.ts, limit: 1 });
  const m = (r.messages || [])[0];
  const sf = ((m && m.files) || []).find(x => (x.name || '') === f.name);
  if (!sf) return false;
  f.permalink = sf.permalink || f.permalink || '';
  const res = await fetch(sf.url_private_download || sf.url_private, {
    headers: { Authorization: 'Bearer ' + TOKEN },
  });
  if (!res.ok) return false;
  fs.writeFileSync(f.path, Buffer.from(await res.arrayBuffer()));
  return true;
}

async function ensureWebVideos(archive) {
  if (!ffmpegAvailable()) {
    console.warn('⚠ ffmpeg/ffprobe가 실행 환경에 없어 영상 변환을 전부 건너뜁니다. archive.yml의 "ffmpeg 설치" 단계를 확인하세요.');
    return;
  }
  let budget = CONVERT_BUDGET;
  for (const e of archive) {
    for (const f of e.files) {
      if (f.oversized) continue;
      if (!(f.mimetype || '').startsWith('video/')) continue;
      if (!f.path || !fs.existsSync(f.path)) { f.vok = true; continue; }
      const force = FORCE_CONVERT.includes(f.name) && !/_web\d?\.mp4$/.test(f.path);
      const needRepair = f.broken && !f.vpatch;
      if (!force && f.vok && !needRepair) continue;
      if (budget <= 0) continue;
      let info = ffprobeInfo(f.path);
      let patchedNow = false;
      if (!info) {
        if (!f.redl) {
          f.redl = true;
          console.log('파일 손상 의심, 슬랙에서 재다운로드 시도: ' + f.name);
          const ok = await refetchFromSlack(e, f).catch(() => false);
          if (ok) info = ffprobeInfo(f.path);
          if (info) console.log('재다운로드로 복구됨: ' + f.name);
        }
        if (!info && !f.vpatch) {
          f.vpatch = true;
          if (tryPatchVpcc(f.path)) {
            info = ffprobeInfo(f.path);
            if (info) { patchedNow = true; console.log('구조 패치로 복구됨(' + info.codec + '): ' + f.name); }
          }
        }
        if (!info) {
          f.broken = true; f.vok = true;
          console.warn('복구 불가 — 카드에서 제거 예정: ' + f.name);
          continue;
        }
        f.broken = false;
      }
      if (!force && !patchedNow && isWebPlayable(info)) { f.vok = true; continue; }
      budget--;
      const out = f.path.replace(/(_web\d?)?\.[^.]+$/, '') + '_web4.mp4';
      const codecInfo = info.codec + '/' + info.pix;
      try {
        execFileSync('ffmpeg', ['-y', '-i', f.path,
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-profile:v', 'high', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-movflags', '+faststart', out], { stdio: 'ignore' });
        if (fs.statSync(out).size > MAX_FILE_MB * 1024 * 1024) {
          fs.unlinkSync(out); f.vok = true;
          console.log('변환 결과가 너무 커서 원본 유지: ' + f.name);
          continue;
        }
        fs.unlinkSync(f.path);
        f.path = out; f.mimetype = 'video/mp4'; f.vok = true; f.broken = false;
        console.log((force ? '강제 ' : '') + '영상 변환 완료(' + codecInfo + ' → h264/yuv420p): ' + f.name);
      } catch {
        f.vtries = (f.vtries || 0) + 1;
        if (f.vtries >= 3) { f.broken = true; f.vok = true; console.warn('변환 3회 실패 — 카드에서 제거 예정: ' + f.name); }
        else console.warn('변환 실패(다음 실행 때 재시도): ' + f.name + ' (' + codecInfo + ')');
      }
    }
  }
}

// 복구 불가 영상 파일을 카드에서 제거하고, 빈 카드는 삭제
function pruneBrokenFiles(archive) {
  let removedFiles = 0, removedCards = 0;
  for (const e of archive) {
    const before = e.files.length;
    e.files = e.files.filter(f => {
      if (f.broken) {
        if (f.path && fs.existsSync(f.path)) { try { fs.unlinkSync(f.path); } catch {} }
        return false;
      }
      return true;
    });
    removedFiles += before - e.files.length;
  }
  for (let i = archive.length - 1; i >= 0; i--) {
    const e = archive[i];
    if (!e.text && !e.links.length && !e.files.length) { archive.splice(i, 1); removedCards++; }
  }
  if (removedFiles) console.log('복구 불가 영상 ' + removedFiles + '개 제거, 빈 카드 ' + removedCards + '개 삭제');
}

// ---------- 링크 썸네일·페이지 제목·유튜브 검사 ----------
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

function cleanTitle(s) {
  const t = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim().slice(0, 120);
  return t || null;
}

async function fetchPageMeta(pageUrl) {
  const res = await fetchWithTimeout(pageUrl, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en' } });
  if (!res.ok) return { img: null, title: null };
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return { img: null, title: null };
  const html = (await res.text()).slice(0, 400000);
  const im = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["'][^>]*content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)/i);
  const tm = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:title["']/i)
        || html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  let img = null;
  if (im) { try { img = new URL(im[1].replace(/&amp;/g, '&'), pageUrl).href; } catch {} }
  return { img, title: tm ? cleanTitle(tm[1]) : null };
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

async function collectThumbs(archive, thumbs, titles) {
  let budget = THUMB_BUDGET;
  for (const e of archive) {
    for (const u of e.links) {
      const yid = youtubeId(u);
      if (yid) { if (!(u in thumbs)) thumbs[u] = 'https://i.ytimg.com/vi/' + yid + '/mqdefault.jpg'; continue; }
      const needThumb = !(u in thumbs);
      const needTitle = !(u in titles);
      if (!needThumb && !needTitle) continue;
      if (budget <= 0) continue;
      budget--;
      try {
        const meta = await fetchPageMeta(u);
        if (needTitle) titles[u] = meta.title;
        if (needThumb) thumbs[u] = meta.img ? await downloadThumb(meta.img, crypto.createHash('md5').update(u).digest('hex').slice(0, 16)) : null;
        console.log('메타 수집 (썸네일 ' + (thumbs[u] ? 'O' : 'X') + '/제목 ' + (titles[u] ? 'O' : 'X') + '): ' + u.slice(0, 60));
      } catch {
        if (needTitle) titles[u] = null;
        if (needThumb) thumbs[u] = null;
      }
    }
  }
}

// 유튜브 링크 전수 검사: 제목 갱신 + 재생 불가(삭제·비공개·잘못된 링크)를 링크·본문에서 제거
const YT_TEXT_RE = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[\w-]{11}[^\s]*/g;

async function checkYoutubeLinks(archive, titles, thumbs) {
  const dead = new Set();
  const checked = new Set();
  const candidates = new Set();
  for (const e of archive) {
    for (const u of e.links) if (youtubeId(u)) candidates.add(u);
    for (const m of (e.text || '').matchAll(YT_TEXT_RE)) {
      const u = m[0].startsWith('http') ? m[0] : 'https://' + m[0];
      if (youtubeId(u)) candidates.add(u);
    }
  }
  for (const u of candidates) {
    if (checked.has(u)) continue;
    checked.add(u);
    try {
      const res = await fetchWithTimeout('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(u),
        { headers: { 'User-Agent': UA } });
      if (res.ok) {
        const t = (await res.json()).title || null;
        if (t) titles[u] = t;
      } else if ([400, 401, 403, 404].includes(res.status)) {
        dead.add(u);
        console.log('재생 불가 유튜브 제거: ' + u + ' (HTTP ' + res.status + ')');
      }
    } catch { /* 네트워크 오류는 유지 */ }
  }
  if (!dead.size) { console.log('유튜브 검사 완료: 제거 대상 없음 (' + checked.size + '개 확인)'); return; }
  const deadIds = new Set([...dead].map(u => youtubeId(u)).filter(Boolean));
  for (const e of archive) {
    e.links = e.links.filter(u => !(youtubeId(u) && deadIds.has(youtubeId(u))));
    if (e.text) {
      e.text = e.text.replace(YT_TEXT_RE, s => {
        const id = youtubeId(s.startsWith('http') ? s : 'https://' + s);
        return id && deadIds.has(id) ? '' : s;
      }).replace(/\n{3,}/g, '\n\n').trim();
    }
  }
  let removedCards = 0;
  for (let i = archive.length - 1; i >= 0; i--) {
    const e = archive[i];
    if (!e.text && !e.links.length && !e.files.length) { archive.splice(i, 1); removedCards++; }
  }
  for (const u of dead) {
    const th = thumbs[u];
    if (th && !String(th).startsWith('http')) { try { fs.unlinkSync(th); } catch {} }
    delete thumbs[u];
    delete titles[u];
  }
  console.log('유튜브 검사 완료: 링크 ' + dead.size + '개 제거, 빈 카드 ' + removedCards + '개 삭제');
}

// ---------- HTML 생성 ----------
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function linkify(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '링크'; }
}

function brandFor(host, T) {
  for (const [k, v] of Object.entries(BRAND)) {
    if (host === k || host.endsWith('.' + k)) return v;
  }
  return [T.vars.accent, T.onAccent];
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
  const linkTitles = e.links.map(u => titles[u] || '');
  const cmts = (e.comments || []).map(c => c.text);
  return [e.text, ...e.links, ...linkTitles, ...cmts, ...e.files.map(f => f.name)].join(' ').toLowerCase().replace(/\s+/g, '');
}

function renderEntry(e, thumbs, titles, T) {
  let btns = '';
  const thumbCards = [];
  for (const u of e.links) {
    const host = domainOf(u);
    const [bg, fg] = brandFor(host, T);
    btns += `<a class="btn" style="background:${bg};color:${fg}" href="${esc(u)}" target="_blank" rel="noopener">${esc(host)} ↗</a>`;
    const th = thumbs[u];
    if (th) {
      const src = th.startsWith('http') ? esc(th) : encodeURI(th);
      const tt = titles[u] ? `<span class="th-title">${esc(titles[u])}</span>` : '';
      thumbCards.push(`<a class="thumb" href="${esc(u)}" target="_blank" rel="noopener">${tt}<img src="${src}" alt="" loading="lazy"><span class="th-tag" style="background:${bg};color:${fg}">${esc(host)}</span></a>`);
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
  let autoTitle = '';
  if (!e.text && e.links.length) {
    const at = e.links.map(u => titles[u]).find(Boolean);
    if (at) autoTitle = `<p class="auto-title"><span class="at-tag">자동 제목</span>${esc(at)}</p>`;
  }
  const cmts = e.comments || [];
  let cmtHtml = '';
  if (cmts.length) {
    const items = cmts.map(c =>
      `<div class="cmt-item"><span class="cmt-date">${esc(c.date.slice(5))}</span><span class="cmt-text">${linkify(esc(c.text))}</span></div>`).join('');
    cmtHtml = `<div class="cmt"><button type="button" class="cmt-tgl">💬 댓글 ${cmts.length} <span class="arr">▲</span></button><div class="cmt-body">${items}</div></div>`;
  }
  const title = (e.text || e.links.map(u => titles[u] || domainOf(u)).join(', ') || (e.files[0] && e.files[0].name) || '').slice(0, 60);
  return `<article class="entry" data-ts="${e.ts}" data-month="${e.date.slice(0, 7)}" data-types="${entryTypes(e)}" data-topics="${esc(entryTopics(e))}" data-search="${esc(searchKey(e, titles))}">
<div class="e-head"><span class="e-date">${e.date.slice(5)}</span><span class="e-title">${esc(title)}</span><button type="button" class="e-tgl">▾</button></div>
<div class="e-body">
${e.text ? `<p class="e-text">${esc(e.text)}</p>` : autoTitle}
${btns ? `<div class="e-btns">${btns}</div>` : ''}
${thumbCards.length ? `<div class="thumb-grid">${thumbCards.join('')}</div>` : ''}
${attach ? `<div class="attach">${attach}</div>` : ''}
${cmtHtml}
</div>
</article>`;
}

function renderHtml(archive, thumbs, titles, T) {
  const V = T.vars;
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
    const color = T.months[parseInt(mo) % T.months.length];
    monthOptions += `<option value="${key}">${y}년 ${parseInt(mo)}월</option>`;
    sections += `<section class="month" data-key="${key}" style="--maccent:${color}"><div class="month-head"><h2>${y}년 ${parseInt(mo)}월</h2><span class="count">${entries.length}건</span><button type="button" class="m-tgl">▾ 접기</button></div>
<div class="m-body">
${entries.map(e => renderEntry(e, thumbs, titles, T)).join('\n')}
</div></section>\n`;
  }
  const topicOptions = ['<option value="all">주제: 전체</option>']
    .concat(TOPICS.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`), ['<option value="기타">기타</option>'])
    .join('');
  const themeSwitch = `<div class="theme-sw">
    <a href="archive.html" class="tsw${T.name === 'dark' ? ' on' : ''}">다크</a>
    <a href="archive_light.html" class="tsw${T.name === 'light' ? ' on' : ''}">라이트</a>
  </div>`;
  const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>#${esc(CHANNEL_NAME)} — 슬랙 아카이브</title>
${T.fontLink}
<style>
  :root { --bg:${V.bg}; --panel:${V.panel}; --panel-2:${V.panel2}; --line:${V.line}; --line-soft:${V.lineSoft};
    --text:${V.text}; --text-dim:${V.textDim}; --text-mute:${V.textMute}; --accent:${V.accent}; --on-accent:${T.onAccent}; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:${T.fontFamily}; line-height:1.55; padding:0 0 5rem; }
  .wrap { width:100%; max-width:none; margin:0 auto; padding:0 18px; }
  header { padding:22px 0 10px; position:relative; }
  .eyebrow { font-size:10.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--accent); margin-bottom:5px; font-family:monospace; }
  h1 { font-size:22px; letter-spacing:-.02em; margin-bottom:3px; }
  .sub { color:var(--text-dim); font-size:12.5px; }
  .theme-sw { position:absolute; top:20px; right:0; display:flex; gap:3px; background:var(--panel-2);
    border:1px solid var(--line); border-radius:10px; padding:3px; }
  .tsw { padding:5px 14px; border-radius:8px; font-size:12px; color:var(--text-dim); text-decoration:none; font-weight:500; }
  .tsw:hover { color:var(--text); }
  .tsw.on { background:var(--accent); color:var(--on-accent); font-weight:700; }
  .controls { position:sticky; top:0; z-index:20; background:${T.ctrlBg}; backdrop-filter:blur(4px);
    padding:10px 0; border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:12px 14px; align-items:center; }
  #q { flex:0 1 520px; min-width:240px; margin-right:auto; background:var(--panel); border:1px solid var(--line); color:var(--text);
    padding:9px 13px; border-radius:9px; font-size:13.5px; outline:none; box-shadow:${T.cardShadow}; }
  #q:focus { border-color:var(--accent); }
  .chip { background:var(--panel-2); border:1px solid var(--line); color:var(--text-dim); padding:7px 14px;
    border-radius:9px; font-size:12.5px; cursor:pointer; box-shadow:${T.cardShadow}; font-weight:500; }
  .chip:hover { border-color:var(--accent); }
  .chip.on { background:var(--accent); color:var(--on-accent); border-color:var(--accent); font-weight:700; }
  .lbl { font-size:11.5px; color:var(--text-mute); }
  .vgroup { display:flex; gap:6px; align-items:center; }
  .sub-btn { background:var(--panel-2); border:1px dashed var(--text-mute); color:var(--text-dim);
    padding:4px 10px; border-radius:8px; font-size:11px; cursor:pointer; }
  .sub-btn:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
  .sub-btn:disabled { opacity:.3; cursor:not-allowed; }
  select { background:var(--panel-2); border:1px solid var(--line); color:var(--text); padding:8px 9px; border-radius:9px; font-size:12.5px; box-shadow:${T.cardShadow}; }
  .slider-box { display:flex; align-items:center; gap:8px; background:var(--panel-2); border:1px solid var(--line);
    border-radius:9px; padding:6px 14px; box-shadow:${T.cardShadow}; }
  .slider-box input[type=range] { width:100px; accent-color:var(--accent); cursor:pointer; }
  .slider-box b { font-family:monospace; font-size:12px; color:var(--accent); min-width:10px; text-align:center; }
  .count-line { color:var(--text-mute); font-size:12px; }
  .count-line b { color:var(--accent); }
  .month { padding-top:28px; }
  .month-head { display:flex; align-items:center; gap:12px; padding:10px 15px; margin-bottom:14px; border-radius:10px;
    background:${T.headBg};
    border:1px solid color-mix(in srgb, var(--maccent) 28%, var(--line)); }
  .month-head h2 { font-size:19px; color:var(--maccent); }
  .month-head .count { font-family:monospace; font-size:12.5px; color:var(--text-dim); }
  .m-tgl { margin-left:auto; background:none; border:1px solid color-mix(in srgb, var(--maccent) 42%, var(--line));
    color:var(--maccent); padding:5px 13px; border-radius:8px; cursor:pointer; font-size:12px; font-weight:700; }
  .m-tgl:hover { background:color-mix(in srgb, var(--maccent) 15%, var(--bg)); }
  .month.closed .m-body { display:none !important; }
  .m-body { columns:var(--cols, 4); column-gap:14px; }
  #archiveRoot.view-fixed .m-body { display:grid; grid-template-columns:repeat(var(--cols, 4), 1fr); gap:14px; columns:auto; }
  #archiveRoot.view-fixed .entry { height:360px; overflow-y:auto; margin:0; }
  @media (max-width:680px) {
    .m-body { columns:1 !important; }
    #archiveRoot.view-fixed .m-body { grid-template-columns:1fr !important; }
  }
  .entry { background:var(--panel);
    border:1px solid var(--line);
    border-left:4px solid var(--maccent);
    border-radius:10px; padding:14px 16px; margin:0 0 14px; break-inside:avoid; box-shadow:${T.cardShadow};
    transition:border-color .15s, background .15s; }
  ${T.hoverCss}
  .e-head { display:flex; align-items:center; gap:10px; margin-bottom:7px; }
  .e-date { font-family:monospace; font-size:15.5px; font-weight:800; color:var(--maccent); letter-spacing:.02em; white-space:nowrap; }
  .e-title { display:none; font-size:12.5px; color:var(--text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; }
  .e-tgl { display:none; margin-left:auto; background:none; border:none; color:var(--maccent); font-size:15px; cursor:pointer; }
  #archiveRoot.view-collapse .e-tgl { display:inline-block; }
  #archiveRoot.view-collapse .e-head { cursor:pointer; }
  #archiveRoot.view-collapse .entry.closed .e-title { display:block; }
  .entry.closed .e-body { display:none; }
  .entry.closed { padding-bottom:11px; }
  .e-text { white-space:pre-wrap; word-break:break-word; font-size:13.5px; line-height:1.65; margin-bottom:10px; }
  .auto-title { font-size:13px; color:var(--text-dim); margin-bottom:10px; word-break:break-word; }
  .at-tag { display:inline-block; font-size:9.5px; font-family:monospace; color:var(--text-mute);
    border:1px dashed var(--text-mute); border-radius:4px; padding:1px 5px; margin-right:7px; vertical-align:1px; }
  .e-btns { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:10px; }
  .btn { display:inline-flex; align-items:center; gap:6px; font-weight:700; font-size:12px;
    padding:6px 12px; border-radius:8px; text-decoration:none; }
  .btn:hover { opacity:.82; }
  .btn-slack { background:#4A154B; color:#fff; }
  .thumb-grid { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:10px; }
  .thumb { position:relative; display:block; width:100%; max-width:340px; border-radius:9px; overflow:hidden;
    border:1px solid var(--line); background:var(--panel-2); }
  .thumb img { width:100%; display:block; }
  .thumb .th-title { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
    font-size:11.5px; line-height:1.45; color:var(--text); padding:7px 10px; border-bottom:1px solid var(--line); }
  .thumb .th-tag { position:absolute; left:8px; bottom:8px; font-family:monospace; font-size:10px;
    font-weight:700; padding:3px 8px; border-radius:5px; opacity:.94; }
  .thumb:hover img { opacity:.85; }
  .attach { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-start; }
  .a-img { max-width:100%; max-height:260px; border-radius:9px; border:1px solid var(--line); display:block; }
  .v-wrap { margin:0; width:100%; }
  .v-wrap video { width:100%; border-radius:9px; border:1px solid var(--line); display:block; background:#000; }
  .v-wrap figcaption { font-size:11.5px; color:var(--text-mute); margin-top:5px; word-break:break-all; }
  .file-link { display:inline-flex; align-items:center; gap:6px; background:var(--panel-2); border:1px solid var(--line);
    color:var(--text); padding:8px 12px; border-radius:8px; text-decoration:none; font-size:12.5px; word-break:break-all; }
  .file-link:hover { border-color:var(--accent); }
  .cmt { margin-top:11px; border-top:1px dashed var(--line); padding-top:7px; }
  .cmt-tgl { background:none; border:none; color:var(--text-dim); font-size:12px; font-weight:700; cursor:pointer; padding:2px 0; }
  .cmt-tgl:hover { color:var(--accent); }
  .cmt-tgl .arr { font-size:10px; color:var(--text-mute); }
  .cmt.closed .cmt-body { display:none; }
  .cmt-item { display:flex; gap:8px; padding-top:7px; font-size:12.5px; }
  .cmt-date { font-family:monospace; font-size:10.5px; color:var(--text-mute); white-space:nowrap; padding-top:2px; }
  .cmt-text { white-space:pre-wrap; word-break:break-word; color:var(--text-dim); line-height:1.55; }
  .cmt-text a { color:var(--accent); }
  #toTop { position:fixed; right:22px; bottom:22px; z-index:30; width:46px; height:46px; border-radius:50%;
    border:none; background:var(--accent); color:var(--on-accent); font-size:19px; font-weight:800; cursor:pointer;
    box-shadow:0 4px 14px rgba(0,0,0,.25); opacity:0; pointer-events:none; transition:opacity .25s; }
  #toTop.show { opacity:1; pointer-events:auto; }
  #toTop:hover { opacity:.85; }
  footer { margin-top:40px; padding-top:16px; border-top:1px solid var(--line); color:var(--text-mute); font-size:11.5px; font-family:monospace; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">Slack Auto Archive</div>
    <h1>#${esc(CHANNEL_NAME)} 채널</h1>
    <p class="sub">슬랙 아카이브 · 총 ${archive.length}건 · 마지막 갱신 ${now} (KST)</p>
    ${themeSwitch}
  </header>
  <div class="controls">
    <input id="q" type="search" placeholder="검색 — 제목·링크·파일명·댓글 (띄어쓰기 무관)">
    <div class="slider-box"><span class="lbl">그리드</span><input type="range" id="gridSize" min="1" max="5" step="1" value="3"><b id="gridVal">3</b></div>
    <span class="lbl">보기</span>
    <div class="vgroup">
      <button type="button" id="viewCollapse" class="chip on">접기식</button>
      <button type="button" id="btnCloseAll" class="sub-btn">└ 모두 접기</button>
      <button type="button" id="btnOpenAll" class="sub-btn">└ 모두 펼치기</button>
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
  <footer>매일 링크 점검 · 격주 금요일 전체 수집 · 최신순 정렬</footer>
</div>
<button id="toTop" title="맨 위로">↑</button>
<script>
(function () {
  var q = document.getElementById('q');
  var gridSize = document.getElementById('gridSize');
  var gridVal = document.getElementById('gridVal');
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
  function applyGrid() {
    var v = parseInt(gridSize.value, 10);
    gridVal.textContent = v;
    root.style.setProperty('--cols', v + 1);
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
    var dis = mode !== 'collapse';
    btnCloseAll.disabled = dis;
    btnOpenAll.disabled = dis;
    if (dis) entries.forEach(function (el) { el.classList.remove('closed'); });
  }
  q.addEventListener('input', apply);
  gridSize.addEventListener('input', applyGrid);
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
  document.querySelectorAll('.cmt-tgl').forEach(function (b) {
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var c = b.parentElement;
      c.classList.toggle('closed');
      var arr = b.querySelector('.arr');
      if (arr) arr.textContent = c.classList.contains('closed') ? '▼' : '▲';
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
  applyGrid();
})();
</script>
</body>
</html>`;
}

// ---------- 메인 ----------
(async () => {
  fs.mkdirSync('data', { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.mkdirSync(THUMBS_DIR, { recursive: true });

  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const archive = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : [];
  const thumbs = fs.existsSync(THUMBS_FILE) ? JSON.parse(fs.readFileSync(THUMBS_FILE, 'utf8')) : {};
  const titles = fs.existsSync(TITLES_FILE) ? JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8')) : {};

  let lastTs = state.lastTs || '0';

  if (MODE === 'full') {
    if (!TOKEN) { console.error('SLACK_BOT_TOKEN이 설정되지 않았습니다.'); process.exit(1); }
    const seen = new Set(archive.map(e => e.ts));
    const messages = await fetchNewMessages(CHANNEL_ID, state.lastTs);
    console.log('새 메시지 ' + messages.length + '건');

    for (const m of messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))) {
      if (parseFloat(m.ts) > parseFloat(lastTs)) lastTs = m.ts;
      if (seen.has(m.ts)) continue;
      const entry = { ts: m.ts, date: fmtDate(m.ts), text: cleanText(m.text), links: extractLinks(m.text), files: [], comments: [] };
      for (const f of m.files || []) {
        try {
          const rel = await downloadFile(f, m.ts);
          if (rel) {
            entry.files.push({ path: rel, name: f.name || 'file', mimetype: f.mimetype || '', permalink: f.permalink || '' });
          } else {
            entry.files.push({ path: '', name: f.name || 'file', mimetype: f.mimetype || '', oversized: true, permalink: f.permalink || '' });
            console.log('용량 초과로 링크만 기록: ' + (f.name || ''));
          }
        } catch (e) { console.warn('파일 다운로드 실패: ' + (f.name || '') + ' — ' + e.message); }
      }
      if (entry.text || entry.links.length || entry.files.length) archive.push(entry);
    }
  } else {
    console.log('일일 점검 모드: 슬랙 수집 생략, 유튜브 링크 검사만 수행');
  }

  archive.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
  if (MODE === 'full') {
    await syncComments(archive);
    await ensureWebVideos(archive);
    pruneBrokenFiles(archive);
  }
  await checkYoutubeLinks(archive, titles, thumbs);
  if (MODE === 'full') await collectThumbs(archive, thumbs, titles);

  fs.writeFileSync(DATA_FILE, JSON.stringify(archive, null, 2));
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastTs }));
  fs.writeFileSync(THUMBS_FILE, JSON.stringify(thumbs, null, 2));
  fs.writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
  for (const T of Object.values(THEMES)) {
    fs.writeFileSync(T.file, renderHtml(archive, thumbs, titles, T));
  }
  console.log('완료(' + MODE + '): 총 ' + archive.length + '건, 다크·라이트 HTML 갱신됨');
})().catch(e => { console.error(e.message || e); process.exit(1); });
