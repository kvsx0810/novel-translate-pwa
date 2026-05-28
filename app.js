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
  // library
  library: [],        // [{bookId, title, chapCount, addedAt}]
  activeBookId: null, // bookId đang đọc
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
async function dbDelete(key) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const req = db.transaction('kv','readwrite').objectStore('kv').delete(key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

// ── Library helpers ───────────────────────────────────────────────────────────
async function saveLibrary() {
  await dbSet('library', state.library);
}

async function loadLibrary() {
  state.library = (await dbGet('library')) || [];
}

// Màu placeholder cover — hash từ title
function bookColor(title) {
  const COLORS = [
    ['#1e3a5f','#89b4fa'], ['#3a1e5f','#cba6f7'], ['#1e5f3a','#a6e3a1'],
    ['#5f3a1e','#fab387'], ['#5f1e3a','#f38ba8'], ['#1e5f5f','#94e2d5'],
    ['#3d3a1e','#f9e2af'], ['#2a2a3e','#b4befe'],
  ];
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) & 0xfffffff;
  const [bg, fg] = COLORS[h % COLORS.length];
  return { bg, fg };
}

function readPercent(bookTitle, chapCount) {
  if (!chapCount) return 0;
  const last = lsGet('lastChap_' + bookTitle, 0);
  return Math.round((last / chapCount) * 100);
}

function renderLibraryGrid() {
  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');
  grid.innerHTML = '';

  if (state.library.length === 0) {
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  for (const book of state.library) {
    const pct = readPercent(book.title, book.chapCount);
    const { bg, fg } = bookColor(book.title);
    const initial = [...book.title].find(c => /[\u4e00-\u9fff\u3400-\u4dbfa-zA-Z]/.test(c)) || '?';

    const hasCover = !!book.coverDataUrl;
    const coverStyle = hasCover
      ? `background-image:url(${book.coverDataUrl}); background-size:cover; background-position:center; color:${fg}`
      : `background:${bg}; color:${fg}`;

    const card = document.createElement('div');
    card.className = 'book-card';
    card.dataset.bookId = book.bookId;
    card.innerHTML = `
      <div class="book-cover" style="${coverStyle}">
        ${hasCover ? '' : `<span class="book-initial">${initial}</span>`}
        ${pct > 0 ? `<div class="book-progress-bar"><div class="book-progress-fill" style="width:${pct}%"></div></div>` : ''}
        <button class="book-delete-btn" data-book-id="${book.bookId}" title="Xóa sách">✕</button>
      </div>
      <div class="book-info">
        <div class="book-title">${book.title}</div>
        <div class="book-meta">${book.chapCount} chương${pct > 0 ? ` · ${pct}%` : ''}</div>
      </div>
    `;

    card.querySelector('.book-cover').addEventListener('click', (e) => {
      if (e.target.closest('.book-delete-btn')) return;
      openBook(book.bookId);
    });
    card.querySelector('.book-info').addEventListener('click', () => openBook(book.bookId));
    card.querySelector('.book-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteBook(book.bookId, book.title);
    });

    grid.appendChild(card);
  }
}

async function addBook(file) {
  document.getElementById('library-error').textContent = '';
  const loadingCard = document.createElement('div');
  loadingCard.className = 'book-card book-card-loading';
  loadingCard.innerHTML = `<div class="book-cover book-cover-loading"><div class="spinner"></div></div><div class="book-info"><div class="book-title">Đang xử lý...</div></div>`;
  const grid = document.getElementById('library-grid');
  document.getElementById('library-empty').style.display = 'none';
  grid.prepend(loadingCard);

  try {
    const result = await parseEpub(file);
    const buf = await file.arrayBuffer();
    const bookId = Date.now().toString();

    await dbSet(`epub:${bookId}`, { name: file.name, data: buf });

    const entry = {
      bookId,
      title: result.title,
      chapCount: result.chapters.length,
      addedAt: Date.now(),
      coverDataUrl: result.coverDataUrl || null,
    };
    state.library.unshift(entry); // newest first
    await saveLibrary();
    renderLibraryGrid();
  } catch(e) {
    document.getElementById('library-error').textContent = '✗ ' + e.message;
    loadingCard.remove();
    if (state.library.length === 0) document.getElementById('library-empty').style.display = 'flex';
  }
}

async function deleteBook(bookId, title) {
  if (!confirm(`Xóa "${title}"?`)) return;
  await dbDelete(`epub:${bookId}`);
  state.library = state.library.filter(b => b.bookId !== bookId);
  await saveLibrary();
  renderLibraryGrid();
}

