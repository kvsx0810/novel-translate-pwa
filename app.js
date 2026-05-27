// ── app.js ────────────────────────────────────────────────────────────────────
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  engine: null,
  engineReady: false,
  metadataLoaded: false,
  epub: null,
  chapters: [],       // [{id, title, content(raw html/text)}]
  currentChap: 0,
  profiles: {},
  activeProfile: null,
  customGlobal: '',
  phienAmMap: new Map(),
  // reader settings
  fontSize: 18,
  lineWidth: 680,
  lineHeight: 1.9,
  theme: 'dark',
};

// Selected spans for popup
let selectedSpans = [];
let popup = null;

const PARTICLES = new Set(['的','了','着','著','过','過','地','得']);
const CJK_RE = /[\u3400-\u9FBF]/;

// ── Storage (IndexedDB for big data, localStorage for settings) ───────────────
const DB_NAME = 'novel-reader-cv';
const DB_VER  = 1;

function dbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess  = e => res(e.target.result);
    req.onerror    = e => rej(e.target.error);
  });
}
async function dbGet(key) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const req = db.transaction('kv','readonly').objectStore('kv').get(key);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
async function dbSet(key, val) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const req = db.transaction('kv','readwrite').objectStore('kv').put(val, key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

function lsGet(k, def) {
  try { const v = localStorage.getItem(k); return v !== null ? JSON.parse(v) : def; }
  catch { return def; }
}
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

// ── EPUB Parser (JSZip-based, bundled inline) ─────────────────────────────────
// Load JSZip from CDN lazily
let JSZip = null;
async function ensureJSZip() {
  if (JSZip) return;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  JSZip = window.JSZip;
}

async function parseEpub(file) {
  await ensureJSZip();
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  // Find container.xml → rootfile path
  const containerXml = await zip.file('META-INF/container.xml').async('string');
  const rootfilePath = containerXml.match(/full-path="([^"]+)"/)?.[1];
  if (!rootfilePath) throw new Error('Không tìm thấy rootfile trong EPUB');

  const opfDir = rootfilePath.includes('/') ? rootfilePath.substring(0, rootfilePath.lastIndexOf('/') + 1) : '';
  const opfXml = await zip.file(rootfilePath).async('string');

  // Parse book title
  const bookTitle = opfXml.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/)?.[1]?.trim() || file.name.replace('.epub','');

  // Parse spine order
  const spineMatches = [...opfXml.matchAll(/<itemref[^>]+idref="([^"]+)"/g)].map(m => m[1]);
  // Parse manifest
  const manifestItems = {};
  for (const m of opfXml.matchAll(/<item\s[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*media-type="([^"]+)"/g)) {
    manifestItems[m[1]] = { href: m[2], type: m[3] };
  }
  // Also capture items where media-type comes before id
  for (const m of opfXml.matchAll(/<item\s[^>]*href="([^"]+)"[^>]*id="([^"]+)"[^>]*media-type="([^"]+)"/g)) {
    if (!manifestItems[m[2]]) manifestItems[m[2]] = { href: m[1], type: m[3] };
  }

  // Build chapters
  const chapters = [];
  for (const idref of spineMatches) {
    const item = manifestItems[idref];
    if (!item) continue;
    if (!item.type.includes('html') && !item.type.includes('xml')) continue;
    const href = opfDir + item.href.split('#')[0];
    const fileInZip = zip.file(href) || zip.file(decodeURIComponent(href));
    if (!fileInZip) continue;
    const html = await fileInZip.async('string');
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Try to get a chapter title from h1/h2/h3 or title tag
    const titleEl = doc.querySelector('h1, h2, h3, .chapter-title, .title') || doc.querySelector('title');
    const title = titleEl?.textContent?.trim() || `Chương ${chapters.length + 1}`;

    // Get text content paragraphs
    // Remove scripts, styles, nav
    doc.querySelectorAll('script, style, nav').forEach(el => el.remove());
    const body = doc.body || doc.documentElement;
    chapters.push({ id: idref, title, bodyHTML: body.innerHTML, rawText: body.textContent });
  }

  if (chapters.length === 0) throw new Error('Không tìm thấy chương nào trong EPUB');
  return { title: bookTitle, chapters };
}