async function openBook(bookId) {
  const entry = state.library.find(b => b.bookId === bookId);
  if (!entry) return;

  // Show setup screen with loading state
  showScreen('setup');
  document.getElementById('epub-status').textContent = 'Đang mở sách...';
  document.getElementById('epub-badge').textContent = '⏳';
  document.getElementById('step-epub').classList.remove('done','error');

  try {
    const cached = await dbGet(`epub:${bookId}`);
    if (!cached) throw new Error('Không tìm thấy file EPUB trong bộ nhớ');
    const file = new File([cached.data], cached.name, { type: 'application/epub+zip' });
    const result = await parseEpub(file);
    state.epub = result;
    state.chapters = result.chapters;
    state.activeBookId = bookId;
    setStepDone('epub', `✓ ${result.title} — ${result.chapters.length} chương`);
    setupReady.epub = true;
  } catch(e) {
    setStepError('epub', '✗ ' + e.message);
    setupReady.epub = false;
  }
  checkSetupReady();
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.style.display = '';
  });
  const el = document.getElementById('screen-' + name);
  el.classList.add('active');
  if (name === 'reader') el.style.display = 'flex';
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

  // Extract cover image
  const coverDataUrl = await extractCover(zip, opfDir, opfXml, manifestItems);

  return { title: bookTitle, chapters, coverDataUrl };
}

// Tìm cover image trong EPUB, resize xuống ~200px width, trả về data URL (hoặc null)
async function extractCover(zip, opfDir, opfXml, manifestItems) {
  try {
    // Cách 1: <meta name="cover" content="id"/>
    let coverId = opfXml.match(/<meta\s+name="cover"\s+content="([^"]+)"/i)?.[1];
    // Cách 2: <item properties="cover-image"/>
    if (!coverId) {
      const m = opfXml.match(/<item\s[^>]*properties="cover-image"[^>]*id="([^"]+)"/);
      coverId = m?.[1];
    }
    // Cách 3: id hoặc href chứa "cover"
    if (!coverId) {
      coverId = Object.keys(manifestItems).find(id =>
        id.toLowerCase().includes('cover') && manifestItems[id].type.startsWith('image/')
      );
    }

    if (!coverId || !manifestItems[coverId]) return null;
    const item = manifestItems[coverId];
    if (!item.type.startsWith('image/')) return null;

    const href = opfDir + item.href;
    const imgFile = zip.file(href) || zip.file(decodeURIComponent(href));
    if (!imgFile) return null;

    const blob = new Blob([await imgFile.async('arraybuffer')], { type: item.type });
    return await resizeImage(blob, 200);
  } catch(e) {
    return null;
  }
}

// Resize ảnh xuống maxWidth bằng Canvas, trả về data URL
function resizeImage(blob, maxWidth) {
  return new Promise((res) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const ratio = Math.min(1, maxWidth / img.width);
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      res(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); res(null); };
    img.src = url;
  });
}

// ── Engine Init ───────────────────────────────────────────────────────────────
async function initEngine() {
  const engine = window.DictEngine;
  if (!engine) throw new Error('DictEngine không tìm thấy');
  state.engine = engine;

  // Trie is already built by autoLoadEngineAndMeta (rebuildFromDB ran there).
  // Just layer on user customizations — never re-import base dicts here.
  if (state.customGlobal) await engine.importDictText(state.customGlobal, 990, 'custom-global');
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

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${bodyHTML}</div>`, 'text/html');
  const sourceDiv = doc.body.firstChild;

  // Walk DOM, collect leaf text blocks preserving original line breaks
  const blocks = collectBlocks(sourceDiv);

  for (const block of blocks) {
    const text = block.trim();
    if (!text) continue;
    const p = document.createElement('p');
    if (CJK_RE.test(text)) {
      translateAndInsert(text, p);
    } else {
      p.textContent = text;
    }
    container.appendChild(p);
  }
}

// Collect text blocks by walking DOM, treating each block-level element as one paragraph.
// If a block contains only inline content (no child blocks), its full text = one paragraph.
// This preserves the original p-by-p layout from the EPUB.
function collectBlocks(root) {
  const BLOCK_TAGS = new Set(['p','div','h1','h2','h3','h4','h5','h6','li','td','th','blockquote','section','article']);
  const SKIP_TAGS  = new Set(['script','style','nav','head']);
  const result = [];

  function isBlock(node) {
    return node.nodeType === 1 && BLOCK_TAGS.has(node.tagName.toLowerCase());
  }
  function hasBlockChild(node) {
    return [...node.childNodes].some(c => isBlock(c));
  }

  function walk(node) {
    if (node.nodeType === 3) {
      // Bare text node at root level
      const t = node.textContent.trim();
      if (t) result.push(t);
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'br') { result.push(''); return; }

    if (isBlock(node)) {
      if (hasBlockChild(node)) {
        // Container block — recurse into children
        for (const c of node.childNodes) walk(c);
      } else {
        // Leaf block — treat entire text as one paragraph
        const t = node.textContent.trim();
        if (t) result.push(t);
      }
    } else {
      // Inline element — recurse
      for (const c of node.childNodes) walk(c);
    }
  }

  for (const c of root.childNodes) walk(c);

  // Remove duplicate consecutive empty strings (multiple <br>) → keep max 1
  return result.filter((v, i, a) => {
    if (v !== '') return true;
    return a[i - 1] !== '';
  });
}

// CJK punctuation → Latin equivalents
const PUNCT_MAP = {
  '。': '.', '，': ',', '、': ',', '；': ';', '：': ':',
  '？': '?', '！': '!', '「': '“', '」': '”', '『': '“', '』': '”',
  '【': '[', '】': ']', '《': '«', '》': '»', '〈': '<', '〉': '>',
  '—': '—', '…': '...', '　': ' ',
};

// Chars that cling to the LEFT (no space before them)
const CLING_LEFT  = new Set(['.', ',', ';', ':', '?', '!', ')', ']', '”', '»', '...']);
// Chars that cling to the RIGHT (no space after them)
const CLING_RIGHT = new Set(['(', '[', '“', '«']);

function normPunct(str) {
  return str.replace(/[。，、；：？！「」『』【】《》〈〉—…　]/g, c => PUNCT_MAP[c] || c);
}

function translateAndInsert(text, container) {
  const engine = state.engine;
  const items = engine.segmentDisplay(text);
  if (!items || !items.length) { container.textContent = normPunct(text); return; }

  // Build flat token list
  const tokens = []; // {type: 'word'|'punct'|'num'|'filler', text, zw?, hv?, vi?}
  for (const item of items) {
    if (item.type === 'filler') {
      const norm = normPunct(item.text);
      // Split filler into: punct | num-runs (digits + ASCII letters/symbols that need spacing) | filler
      // Using regex to chunk: runs of digits/ASCII-alnum vs whitespace vs punct vs rest
      const chunks = norm.match(/\d[\d.,]*|[A-Za-z]+|[^\S\n]+|./gsu) || [];
      for (const chunk of chunks) {
        if (CLING_LEFT.has(chunk) || CLING_RIGHT.has(chunk)) {
          tokens.push({ type: 'punct', text: chunk });
        } else if (/^\d[\d.,]*$/.test(chunk) || /^[A-Za-z]+$/.test(chunk)) {
          // Numbers and Latin words need space on both sides — treat like a word token
          tokens.push({ type: 'num', text: chunk });
        } else {
          // Whitespace or other chars — merge into previous filler or create new
          if (tokens.length && tokens[tokens.length-1].type === 'filler') {
            tokens[tokens.length-1].text += chunk;
          } else {
            tokens.push({ type: 'filler', text: chunk });
          }
        }
      }
    } else {
      const display = PARTICLES.has(item.zh) ? '' : (item.vi || item.hv);
      tokens.push({ type: 'word', text: display, zw: item.zh, hv: item.hv, vi: item.vi || item.hv });
    }
  }

  // Capitalize first visible word
  const firstWord = tokens.find(t => t.type === 'word' && t.text);
  if (firstWord) firstWord.text = firstWord.text.charAt(0).toUpperCase() + firstWord.text.slice(1);

  // Capitalize first word after open-quote “
  for (let _qi = 0; _qi < tokens.length; _qi++) {
    if (tokens[_qi].type === 'punct' && tokens[_qi].text === '“') {
      for (let _wi = _qi + 1; _wi < tokens.length; _wi++) {
        if (tokens[_wi].type === 'word' && tokens[_wi].text) {
          tokens[_wi].text = tokens[_wi].text.charAt(0).toUpperCase() + tokens[_wi].text.slice(1);
          break;
        }
      }
    }
  }

  // Render with correct spacing
  const frag = document.createDocumentFragment();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = tokens[i - 1];

    // Decide space before this token
    if (prev) {
      // Filler suppresses space only if it ends with a spacing/open-punct char
      const fillerEndsWithSpacing = prev.type === 'filler' &&
        /[\s“«([\[]$/.test(prev.text);
      const noSpaceBefore =
        (tok.type === 'punct' && CLING_LEFT.has(tok.text)) ||
        (prev.type === 'punct' && CLING_RIGHT.has(prev.text)) ||
        fillerEndsWithSpacing;
      const fillerNeedsSpaceBefore = tok.type === 'filler' && /^[^\s\u201d\u00bb)\]]/.test(tok.text);
      // 'num' always needs space before (same as 'word')
      if (!noSpaceBefore && (tok.type === 'word' || tok.type === 'num' || fillerNeedsSpaceBefore)) {
        frag.appendChild(document.createTextNode(' '));
      }
    }

    if (tok.type === 'word') {
      const span = document.createElement('span');
      span.className = 'cv-word';
      span.dataset.zw = tok.zw;
      span.dataset.hv = tok.hv;
      span.dataset.vi = tok.vi;
      span.textContent = tok.text;
      frag.appendChild(span);
    } else {
      frag.appendChild(document.createTextNode(tok.text));
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

  // Translate chapter title if CJK
  let displayTitle = chap.title;
  if (state.engineReady && CJK_RE.test(chap.title)) {
    const titleP = document.createElement('span');
    translateAndInsert(chap.title, titleP);
    displayTitle = titleP.textContent;
  }

  document.getElementById('chapter-title').textContent = displayTitle;
  document.getElementById('hdr-book-title').textContent = displayTitle;
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
    const zw = s.dataset.zw || '';
    // Build Han Viet from phienAmMap char by char (like extension)
    return [...zw].map(ch => {
      const hv = state.phienAmMap.get(ch) || s.dataset.hv || ch;
      return hv.charAt(0).toUpperCase() + hv.slice(1);
    }).join(' ');
  }).join(' ');
}

let popupX = 0, popupY = 0;

function renderPopup() {
  if (popup) { popup.remove(); popup = null; }
  selectedSpans.forEach(s => s.classList.add('selected'));

  const zw = selectedSpans.map(s => s.dataset.zw).join('');
  const vi = selectedSpans.map(s => s.textContent).join(' ');
  const hv = getHanVietForSpans(selectedSpans);

  const vw = window.innerWidth, vh = window.innerHeight;
  const pw = Math.min(340, vw * 0.9);
  let left = Math.min(popupX, vw - pw - 8);
  if (left < 8) left = 8;
  let top = popupY + 12;
  if (top + 200 > vh - 8) top = popupY - 200 - 8;

  const el = document.createElement('div');
  el.id = 'word-popup';
  el.className = 'word-popup';
  el.style.cssText = `display:flex;left:${left}px;top:${top}px;`;
  el.innerHTML = `
    <div class="popup-hv-row">
      <span class="popup-label">HV</span>
      <span id="popup-hv">${hv}</span>
      <button id="popup-copy" class="popup-copy-btn">Copy</button>
    </div>
    <div class="popup-vi-row">
      <span class="popup-label">Tr</span>
      <span class="popup-vi-text">${vi}</span>
    </div>
    <div class="popup-expand-row">
      <button id="popup-exp-left" class="popup-expand-btn">◀ Mở rộng</button>
      <button id="popup-exp-right" class="popup-expand-btn">Mở rộng ▶</button>
    </div>
    <div class="popup-input-row">
      <input id="popup-input" type="text" class="popup-input" placeholder="Nhập tên..." value="${hv}">
      <button id="popup-add-profile" class="popup-btn-profile">+ Profile</button>
      <button id="popup-add-global" class="popup-btn-global">+ Global</button>
    </div>
    <div id="popup-status" class="popup-status"></div>
  `;

  document.body.appendChild(el);
  popup = el;

  el.addEventListener('mousedown', e => e.stopPropagation());
  el.addEventListener('click',     e => e.stopPropagation());

  el.querySelector('#popup-copy').addEventListener('click', e => {
    e.stopPropagation();
    navigator.clipboard.writeText(zw).then(() => {
      el.querySelector('#popup-status').textContent = '✓ Đã copy: ' + zw;
    });
  });

  el.querySelector('#popup-exp-left').addEventListener('click', e => {
    e.stopPropagation();
    const all = getAllSpans();
    const idx = all.indexOf(selectedSpans[0]);
    if (idx > 0) { selectedSpans.unshift(all[idx - 1]); renderPopup(); }
  });

  el.querySelector('#popup-exp-right').addEventListener('click', e => {
    e.stopPropagation();
    const all = getAllSpans();
    const idx = all.indexOf(selectedSpans[selectedSpans.length - 1]);
    if (idx < all.length - 1) { selectedSpans.push(all[idx + 1]); renderPopup(); }
  });

  el.querySelector('#popup-add-profile').addEventListener('click', async e => {
    e.stopPropagation();
    const viText = el.querySelector('#popup-input').value.trim();
    if (!viText) return;
    const zwText = selectedSpans.map(s => s.dataset.zw).join('');
    await addToProfile(zwText, viText);
    el.querySelector('#popup-status').textContent = `✓ Đã thêm "${zwText}=${viText}"`;
    setTimeout(removePopup, 1500);
  });

  el.querySelector('#popup-add-global').addEventListener('click', async e => {
    e.stopPropagation();
    const viText = el.querySelector('#popup-input').value.trim();
    if (!viText) return;
    const zwText = selectedSpans.map(s => s.dataset.zw).join('');
    await addToGlobal(zwText, viText);
    el.querySelector('#popup-status').textContent = `✓ Global: "${zwText}=${viText}"`;
    setTimeout(removePopup, 1500);
  });
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
  // Cleanup: xóa các key IDB cũ không còn dùng
  try {
    const db = await dbOpen();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete('metadata');       // cũ: 65MB JSON
    tx.objectStore('kv').delete('metadata-flag');  // cũ: flag từ approach trước
  } catch(e) { /* ignore */ }
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

// Auto-load engine + metadata
// Architecture:
//   - 65MB JSON fetched via Worker; Service Worker caches the R2 response on disk (Cache-first)
//   - Parsed TSV imported into dict-engine's OWN IDB (cnvn-dict) ONCE on first run
//   - On reload: cnvn-dict already has entries → rebuildFromDB() (pure RAM, no network, no write)
//   - phienAmMap saved to localStorage as tiny array (< 500KB), restored instantly on reload
const METADATA_URL = 'https://pub-9771e4ccafeb496c99991ae2aa19d12e.r2.dev/metadata.json';

async function autoLoadEngineAndMeta() {
  try {
    document.getElementById('engine-status').textContent = 'Đang tải engine...';

    // 1. Load dict-engine.js (SW cache-first)
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = './core/dict-engine.js';
      s.onload = res;
      s.onerror = () => rej(new Error('Không tải được core/dict-engine.js'));
      document.head.appendChild(s);
    });
    if (!window.DictEngine) throw new Error('DictEngine không tìm thấy sau khi load');
    const engine = window.DictEngine;

    // 2. Check if base dicts already live in engine's cnvn-dict IDB
    const existingSources = await engine.getImportedSources().catch(() => []);
    if (existingSources.length > 0) {
      // Reload path: rebuild Trie from cnvn-dict — pure in-memory, no network, no IDB write
      document.getElementById('engine-status').textContent = 'Đang khôi phục từ điển...';
      await engine.rebuildFromDB();

      if (engine.entryCount > 0) {
        // Restore phienAmMap from localStorage (tiny, instant)
        const stored = lsGet('phienAmMap', null);
        if (stored) state.phienAmMap = new Map(stored);
        setStepDone('engine', `✓ Engine + ${existingSources.length} từ điển (cache)`);
        setupReady.engine = true;
        checkSetupReady();
        updateLibraryEngineStatus('✓ Engine sẵn sàng');
        return;
      }
      // entryCount == 0: cnvn-dict was wiped independently — fall through to re-import
      console.warn('cnvn-dict trống, fetch lại...');
    }

    // 3. First run (or after IDB wipe): fetch 65MB via Worker
    //    Service Worker caches R2 response so subsequent fetches are from disk
    const isCached = await caches.match(METADATA_URL).then(r => !!r).catch(() => false);
    document.getElementById('engine-status').textContent = isCached
      ? 'Đang parse từ điển (SW cache)...'
      : 'Đang tải từ điển (lần đầu ~65MB)...';

    const json = await new Promise((res, rej) => {
      const worker = new Worker('./metadata-worker.js');
      worker.postMessage({ url: METADATA_URL });
      worker.onmessage = e => {
        const { type, text, data, message } = e.data;
        if (type === 'progress') document.getElementById('engine-status').textContent = text;
        else if (type === 'done') { worker.terminate(); res(data); }
        else if (type === 'error') { worker.terminate(); rej(new Error(message)); }
      };
      worker.onerror = e => { worker.terminate(); rej(new Error(e.message)); };
    });

    // 4. Import into engine's cnvn-dict IDB — happens ONCE per install, never on reload
    document.getElementById('engine-status').textContent = 'Đang import từ điển...';
    const dicts = json.data.importedDicts;
    const phienAmEntries = [];

    for (let i = 0; i < dicts.length; i++) {
      const dict = dicts[i];
      document.getElementById('engine-status').textContent =
        `Đang import... (${i + 1}/${dicts.length})`;
      if (dict.name === 'ChinesePhienAmWords.txt') {
        for (const line of dict.tsv.split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 2 && parts[0].length === 1) {
            state.phienAmMap.set(parts[0], parts[1]);
            phienAmEntries.push([parts[0], parts[1]]);
          }
        }
      }
      const priority = parseInt(dict.tsv.split('\t')[2]) || 10;
      const kv = dict.tsv.split('\n')
        .map(l => { const p = l.split('\t'); return p.length >= 2 ? `${p[0]}=${p[1]}` : ''; })
        .filter(Boolean).join('\n');
      await engine.importDictText(kv, priority, dict.name);
    }

    // 5. Persist phienAmMap to localStorage (tiny array, < 500KB)
    lsSet('phienAmMap', phienAmEntries);

    setStepDone('engine', `✓ Engine + ${dicts.length} từ điển`);
    setupReady.engine = true;
    updateLibraryEngineStatus('✓ Engine sẵn sàng');
  } catch(e) {
    setStepError('engine', '✗ ' + e.message);
    updateLibraryEngineStatus('✗ Lỗi engine');
  }
  checkSetupReady();
}
function updateLibraryEngineStatus(msg) {
  const el = document.getElementById('library-engine-status');
  if (el) el.textContent = msg;
}

// Load EPUB + save to IDB for restore on reload
document.getElementById('input-epub').addEventListener('change', async function() {
  const file = this.files[0]; if (!file) return;
  try {
    document.getElementById('epub-status').textContent = 'Đang phân tích EPUB...';
    const result = await parseEpub(file);
    // Save file bytes to IDB so we can restore without re-upload
    const buf = await file.arrayBuffer();
    await dbSet('epub-file', { name: file.name, data: buf });
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
    showScreen('reader');
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
  showScreen('library');
  renderLibraryGrid(); // refresh % đọc
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
document.addEventListener('mousedown', e => {
  // If click inside popup — do nothing
  if (popup && popup.contains(e.target)) return;
  // If popup open but clicked outside — close it
  if (popup) { removePopup(); return; }

  const span = e.target.closest('span.cv-word');
  if (!span) return;

  e.preventDefault();
  e.stopPropagation();
  popupX = e.clientX;
  popupY = e.clientY;
  selectedSpans = [span];
  renderPopup();
}, { capture: true });

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadSavedState();
  await loadLibrary();
  applyReaderSettings();

  // Render library immediately (before engine loads)
  renderLibraryGrid();

  // Engine loads in background — library is interactive immediately
  autoLoadEngineAndMeta(); // no await — parallel

  // Migrate legacy single-epub storage nếu có
  tryRestoreEpub();
})();

async function tryRestoreEpub() {
  // Legacy: migrate old single epub-file key into library
  try {
    const cached = await dbGet('epub-file');
    if (!cached) return;
    // Check if already migrated
    const alreadyIn = state.library.some(b => b.title === cached.name?.replace('.epub',''));
    if (alreadyIn) { await dbDelete('epub-file'); return; }

    // Migrate: parse + add to library
    const file = new File([cached.data], cached.name, { type: 'application/epub+zip' });
    const result = await parseEpub(file);
    const bookId = Date.now().toString();
    await dbSet(`epub:${bookId}`, { name: cached.name, data: cached.data });
    state.library.push({ bookId, title: result.title, chapCount: result.chapters.length, addedAt: Date.now(), coverDataUrl: result.coverDataUrl || null });
    await saveLibrary();
    await dbDelete('epub-file');
    renderLibraryGrid();
  } catch(e) {
    console.warn('Migrate epub-file:', e);
  }
}

// ── Library Event Listeners ───────────────────────────────────────────────────
document.getElementById('btn-add-book').addEventListener('click', () => {
  document.getElementById('input-add-epub').click();
});
document.getElementById('input-add-epub').addEventListener('change', async function() {
  const file = this.files[0]; if (!file) return;
  await addBook(file);
  this.value = '';
});

// ── Service Worker Registration ───────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').catch(e => console.warn('SW:', e));
}