// ── Engine Init ───────────────────────────────────────────────────────────────
async function initEngine() {
  const engine = window.DictEngine;
  if (!engine) throw new Error('DictEngine không tìm thấy');
  state.engine = engine;

  // Load metadata from IDB
  const metadata = await dbGet('metadata');
  if (!metadata) throw new Error('metadata.json chưa được load');

  // Build phienAmMap
  for (const dict of metadata.data.importedDicts) {
    if (dict.name === 'ChinesePhienAmWords.txt') {
      for (const line of dict.tsv.split('\n')) {
        const parts = line.split('\t');
        if (parts.length >= 2 && parts[0].length === 1) state.phienAmMap.set(parts[0], parts[1]);
      }
    }
    const priority = parseInt(dict.tsv.split('\t')[2]) || 10;
    const kv = dict.tsv.split('\n')
      .map(l => { const p = l.split('\t'); return p.length >= 2 ? `${p[0]}=${p[1]}` : ''; })
      .filter(Boolean).join('\n');
    await engine.importDictText(kv, priority, dict.name);
  }

  // Load custom-global
  if (state.customGlobal) await engine.importDictText(state.customGlobal, 990, 'custom-global');

  // Load active profile
  await loadActiveProfileToEngine();

  state.engineReady = true;
}

async function loadActiveProfileToEngine() {
  const engine = state.engine;
  if (!engine) return;
  const { activeProfile, profiles } = state;
  if (activeProfile && profiles[activeProfile]?.phrases) {
    await engine.importDictText(profiles[activeProfile].phrases, 999, 'custom-profile');
  }
}

// ── Translate & Render ────────────────────────────────────────────────────────
function renderChapterContent(bodyHTML) {
  if (!state.engineReady) return;

  const container = document.getElementById('chapter-body');
  container.innerHTML = '';

  // Parse the HTML and walk text nodes
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${bodyHTML}</div>`, 'text/html');
  const sourceDiv = doc.body.firstChild;

  // Convert sourceDiv children to paragraphs for reader
  const paragraphs = extractParagraphs(sourceDiv);

  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const p = document.createElement('p');
    if (CJK_RE.test(para)) {
      translateAndInsert(para, p);
    } else {
      p.textContent = para;
    }
    container.appendChild(p);
  }
}

function extractParagraphs(el) {
  const result = [];
  function walk(node) {
    if (node.nodeType === 3) {
      const t = node.textContent.trim();
      if (t) result.push(t);
    } else if (node.nodeType === 1) {
      const tag = node.tagName.toLowerCase();
      if (['p','div','br','h1','h2','h3','h4','li','tr'].includes(tag)) {
        const inner = node.textContent.trim();
        if (inner) result.push(inner);
      } else {
        for (const c of node.childNodes) walk(c);
      }
    }
  }
  for (const c of el.childNodes) walk(c);
  // Deduplicate consecutive identical
  return result.filter((v,i,a) => i === 0 || v !== a[i-1]);
}

function translateAndInsert(text, container) {
  const engine = state.engine;
  const items = engine.segmentDisplay(text);
  if (!items || !items.length) { container.textContent = text; return; }

  const frag = document.createDocumentFragment();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'filler') {
      frag.appendChild(document.createTextNode(item.text));
    } else {
      if (i > 0 && items[i-1].type !== 'filler') {
        frag.appendChild(document.createTextNode(' '));
      }
      const span = document.createElement('span');
      span.className = 'cv-word';
      span.dataset.zw = item.zh;
      span.dataset.hv = item.hv;
      span.dataset.vi = item.vi || item.hv;
      span.textContent = PARTICLES.has(item.zh) ? '' : (item.vi || item.hv);
      frag.appendChild(span);
    }
  }
  container.appendChild(frag);
}

// ── Chapter Navigation ────────────────────────────────────────────────────────
function goToChapter(idx) {
  if (idx < 0 || idx >= state.chapters.length) return;
  state.currentChap = idx;
  lsSet('lastChap_' + (state.epub?.title || ''), idx);

  const chap = state.chapters[idx];
  document.getElementById('chapter-title').textContent = chap.title;
  document.getElementById('hdr-book-title').textContent = chap.title;
  document.getElementById('nav-info').textContent = `${idx + 1} / ${state.chapters.length}`;
  document.getElementById('btn-prev-chap').disabled = idx === 0;
  document.getElementById('btn-next-chap').disabled = idx === state.chapters.length - 1;

  // Mark active in TOC
  document.querySelectorAll('#toc-list li').forEach((li, i) => li.classList.toggle('active', i === idx));

  // Show loading
  const body = document.getElementById('chapter-body');
  body.innerHTML = '<div class="loading-spinner"><div class="spinner"></div> Đang dịch...</div>';

  // Render async so UI can update
  setTimeout(() => {
    renderChapterContent(chap.bodyHTML);
    document.getElementById('reader-content').scrollTo(0, 0);
  }, 30);
}

// ── Popup ─────────────────────────────────────────────────────────────────────
function getAllSpans() { return [...document.querySelectorAll('span.cv-word')]; }

function removePopup() {
  if (popup) { popup.remove(); popup = null; }
  selectedSpans.forEach(s => s.classList.remove('selected'));
  selectedSpans = [];
}

function getHanVietForSpans(spans) {
  return spans.map(s => {
    const hv = s.dataset.hv || '';
    return hv.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }).join(' ');
}

function showPopup(x, y) {
  if (popup) popup.remove();

  const zw = selectedSpans.map(s => s.dataset.zw).join('');
  const vi = selectedSpans.map(s => s.textContent).join(' ');
  const hv = getHanVietForSpans(selectedSpans);

  selectedSpans.forEach(s => s.classList.add('selected'));

  const el = document.getElementById('word-popup');
  document.getElementById('popup-hv').textContent = hv;
  document.getElementById('popup-vi').textContent = vi;
  document.getElementById('popup-input').value = hv;
  document.getElementById('popup-status').textContent = '';
  el.style.display = 'flex';

  // Position
  const vw = window.innerWidth, vh = window.innerHeight;
  const pw = Math.min(340, vw * 0.9);
  let left = x, top = y + 12;
  if (left + pw > vw - 8) left = vw - pw - 8;
  if (left < 8) left = 8;
  const ph = 180;
  if (top + ph > vh - 8) top = y - ph - 8;
  el.style.left = left + 'px';
  el.style.top  = top + 'px';
  popup = el;

  document.getElementById('popup-copy').onclick = e => {
    e.stopPropagation();
    navigator.clipboard.writeText(zw).then(() => {
      document.getElementById('popup-status').textContent = '✓ Đã copy: ' + zw;
    });
  };

  document.getElementById('popup-exp-left').onclick = e => {
    e.stopPropagation();
    const all = getAllSpans();
    const idx = all.indexOf(selectedSpans[0]);
    if (idx > 0) { selectedSpans.unshift(all[idx - 1]); showPopup(x, y); }
  };
  document.getElementById('popup-exp-right').onclick = e => {
    e.stopPropagation();
    const all = getAllSpans();
    const idx = all.indexOf(selectedSpans[selectedSpans.length - 1]);
    if (idx < all.length - 1) { selectedSpans.push(all[idx + 1]); showPopup(x, y); }
  };

  document.getElementById('popup-add-profile').onclick = async e => {
    e.stopPropagation();
    const viText = document.getElementById('popup-input').value.trim();
    if (!viText) return;
    const zwText = selectedSpans.map(s => s.dataset.zw).join('');
    await addToProfile(zwText, viText);
    document.getElementById('popup-status').textContent = `✓ Đã thêm "${zwText}=${viText}"`;
    setTimeout(removePopup, 1500);
  };

  document.getElementById('popup-add-global').onclick = async e => {
    e.stopPropagation();
    const viText = document.getElementById('popup-input').value.trim();
    if (!viText) return;
    const zwText = selectedSpans.map(s => s.dataset.zw).join('');
    await addToGlobal(zwText, viText);
    document.getElementById('popup-status').textContent = `✓ Global: "${zwText}=${viText}"`;
    setTimeout(removePopup, 1500);
  };
}

// ── Name Management ───────────────────────────────────────────────────────────
async function addToProfile(zw, vi) {
  if (!state.activeProfile) {
    // Auto-create default profile named after book
    const bookName = state.epub?.title || 'default';
    const id = bookName.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9\-]/g,'').substring(0,30) || 'default';
    if (!state.profiles[id]) state.profiles[id] = { name: bookName, phrases: '' };
    state.activeProfile = id;
    await saveProfiles();
    renderProfileSelect();
  }
  const prof = state.profiles[state.activeProfile];
  const lines = (prof.phrases || '').split('\n').filter(Boolean);
  const idx = lines.findIndex(l => l.startsWith(zw + '='));
  if (idx >= 0) lines[idx] = `${zw}=${vi}`; else lines.push(`${zw}=${vi}`);
  prof.phrases = lines.join('\n');
  await saveProfiles();
  await state.engine.importDictText(`${zw}=${vi}`, 999, 'custom-profile');
  // Update existing spans on page
  updateSpansOnPage(zw, vi);
  renderPhraseList();
}

async function addToGlobal(zw, vi) {
  const lines = (state.customGlobal || '').split('\n').filter(Boolean);
  const idx = lines.findIndex(l => l.startsWith(zw + '='));
  if (idx >= 0) lines[idx] = `${zw}=${vi}`; else lines.push(`${zw}=${vi}`);
  state.customGlobal = lines.join('\n');
  await dbSet('customGlobal', state.customGlobal);
  await state.engine.importDictText(`${zw}=${vi}`, 990, 'custom-global');
  updateSpansOnPage(zw, vi);
  renderGlobalPhraseList();
}

function updateSpansOnPage(zw, vi) {
  document.querySelectorAll(`span.cv-word[data-zw="${zw}"]`).forEach(s => {
    s.textContent = vi;
    s.dataset.vi = vi;
  });
}

async function saveProfiles() {
  await dbSet('profiles', state.profiles);
  await dbSet('activeProfile', state.activeProfile);
}

async function loadSavedState() {
  state.profiles    = (await dbGet('profiles')) || {};
  state.activeProfile = (await dbGet('activeProfile')) || null;
  state.customGlobal  = (await dbGet('customGlobal')) || '';
  state.fontSize      = lsGet('fontSize', 18);
  state.lineWidth     = lsGet('lineWidth', 680);
  state.lineHeight    = lsGet('lineHeight', 1.9);
  state.theme         = lsGet('theme', 'dark');
}

// ── UI: Settings panel ────────────────────────────────────────────────────────
function renderProfileSelect() {
  const sel = document.getElementById('profile-select');
  sel.innerHTML = '<option value="">— Không dùng profile —</option>';
  for (const [id, prof] of Object.entries(state.profiles)) {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = prof.name || id;
    if (id === state.activeProfile) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderPhraseList() {
  const list = document.getElementById('phrase-list');
  list.innerHTML = '';
  if (!state.activeProfile || !state.profiles[state.activeProfile]) return;
  const lines = (state.profiles[state.activeProfile].phrases || '').split('\n').filter(Boolean);
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const zw = line.substring(0, eq);
    const vi = line.substring(eq + 1);
    list.appendChild(makePhraseItem(zw, vi, false));
  }
}

function renderGlobalPhraseList() {
  const list = document.getElementById('global-phrase-list');
  list.innerHTML = '';
  for (const line of (state.customGlobal || '').split('\n').filter(Boolean)) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    list.appendChild(makePhraseItem(line.substring(0, eq), line.substring(eq + 1), true));
  }
}

function makePhraseItem(zw, vi, isGlobal) {
  const item = document.createElement('div');
  item.className = 'phrase-item';
  item.innerHTML = `
    <span class="phrase-zw">${zw}</span>
    <span class="phrase-vi">${vi}</span>
    <div class="phrase-edit" style="display:none;flex:1"><input type="text" value="${vi}"></div>
    <button class="phrase-save" style="display:none">✓</button>
    <button class="phrase-del">✕</button>
  `;
  const zwEl  = item.querySelector('.phrase-zw');
  const viEl  = item.querySelector('.phrase-vi');
  const editEl = item.querySelector('.phrase-edit');
  const saveBtn = item.querySelector('.phrase-save');
  const delBtn  = item.querySelector('.phrase-del');
  const input   = item.querySelector('input');

  const toggleEdit = () => {
    const editing = editEl.style.display === 'flex';
    viEl.style.display   = editing ? 'block' : 'none';
    editEl.style.display = editing ? 'none'  : 'flex';
    saveBtn.style.display = editing ? 'none' : 'inline';
    if (!editing) input.focus();
  };
  zwEl.addEventListener('click', toggleEdit);
  viEl.addEventListener('click', toggleEdit);

  saveBtn.addEventListener('click', async () => {
    const newVi = input.value.trim();
    if (!newVi) return;
    if (isGlobal) await addToGlobal(zw, newVi);
    else await addToProfile(zw, newVi);
  });

  delBtn.addEventListener('click', async () => {
    if (isGlobal) {
      const lines = (state.customGlobal || '').split('\n').filter(l => !l.startsWith(zw + '='));
      state.customGlobal = lines.join('\n');
      await dbSet('customGlobal', state.customGlobal);
      renderGlobalPhraseList();
    } else {
      if (!state.activeProfile) return;
      const prof = state.profiles[state.activeProfile];
      prof.phrases = (prof.phrases || '').split('\n').filter(l => !l.startsWith(zw + '=')).join('\n');
      await saveProfiles();
      renderPhraseList();
    }
  });

  return item;
}

function applyReaderSettings() {
  const root = document.documentElement;
  root.style.setProperty('--font-size', state.fontSize + 'px');
  root.style.setProperty('--line-width', state.lineWidth + 'px');
  root.style.setProperty('--line-height', state.lineHeight);
  document.body.className = 'theme-' + state.theme;
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === state.theme));
  document.getElementById('font-size').value = state.fontSize;
  document.getElementById('font-size-val').textContent = state.fontSize;
  document.getElementById('line-width').value = state.lineWidth;
  document.getElementById('line-width-val').textContent = state.lineWidth;
  document.getElementById('line-height').value = state.lineHeight;
  document.getElementById('line-height-val').textContent = state.lineHeight;
}

function buildToc() {
  const list = document.getElementById('toc-list');
  list.innerHTML = '';
  state.chapters.forEach((chap, i) => {
    const li = document.createElement('li');
    li.textContent = chap.title;
    if (i === state.currentChap) li.classList.add('active');
    li.addEventListener('click', () => { goToChapter(i); closeToc(); });
    list.appendChild(li);
  });
}

// ── Drawer helpers ────────────────────────────────────────────────────────────
function openToc() {
  document.getElementById('toc-drawer').classList.add('open');
  document.getElementById('toc-overlay').classList.add('open');
}
function closeToc() {
  document.getElementById('toc-drawer').classList.remove('open');
  document.getElementById('toc-overlay').classList.remove('open');
}
function openSettings() {
  renderProfileSelect(); renderPhraseList(); renderGlobalPhraseList();
  document.getElementById('settings-drawer').classList.add('open');
  document.getElementById('settings-overlay').classList.add('open');
}
function closeSettings() {
  document.getElementById('settings-drawer').classList.remove('open');
  document.getElementById('settings-overlay').classList.remove('open');
}

// ── Setup Screen Logic ────────────────────────────────────────────────────────
let setupReady = { engine: false, epub: false };

function checkSetupReady() {
  document.getElementById('btn-start').disabled = !(setupReady.engine && setupReady.epub);
}

function setStepDone(step, msg) {
  const el = document.getElementById(`step-${step}`);
  el.classList.add('done'); el.classList.remove('error');
  document.getElementById(`${step}-status`).textContent = msg;
  document.getElementById(`${step}-badge`).textContent = '✓';
}
function setStepError(step, msg) {
  const el = document.getElementById(`step-${step}`);
  el.classList.add('error'); el.classList.remove('done');
  document.getElementById(`${step}-status`).textContent = msg;
  document.getElementById(`${step}-badge`).textContent = '✗';
  document.getElementById('setup-error').textContent = msg;
}

// Auto-load engine + metadata (metadata parsed in Web Worker to avoid blocking UI)
const METADATA_URL = 'https://pub-9771e4ccafeb496c99991ae2aa19d12e.r2.dev/metadata.json';

async function autoLoadEngineAndMeta() {
  try {
    document.getElementById('engine-status').textContent = 'Đang tải engine...';

    // Load dict-engine.js
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = './core/dict-engine.js';
      s.onload = res;
      s.onerror = () => rej(new Error('Không tải được core/dict-engine.js'));
      document.head.appendChild(s);
    });
    if (!window.DictEngine) throw new Error('DictEngine không tìm thấy sau khi load');

    // Check IDB cache first
    const cached = await dbGet('metadata');
    if (cached?.data?.importedDicts) {
      setStepDone('engine', `✓ Engine + ${cached.data.importedDicts.length} từ điển (cache)`);
      setupReady.engine = true;
      checkSetupReady();
      return;
    }

    // Fetch + parse in Web Worker
    document.getElementById('engine-status').textContent = 'Đang tải từ điển (lần đầu ~65MB)...';
    const json = await new Promise((res, rej) => {
      const worker = new Worker('./metadata-worker.js');
      worker.postMessage({ url: METADATA_URL });
      worker.onmessage = e => {
        const { type, text, data, message } = e.data;
        if (type === 'progress') {
          document.getElementById('engine-status').textContent = text;
        } else if (type === 'done') {
          worker.terminate();
          res(data);
        } else if (type === 'error') {
          worker.terminate();
          rej(new Error(message));
        }
      };
      worker.onerror = e => { worker.terminate(); rej(new Error(e.message)); };
    });

    document.getElementById('engine-status').textContent = 'Đang lưu cache...';
    await dbSet('metadata', json);

    setStepDone('engine', `✓ Engine + ${json.data.importedDicts.length} từ điển`);
    setupReady.engine = true;
  } catch(e) {
    setStepError('engine', '✗ ' + e.message);
  }
  checkSetupReady();
}

// Load EPUB
document.getElementById('input-epub').addEventListener('change', async function() {
  const file = this.files[0]; if (!file) return;
  try {
    document.getElementById('epub-status').textContent = 'Đang phân tích EPUB...';
    const result = await parseEpub(file);
    state.epub = result;
    state.chapters = result.chapters;
    setStepDone('epub', `✓ ${result.title} — ${result.chapters.length} chương`);
    setupReady.epub = true;
  } catch(e) {
    setStepError('epub', '✗ Lỗi: ' + e.message);
  }
  checkSetupReady();
});

// Start reading
document.getElementById('btn-start').addEventListener('click', async () => {
  const btn = document.getElementById('btn-start');
  btn.textContent = 'Đang khởi động engine...';
  btn.disabled = true;
  try {
    await initEngine();
    // Switch to reader
    document.getElementById('screen-setup').classList.remove('active');
    const reader = document.getElementById('screen-reader');
    reader.style.display = 'flex';
    reader.classList.add('active');
    applyReaderSettings();
    buildToc();
    // Restore last read position
    const lastChap = lsGet('lastChap_' + (state.epub?.title || ''), 0);
    goToChapter(Math.min(lastChap, state.chapters.length - 1));
  } catch(e) {
    btn.textContent = 'Bắt đầu đọc →';
    btn.disabled = false;
    document.getElementById('setup-error').textContent = '✗ ' + e.message;
  }
});

// ── Reader Event Listeners ────────────────────────────────────────────────────
document.getElementById('btn-back-setup').addEventListener('click', () => {
  document.getElementById('screen-reader').style.display = 'none';
  document.getElementById('screen-reader').classList.remove('active');
  document.getElementById('screen-setup').classList.add('active');
});

document.getElementById('btn-toc').addEventListener('click', openToc);
document.getElementById('toc-close').addEventListener('click', closeToc);
document.getElementById('toc-overlay').addEventListener('click', closeToc);

document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-overlay').addEventListener('click', closeSettings);

document.getElementById('btn-prev-chap').addEventListener('click', () => goToChapter(state.currentChap - 1));
document.getElementById('btn-next-chap').addEventListener('click', () => goToChapter(state.currentChap + 1));

// TOC search
document.getElementById('toc-search').addEventListener('input', function() {
  const q = this.value.toLowerCase();
  document.querySelectorAll('#toc-list li').forEach(li => {
    li.style.display = li.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});

// Theme buttons
document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.theme = btn.dataset.theme;
    lsSet('theme', state.theme);
    applyReaderSettings();
  });
});

// Font size slider
document.getElementById('font-size').addEventListener('input', function() {
  state.fontSize = +this.value;
  document.getElementById('font-size-val').textContent = state.fontSize;
  document.documentElement.style.setProperty('--font-size', state.fontSize + 'px');
  lsSet('fontSize', state.fontSize);
});
// Line width slider
document.getElementById('line-width').addEventListener('input', function() {
  state.lineWidth = +this.value;
  document.getElementById('line-width-val').textContent = state.lineWidth;
  document.documentElement.style.setProperty('--line-width', state.lineWidth + 'px');
  lsSet('lineWidth', state.lineWidth);
});
// Line height slider
document.getElementById('line-height').addEventListener('input', function() {
  state.lineHeight = +this.value;
  document.getElementById('line-height-val').textContent = state.lineHeight;
  document.documentElement.style.setProperty('--line-height', state.lineHeight);
  lsSet('lineHeight', state.lineHeight);
});

// Profile select
document.getElementById('profile-select').addEventListener('change', async function() {
  state.activeProfile = this.value || null;
  await saveProfiles();
  await loadActiveProfileToEngine();
  renderPhraseList();
  // Re-render current chapter with new profile
  if (state.engineReady) goToChapter(state.currentChap);
});

// New profile
document.getElementById('btn-new-profile').addEventListener('click', () => {
  const f = document.getElementById('new-profile-form');
  f.style.display = f.style.display === 'none' ? 'flex' : 'none';
});
document.getElementById('btn-create-profile').addEventListener('click', async () => {
  const name = document.getElementById('new-profile-name').value.trim();
  if (!name) return;
  const id = name.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9\-]/g,'') || ('p' + Date.now());
  state.profiles[id] = { name, phrases: '' };
  state.activeProfile = id;
  await saveProfiles();
  document.getElementById('new-profile-name').value = '';
  document.getElementById('new-profile-form').style.display = 'none';
  renderProfileSelect();
  renderPhraseList();
});
document.getElementById('btn-del-profile').addEventListener('click', async () => {
  if (!state.activeProfile) return;
  if (!confirm(`Xóa profile "${state.profiles[state.activeProfile]?.name}"?`)) return;
  delete state.profiles[state.activeProfile];
  state.activeProfile = null;
  await saveProfiles();
  renderProfileSelect();
  renderPhraseList();
});

// Manual add
document.getElementById('manual-add-profile').addEventListener('click', async () => {
  const zw = document.getElementById('manual-zw').value.trim();
  const vi = document.getElementById('manual-vi').value.trim();
  if (!zw || !vi) return;
  await addToProfile(zw, vi);
  document.getElementById('manual-zw').value = '';
  document.getElementById('manual-vi').value = '';
});
document.getElementById('manual-add-global').addEventListener('click', async () => {
  const zw = document.getElementById('manual-zw').value.trim();
  const vi = document.getElementById('manual-vi').value.trim();
  if (!zw || !vi) return;
  await addToGlobal(zw, vi);
  document.getElementById('manual-zw').value = '';
  document.getElementById('manual-vi').value = '';
});

// Export/Import
document.getElementById('btn-export-profile').addEventListener('click', () => {
  if (!state.activeProfile || !state.profiles[state.activeProfile]) return;
  const text = state.profiles[state.activeProfile].phrases || '';
  downloadText(text, (state.activeProfile || 'profile') + '.txt');
});
document.getElementById('btn-export-global').addEventListener('click', () => {
  downloadText(state.customGlobal || '', 'custom-global.txt');
});
document.getElementById('input-import-profile').addEventListener('change', async function() {
  const file = this.files[0]; if (!file) return;
  const text = await file.text();
  if (!state.activeProfile) return alert('Chọn profile trước!');
  const prof = state.profiles[state.activeProfile];
  const existing = (prof.phrases || '').split('\n').filter(Boolean);
  for (const line of text.split('\n').filter(Boolean)) {
    const eq = line.indexOf('='); if (eq < 1) continue;
    const key = line.substring(0, eq);
    const idx = existing.findIndex(l => l.startsWith(key + '='));
    if (idx >= 0) existing[idx] = line; else existing.push(line);
  }
  prof.phrases = existing.join('\n');
  await saveProfiles();
  await state.engine.importDictText(prof.phrases, 999, 'custom-profile');
  renderPhraseList();
  goToChapter(state.currentChap);
  this.value = '';
});
document.getElementById('input-import-global').addEventListener('change', async function() {
  const file = this.files[0]; if (!file) return;
  const text = await file.text();
  const existing = (state.customGlobal || '').split('\n').filter(Boolean);
  for (const line of text.split('\n').filter(Boolean)) {
    const eq = line.indexOf('='); if (eq < 1) continue;
    const key = line.substring(0, eq);
    const idx = existing.findIndex(l => l.startsWith(key + '='));
    if (idx >= 0) existing[idx] = line; else existing.push(line);
  }
  state.customGlobal = existing.join('\n');
  await dbSet('customGlobal', state.customGlobal);
  await state.engine.importDictText(state.customGlobal, 990, 'custom-global');
  renderGlobalPhraseList();
  goToChapter(state.currentChap);
  this.value = '';
});
document.getElementById('btn-clear-global').addEventListener('click', async () => {
  if (!confirm('Xóa toàn bộ Global?')) return;
  state.customGlobal = '';
  await dbSet('customGlobal', '');
  renderGlobalPhraseList();
});

function downloadText(text, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}

// ── Click handler for word spans ──────────────────────────────────────────────
document.getElementById('reader-content').addEventListener('click', e => {
  if (popup && popup.contains(e.target)) return;
  if (e.target.closest('#word-popup')) return;

  const span = e.target.closest('span.cv-word');
  if (!span) { removePopup(); return; }

  e.preventDefault();
  selectedSpans.forEach(s => s.classList.remove('selected'));
  selectedSpans = [span];
  showPopup(e.clientX, e.clientY);
});

document.addEventListener('click', e => {
  if (!popup) return;
  if (e.target.closest('#word-popup')) return;
  if (e.target.closest('span.cv-word')) return;
  removePopup();
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadSavedState();
  applyReaderSettings();
  // Auto-load engine + metadata from repo
  await autoLoadEngineAndMeta();
})();

// ── Service Worker Registration ───────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').catch(e => console.warn('SW:', e));
}