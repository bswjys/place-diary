'use strict';

/* =========================================================
   오늘의 발자국 — 포토·장소 달력 다이어리
   모든 기록과 사진은 이 기기의 IndexedDB에만 저장됩니다.
   ========================================================= */

const $ = (s, r = document) => r.querySelector(s);
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const MAX_PHOTOS = 4;
const FULL_MAX = 1200;
const FULL_QUALITY = 0.82;
const THUMB_SIZE = 160;
const THUMB_QUALITY = 0.78;
const DEFAULT_PLACES = ['교회', '카페', '장신대', '마트', '산책'];

const pad = (n) => String(n).padStart(2, '0');
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

function highlight(text, q) {
  const t = String(text == null ? '' : text);
  if (!q) return esc(t);
  const lower = t.toLowerCase();
  const ql = q.toLowerCase();
  let out = '';
  let from = 0;
  let i;
  while ((i = lower.indexOf(ql, from)) !== -1) {
    out += esc(t.slice(from, i)) + '<mark>' + esc(t.slice(i, i + ql.length)) + '</mark>';
    from = i + ql.length;
  }
  out += esc(t.slice(from));
  return out;
}

function uid() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const dateKey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return { y, m: m - 1, d };
}
function dowOf(k) {
  const { y, m, d } = parseKey(k);
  return new Date(y, m, d).getDay();
}
function labelOf(k) {
  const { y, m, d } = parseKey(k);
  return `${m + 1}월 ${d}일 (${WEEKDAY[dowOf(k)]})`;
}
function todayKey() {
  const now = new Date();
  return dateKey(now.getFullYear(), now.getMonth(), now.getDate());
}

/* ---------------------------------------------------------
   IndexedDB
   --------------------------------------------------------- */
const DB_NAME = 'place-diary';
const DB_VER = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('photos')) {
        const s = db.createObjectStore('photos', { keyPath: 'id' });
        s.createIndex('date', 'date');
        s.createIndex('entryId', 'entryId');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
    rq.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  return dbPromise;
}

const reqP = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});
const txDone = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new Error('aborted'));
});

async function getAll(storeName) {
  const db = await openDB();
  return reqP(db.transaction(storeName).objectStore(storeName).getAll());
}

async function entriesInRange(start, end) {
  const db = await openDB();
  const st = db.transaction('entries').objectStore('entries');
  return reqP(st.index('date').getAll(IDBKeyRange.bound(start, end)));
}

async function photosInRange(start, end) {
  const db = await openDB();
  const st = db.transaction('photos').objectStore('photos');
  return reqP(st.index('date').getAll(IDBKeyRange.bound(start, end)));
}

const entriesForDate = (date) => entriesInRange(date, date);
const photosForDate = (date) => photosInRange(date, date);
const entriesForMonth = (prefix) => entriesInRange(prefix + '-01', prefix + '-31');
const photosForMonth = (prefix) => photosInRange(prefix + '-01', prefix + '-31');

async function putEntries(list) {
  if (!list.length) return;
  const db = await openDB();
  const tx = db.transaction('entries', 'readwrite');
  const st = tx.objectStore('entries');
  for (const e of list) st.put(e);
  await txDone(tx);
}

async function putPhotos(list) {
  if (!list.length) return;
  const db = await openDB();
  const tx = db.transaction('photos', 'readwrite');
  const st = tx.objectStore('photos');
  for (const p of list) st.put(p);
  await txDone(tx);
}

async function deletePhotosByEntry(entryId) {
  const db = await openDB();
  const st = db.transaction('photos').objectStore('photos');
  const keys = await reqP(st.index('entryId').getAllKeys(entryId));
  if (!keys.length) return;
  const tx = db.transaction('photos', 'readwrite');
  const s2 = tx.objectStore('photos');
  for (const k of keys) s2.delete(k);
  await txDone(tx);
}

async function deleteEntryCascade(entryId) {
  await deletePhotosByEntry(entryId);
  const db = await openDB();
  const tx = db.transaction('entries', 'readwrite');
  tx.objectStore('entries').delete(entryId);
  await txDone(tx);
}

async function getSetting(key, fallback = null) {
  const db = await openDB();
  const row = await reqP(db.transaction('settings').objectStore('settings').get(key));
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  const db = await openDB();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put({ key, value });
  await txDone(tx);
}

/* ---------------------------------------------------------
   사진 압축 (Canvas)
   --------------------------------------------------------- */
function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (canvas.toBlob) {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality);
    } else {
      try {
        const data = canvas.toDataURL(type, quality);
        resolve(dataURLToBlobSync(data));
      } catch (err) { reject(err); }
    }
  });
}

function dataURLToBlobSync(dataURL) {
  const [head, body] = dataURL.split(',');
  const mime = (head.match(/:(.*?);/) || [, 'image/jpeg'])[1];
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function loadImageEl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
    img.src = url;
  });
}

async function compressImage(file) {
  const { img, url } = await loadImageEl(file);
  try {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) throw new Error('empty image');

    // 큰 사진: 긴 변 1200px, JPEG 0.82
    const scale = Math.min(1, FULL_MAX / Math.max(iw, ih));
    const fw = Math.max(1, Math.round(iw * scale));
    const fh = Math.max(1, Math.round(ih * scale));
    const cv = document.createElement('canvas');
    cv.width = fw;
    cv.height = fh;
    const cx = cv.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, fw, fh);
    cx.drawImage(img, 0, 0, fw, fh);
    const full = await canvasToBlob(cv, 'image/jpeg', FULL_QUALITY);

    // 달력용 정사각 썸네일 160px (인물이 잘리지 않게 위쪽 30% 기준 크롭)
    const side = Math.min(iw, ih);
    const sx = Math.max(0, (iw - side) / 2);
    const sy = Math.max(0, (ih - side) * 0.3);
    const tv = document.createElement('canvas');
    tv.width = THUMB_SIZE;
    tv.height = THUMB_SIZE;
    const tx = tv.getContext('2d');
    tx.imageSmoothingEnabled = true;
    tx.imageSmoothingQuality = 'high';
    tx.fillStyle = '#ffffff';
    tx.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    tx.drawImage(img, sx, sy, side, side, 0, 0, THUMB_SIZE, THUMB_SIZE);
    const thumb = await canvasToBlob(tv, 'image/jpeg', THUMB_QUALITY);

    return { full, thumb, w: fw, h: fh };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------------------------------------------------------
   공용 UI 상태
   --------------------------------------------------------- */
const el = {
  calTitle: $('#calTitle'),
  dayGrid: $('#dayGrid'),
  prevMonth: $('#prevMonth'),
  nextMonth: $('#nextMonth'),
  todayBtn: $('#todayBtn'),
  searchBtn: $('#searchBtn'),
  backupBtn: $('#backupBtn'),

  dayCard: $('#dayCard'),
  dayTitle: $('#dayTitle'),
  dayPill: $('#dayPill'),
  daySub: $('#daySub'),
  quickHome: $('#quickHome'),
  quickOuting: $('#quickOuting'),
  dayEmpty: $('#dayEmpty'),
  dayEmptyTitle: $('#dayEmptyTitle'),
  dayEmptySub: $('#dayEmptySub'),
  addMoreBtn: $('#addMoreBtn'),
  entryForm: $('#entryForm'),
  formTitle: $('#formTitle'),
  placeField: $('#placeField'),
  placeInput: $('#placeInput'),
  placeOptions: $('#placeOptions'),
  placeChips: $('#placeChips'),
  chipEditBtn: $('#chipEditBtn'),
  chipEditor: $('#chipEditor'),
  chipNewInput: $('#chipNewInput'),
  chipAddBtn: $('#chipAddBtn'),
  photoField: $('#photoField'),
  photoRow: $('#photoRow'),
  cameraBtn: $('#cameraBtn'),
  albumBtn: $('#albumBtn'),
  cameraInput: $('#cameraInput'),
  albumInput: $('#albumInput'),
  noteInput: $('#noteInput'),
  formCancel: $('#formCancel'),
  formSave: $('#formSave'),
  recList: $('#recList'),

  backupBackdrop: $('#backupBackdrop'),
  backupClose: $('#backupClose'),
  exportBtn: $('#exportBtn'),
  importBtn: $('#importBtn'),
  importInput: $('#importInput'),
  exportLink: $('#exportLink'),
  storageTitle: $('#storageTitle'),
  storageInfo: $('#storageInfo'),

  searchOverlay: $('#searchOverlay'),
  searchInput: $('#searchInput'),
  searchClose: $('#searchClose'),
  searchHint: $('#searchHint'),
  searchResults: $('#searchResults'),

  lightbox: $('#lightbox'),
  lbImg: $('#lbImg'),
  lbClose: $('#lbClose'),
  lbPrev: $('#lbPrev'),
  lbNext: $('#lbNext'),
  lbCount: $('#lbCount'),

  dialogBackdrop: $('#dialogBackdrop'),
  dialogText: $('#dialogText'),
  dialogOk: $('#dialogOk'),
  dialogCancel: $('#dialogCancel'),

  toast: $('#toast'),
};

const OVERLAY_IDS = ['backupBackdrop', 'searchOverlay', 'lightbox', 'dialogBackdrop'];
function syncBodyLock() {
  const anyOpen = OVERLAY_IDS.some((id) => {
    const node = document.getElementById(id);
    return node && !node.hidden;
  });
  document.body.classList.toggle('locked', anyOpen);
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  el.toast.style.animation = 'none';
  void el.toast.offsetWidth;
  el.toast.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2000);
}

function askConfirm(text, okLabel = '삭제') {
  return new Promise((resolve) => {
    el.dialogText.textContent = text;
    el.dialogOk.textContent = okLabel;
    el.dialogBackdrop.hidden = false;
    syncBodyLock();
    const done = (value) => {
      el.dialogBackdrop.hidden = true;
      syncBodyLock();
      el.dialogOk.removeEventListener('click', onOk);
      el.dialogCancel.removeEventListener('click', onCancel);
      el.dialogBackdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (ev) => { if (ev.target === el.dialogBackdrop) done(false); };
    const onKey = (ev) => { if (ev.key === 'Escape') done(false); };
    el.dialogOk.addEventListener('click', onOk);
    el.dialogCancel.addEventListener('click', onCancel);
    el.dialogBackdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

/* ---------------------------------------------------------
   달력
   --------------------------------------------------------- */
const view = { y: 0, m: 0 };
let monthEntries = [];
let monthPhotos = [];
const thumbCache = new Map();
const fullCache = new Map();
let entriesCache = null;

function thumbUrl(photo) {
  if (!photo) return '';
  if (thumbCache.has(photo.id)) return thumbCache.get(photo.id);
  const url = URL.createObjectURL(photo.thumb);
  thumbCache.set(photo.id, url);
  return url;
}
function fullUrl(photo) {
  if (!photo) return '';
  if (fullCache.has(photo.id)) return fullCache.get(photo.id);
  const url = URL.createObjectURL(photo.full);
  fullCache.set(photo.id, url);
  return url;
}
function dropPhotoUrl(photoId) {
  if (thumbCache.has(photoId)) { URL.revokeObjectURL(thumbCache.get(photoId)); thumbCache.delete(photoId); }
  if (fullCache.has(photoId)) { URL.revokeObjectURL(fullCache.get(photoId)); fullCache.delete(photoId); }
}

function renderCalHead() {
  el.calTitle.textContent = `${view.y}년 ${view.m + 1}월`;
}

async function loadMonth() {
  const prefix = `${view.y}-${pad(view.m + 1)}`;
  const [es, ps] = await Promise.all([entriesForMonth(prefix), photosForMonth(prefix)]);
  if (prefix !== `${view.y}-${pad(view.m + 1)}`) return; // 이동한 경우 무시
  monthEntries = es;
  monthPhotos = ps;
  renderGrid();
}

function dayMetrics(key) {
  const entries = monthEntries.filter((e) => e.date === key);
  const photos = monthPhotos.filter((p) => p.date === key);
  const outings = entries.filter((e) => e.kind === 'outing');
  let photo = null;
  // 가장 최근 외출 기록의 첫 사진을 대표 사진으로
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind !== 'outing') continue;
    const found = photos.find((p) => p.entryId === e.id);
    if (found) { photo = found; break; }
  }
  return { entries, outings, photo, extra: Math.max(0, entries.length - 1) };
}

function renderGrid() {
  const today = todayKey();
  const first = new Date(view.y, view.m, 1).getDay();
  const lastDay = new Date(view.y, view.m + 1, 0).getDate();
  const frag = document.createDocumentFragment();

  for (let i = 0; i < first; i++) {
    const blank = document.createElement('div');
    blank.className = 'day blank';
    blank.setAttribute('aria-hidden', 'true');
    frag.appendChild(blank);
  }

  for (let d = 1; d <= lastDay; d++) {
    const key = dateKey(view.y, view.m, d);
    const dow = dowOf(key);
    const { entries, outings, photo, extra } = dayMetrics(key);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day';
    btn.dataset.date = key;
    if (dow === 0) btn.classList.add('sun');
    if (dow === 6) btn.classList.add('sat');
    if (key === today) btn.classList.add('today');
    if (key === day.date) btn.classList.add('selected');
    if (photo) btn.classList.add('has-photo');
    btn.setAttribute('aria-pressed', key === day.date ? 'true' : 'false');

    const marks = [];
    if (photo) marks.push('사진');
    else if (outings.length) marks.push('외출');
    else if (entries.length) marks.push('집');
    btn.setAttribute('aria-label', `${view.m + 1}월 ${d}일${marks.length ? ', ' + marks.join(', ') + ' 기록' : ''}`);

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(d);
    btn.appendChild(num);

    if (photo) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = thumbUrl(photo);
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      btn.appendChild(img);
    } else if (outings.length) {
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = '📍';
      btn.appendChild(mark);
    } else if (entries.length) {
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = '🏠';
      btn.appendChild(mark);
    }

    if (extra > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '+' + extra;
      btn.appendChild(badge);
    }

    btn.addEventListener('click', () => selectDate(key));
    frag.appendChild(btn);
  }

  el.dayGrid.replaceChildren(frag);
}

el.prevMonth.addEventListener('click', () => {
  view.m -= 1;
  if (view.m < 0) { view.m = 11; view.y -= 1; }
  renderCalHead();
  loadMonth();
});
el.nextMonth.addEventListener('click', () => {
  view.m += 1;
  if (view.m > 11) { view.m = 0; view.y += 1; }
  renderCalHead();
  loadMonth();
});
el.todayBtn.addEventListener('click', async () => {
  const now = new Date();
  view.y = now.getFullYear();
  view.m = now.getMonth();
  renderCalHead();
  await loadMonth();
  await selectDate(todayKey(), { scroll: true });
});

/* ---------------------------------------------------------
   달력 아래: 선택한 날의 발자국 카드
   --------------------------------------------------------- */
const day = {
  date: todayKey(),
  entries: [],
  photos: [],
  formMode: null,     // 'home' | 'outing' | null
  editingId: null,
  pending: [],        // 새로 추가한 사진 {full, thumb, url}
  kept: [],           // 수정 시 유지할 기존 사진
  removeIds: [],      // 수정 시 지울 사진 id
  chips: [],
  chipPrefs: { hidden: [], custom: [] },
  chipEditing: false,
  busy: false,
  dismissedCompose: false,
  seq: 0,
};

function invalidateEntries() { entriesCache = null; }

async function getAllEntriesCached() {
  if (!entriesCache) entriesCache = await getAll('entries');
  return entriesCache;
}

const monthPrefix = () => `${view.y}-${pad(view.m + 1)}`;

function shiftKey(key, days) {
  const { y, m, d } = parseKey(key);
  const t = new Date(y, m, d + days);
  return dateKey(t.getFullYear(), t.getMonth(), t.getDate());
}

function relLabel(key) {
  const t = todayKey();
  if (key === t) return '오늘';
  if (key === shiftKey(t, -1)) return '어제';
  if (key === shiftKey(t, 1)) return '내일';
  return '';
}

async function selectDate(key, opts = {}) {
  const changed = day.date !== key;
  if (changed) {
    day.date = key;
    resetFormState();
    day.dismissedCompose = false;
  }
  const hadFocus = el.dayGrid.contains(document.activeElement);
  renderGrid();
  if (hadFocus) {
    const btn = el.dayGrid.querySelector('.day.selected');
    if (btn) btn.focus({ preventScroll: true });
  }
  await loadDay();
  if (opts.highlightId) flashRecord(opts.highlightId);
  if (opts.scroll) scrollDayIntoView();
}

function scrollDayIntoView() {
  requestAnimationFrame(() => {
    el.dayCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function flashRecord(entryId) {
  requestAnimationFrame(() => {
    const node = el.recList.querySelector(`.rec[data-id="${CSS.escape(entryId)}"]`);
    if (!node) return;
    node.classList.add('flash');
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

async function loadDay() {
  const seq = ++day.seq;
  const [es, ps] = await Promise.all([entriesForDate(day.date), photosForDate(day.date)]);
  if (seq !== day.seq) return; // 다른 날짜로 빠르게 옮긴 경우 무시
  day.entries = es.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  day.photos = ps;

  // 기록이 없는 날은 달력 아래에서 바로 적을 수 있게 입력칸을 펼쳐 둔다
  if (!day.entries.length && !day.formMode && !day.dismissedCompose) {
    await startForm('home', null, { auto: true });
    return;
  }
  renderDay();
}

function renderDay() {
  const key = day.date;
  const { y, m, d } = parseKey(key);
  const rel = relLabel(key);
  el.dayTitle.textContent = `${m + 1}월 ${d}일 (${WEEKDAY[dowOf(key)]})`;
  el.dayPill.textContent = rel || (y !== new Date().getFullYear() ? `${y}년` : '');
  el.dayPill.hidden = !el.dayPill.textContent;
  el.dayPill.classList.toggle('is-rel', !!rel);

  const photoCount = day.photos.length;
  el.daySub.textContent = day.entries.length
    ? `기록 ${day.entries.length}개${photoCount ? ` · 사진 ${photoCount}장` : ''}`
    : '';

  el.quickHome.classList.toggle('active', day.formMode === 'home');
  el.quickOuting.classList.toggle('active', day.formMode === 'outing');
  el.quickHome.setAttribute('aria-pressed', String(day.formMode === 'home'));
  el.quickOuting.setAttribute('aria-pressed', String(day.formMode === 'outing'));

  el.entryForm.hidden = !day.formMode;
  el.placeField.hidden = day.formMode !== 'outing';
  el.photoField.hidden = day.formMode !== 'outing';

  const isEmpty = day.entries.length === 0;
  el.dayEmpty.hidden = !isEmpty;
  if (isEmpty) {
    el.dayEmptyTitle.textContent = rel === '오늘' ? '아직 오늘의 발자국이 없어요' : '아직 이 날의 발자국이 없어요';
    if (day.formMode === 'outing') {
      el.dayEmptySub.textContent = '장소와 사진, 내용을 남겨 보세요';
    } else if (day.formMode === 'home') {
      el.dayEmptySub.textContent = '집에서 있었던 일을 적고 저장해 보세요';
    } else {
      el.dayEmptySub.textContent = '🏠 집이나 📍 외출을 눌러 남겨 보세요';
    }
  }

  renderRecords();
  el.recList.hidden = isEmpty;
  el.addMoreBtn.hidden = isEmpty || !!day.formMode;
}

/* ---------- 기록 목록 ---------- */
function photosOfEntry(entryId) {
  return day.photos.filter((p) => p.entryId === entryId);
}

function renderRecords() {
  el.recList.replaceChildren();
  if (!day.entries.length) return;

  for (const entry of day.entries) {
    const li = document.createElement('li');
    li.className = 'rec';
    li.dataset.id = entry.id;

    const photos = photosOfEntry(entry.id);
    const badge = entry.kind === 'home'
      ? '<span class="rec-badge home">🏠 집</span>'
      : `<span class="rec-badge outing">📍 ${esc(entry.place || '외출')}</span>`;
    const note = entry.note
      ? `<p class="rec-note">${esc(entry.note)}</p>`
      : '<p class="rec-note placeholder">내용 없음</p>';

    li.innerHTML = `
      <div class="rec-top">${badge}</div>
      ${note}
      <div class="rec-photos"></div>
      <div class="rec-actions">
        <button type="button" class="link-btn" data-act="edit">수정</button>
        <button type="button" class="link-btn danger" data-act="del">삭제</button>
      </div>`;

    const photoWrap = li.querySelector('.rec-photos');
    photos.forEach((p, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rec-photo';
      btn.setAttribute('aria-label', '사진 크게 보기');
      const img = document.createElement('img');
      img.src = thumbUrl(p);
      img.alt = '';
      img.loading = 'lazy';
      btn.appendChild(img);
      btn.addEventListener('click', () => openLightbox(photos, idx));
      photoWrap.appendChild(btn);
    });
    if (!photos.length) photoWrap.remove();

    li.querySelector('[data-act="edit"]').addEventListener('click', () => {
      startForm(entry.kind, entry, { scroll: true });
    });
    li.querySelector('[data-act="del"]').addEventListener('click', () => removeRecord(entry));

    el.recList.appendChild(li);
  }
}

async function removeRecord(entry) {
  const what = entry.kind === 'home' ? '집 기록' : `'${entry.place || '외출'}' 기록`;
  const ok = await askConfirm(`${what}을(를) 삭제할까요?\n사진도 함께 지워져요.`);
  if (!ok) return;
  if (day.editingId === entry.id) resetFormState();
  photosOfEntry(entry.id).forEach((p) => dropPhotoUrl(p.id));
  await deleteEntryCascade(entry.id);
  invalidateEntries();
  day.dismissedCompose = true; // 마지막 기록을 지워도 입력칸이 갑자기 열리지 않게
  if (entry.date.slice(0, 7) === monthPrefix()) await loadMonth();
  await loadDay();
  day.dismissedCompose = false;
  toast('삭제했어요');
}

/* ---------- 집 / 외출 빠른 기록 ---------- */
el.quickHome.addEventListener('click', () => {
  if (day.formMode === 'home') { closeForm(true); return; }
  if (day.formMode) { switchKind('home'); return; }
  startForm('home', day.entries.find((e) => e.kind === 'home') || null);
});
el.quickOuting.addEventListener('click', () => {
  if (day.formMode === 'outing') { closeForm(true); return; }
  if (day.formMode) { switchKind('outing'); return; }
  startForm('outing', null, { focus: true });
});
el.addMoreBtn.addEventListener('click', () => {
  startForm('outing', null, { focus: true });
});

// 폼을 쓰는 중에 집/외출을 바꾸면, 쓰던 내용은 두고 종류만 바꾼다
function switchKind(kind) {
  if (day.formMode === kind) return;
  day.formMode = kind;
  el.formSave.textContent = day.editingId ? '수정 완료' : '저장';
  renderDay();
  if (kind === 'outing') el.placeInput.focus();
  else el.noteInput.focus();
}

async function startForm(kind, entry, opts = {}) {
  day.formMode = kind;
  day.editingId = entry ? entry.id : null;
  day.dismissedCompose = false;
  day.pending.forEach((p) => URL.revokeObjectURL(p.url));
  day.pending = [];
  day.removeIds = [];
  day.kept = entry ? photosOfEntry(entry.id) : [];

  el.placeInput.value = entry && entry.kind === 'outing' ? (entry.place || '') : '';
  el.noteInput.value = entry ? (entry.note || '') : '';
  el.formSave.textContent = entry ? '수정 완료' : '저장';
  el.formSave.disabled = false;
  el.formTitle.hidden = !entry;
  if (entry) {
    el.formTitle.textContent = entry.kind === 'home'
      ? '🏠 집 기록 수정'
      : `📍 ${entry.place || '외출'} 수정`;
  }

  el.photoRow.replaceChildren();
  renderPhotoPreviews();
  el.chipEditor.hidden = true;
  day.chipEditing = false;
  el.chipEditBtn.textContent = '장소 편집';
  renderDay();

  await loadChips();

  if (opts.focus) (kind === 'outing' ? el.placeInput : el.noteInput).focus();
  if (opts.scroll) el.entryForm.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function resetFormState() {
  day.formMode = null;
  day.editingId = null;
  day.pending.forEach((p) => URL.revokeObjectURL(p.url));
  day.pending = [];
  day.kept = [];
  day.removeIds = [];
  el.entryForm.reset();
  el.photoRow.replaceChildren();
  el.formTitle.hidden = true;
  el.formTitle.textContent = '';
  day.chipEditing = false;
  el.chipEditor.hidden = true;
  el.chipEditBtn.textContent = '장소 편집';
}

function closeForm(markDismissed = false) {
  resetFormState();
  if (markDismissed && !day.entries.length) day.dismissedCompose = true;
  renderDay();
}

el.formCancel.addEventListener('click', () => closeForm(true));

/* ---------- 자주 가는 장소 칩 ---------- */
async function loadChips() {
  const prefs = await getSetting('chipPrefs', { hidden: [], custom: [] });
  day.chipPrefs = {
    hidden: Array.isArray(prefs.hidden) ? prefs.hidden : [],
    custom: Array.isArray(prefs.custom) ? prefs.custom : [],
  };
  const all = await getAllEntriesCached();
  const counts = new Map();
  for (const e of all) {
    if (e.kind === 'outing' && e.place) counts.set(e.place, (counts.get(e.place) || 0) + 1);
  }
  const frequent = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const list = [];
  const push = (p) => {
    const name = String(p || '').trim();
    if (!name) return;
    if (list.includes(name)) return;
    if (day.chipPrefs.hidden.includes(name)) return;
    list.push(name);
  };
  DEFAULT_PLACES.forEach(push);
  frequent.forEach(push);
  day.chipPrefs.custom.forEach(push);
  // 지금 입력된 장소가 목록에 없으면 앞에 보여 준다
  const typed = el.placeInput.value.trim();
  if (typed && !list.includes(typed)) list.unshift(typed);
  day.chips = list.slice(0, 14);
  renderChips();
  el.placeOptions.replaceChildren();
  for (const name of day.chips) {
    const opt = document.createElement('option');
    opt.value = name;
    el.placeOptions.appendChild(opt);
  }
}

function renderChips() {
  el.placeChips.replaceChildren();
  const typed = el.placeInput.value.trim();
  for (const name of day.chips) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (typed === name ? ' on' : '');
    chip.dataset.place = name;
    if (day.chipEditing) {
      chip.innerHTML = `${esc(name)}<span class="chip-x" aria-hidden="true">✕</span>`;
      chip.title = '이 장소를 칩에서 빼기';
      chip.addEventListener('click', (ev) => {
        ev.preventDefault();
        hideChip(name);
      });
    } else {
      chip.textContent = name;
      chip.addEventListener('click', () => {
        el.placeInput.value = name;
        renderChips();
      });
    }
    el.placeChips.appendChild(chip);
  }
}

async function hideChip(name) {
  if (!day.chipPrefs.hidden.includes(name)) day.chipPrefs.hidden.push(name);
  day.chipPrefs.custom = day.chipPrefs.custom.filter((c) => c !== name);
  await setSetting('chipPrefs', day.chipPrefs);
  day.chips = day.chips.filter((c) => c !== name);
  renderChips();
}

el.chipEditBtn.addEventListener('click', () => {
  day.chipEditing = !day.chipEditing;
  el.chipEditor.hidden = !day.chipEditing;
  el.chipEditBtn.textContent = day.chipEditing ? '편집 끝내기' : '장소 편집';
  renderChips();
  if (day.chipEditing) el.chipNewInput.focus();
});

el.chipAddBtn.addEventListener('click', addChip);
el.chipNewInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); addChip(); }
});

async function addChip() {
  const name = el.chipNewInput.value.trim();
  if (!name) return;
  if (!day.chipPrefs.custom.includes(name)) day.chipPrefs.custom.push(name);
  day.chipPrefs.hidden = day.chipPrefs.hidden.filter((h) => h !== name);
  await setSetting('chipPrefs', day.chipPrefs);
  el.chipNewInput.value = '';
  await loadChips();
  el.placeInput.value = name;
  renderChips();
}

el.placeInput.addEventListener('input', renderChips);

/* ---------- 사진 ---------- */
el.cameraBtn.addEventListener('click', () => el.cameraInput.click());
el.albumBtn.addEventListener('click', () => el.albumInput.click());
el.cameraInput.addEventListener('change', async () => {
  await handleFiles(el.cameraBtn, el.cameraInput.files);
  el.cameraInput.value = '';
});
el.albumInput.addEventListener('change', async () => {
  await handleFiles(el.albumBtn, el.albumInput.files);
  el.albumInput.value = '';
});

function setPhotoBusy(busy, label) {
  day.busy = busy;
  [el.cameraBtn, el.albumBtn].forEach((b) => { b.disabled = busy; });
  if (busy) {
    el.albumBtn.dataset.label = el.albumBtn.textContent;
    el.albumBtn.textContent = label || '사진 처리 중…';
  } else if (el.albumBtn.dataset.label) {
    el.albumBtn.textContent = el.albumBtn.dataset.label;
    delete el.albumBtn.dataset.label;
  }
}

async function handleFiles(trigger, fileList) {
  if (day.busy) return;
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const room = MAX_PHOTOS - day.pending.length - day.kept.length;
  if (room <= 0) {
    toast(`사진은 한 기록에 ${MAX_PHOTOS}장까지 넣을 수 있어요`);
    return;
  }
  const take = files.slice(0, room);
  if (files.length > room) toast(`사진은 ${MAX_PHOTOS}장까지만 넣을 수 있어요`);
  setPhotoBusy(true);
  for (const file of take) {
    try {
      const c = await compressImage(file);
      day.pending.push({ ...c, url: URL.createObjectURL(c.full) });
    } catch (err) {
      toast('이 사진은 불러올 수 없어요. 다른 사진으로 해보세요');
    }
  }
  setPhotoBusy(false);
  renderPhotoPreviews();
}

function renderPhotoPreviews() {
  el.photoRow.replaceChildren();
  const add = (src, onRemove) => {
    const wrap = document.createElement('div');
    wrap.className = 'photo-item';
    const img = document.createElement('img');
    img.src = src;
    img.alt = '첨부한 사진';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = '✕';
    rm.setAttribute('aria-label', '사진 빼기');
    rm.addEventListener('click', onRemove);
    wrap.appendChild(img);
    wrap.appendChild(rm);
    el.photoRow.appendChild(wrap);
  };
  for (const p of day.kept) {
    add(thumbUrl(p), () => {
      day.kept = day.kept.filter((x) => x.id !== p.id);
      day.removeIds.push(p.id);
      renderPhotoPreviews();
    });
  }
  day.pending.forEach((p, idx) => {
    add(p.url, () => {
      URL.revokeObjectURL(p.url);
      day.pending.splice(idx, 1);
      renderPhotoPreviews();
    });
  });
}

/* ---------- 저장 / 수정 ---------- */
el.entryForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!day.formMode || day.busy) return;
  const kind = day.formMode;
  const place = el.placeInput.value.trim();
  const note = el.noteInput.value.trim();

  if (kind === 'outing' && !place) {
    toast('장소를 입력해 주세요');
    el.placeInput.focus();
    return;
  }
  if (kind === 'home' && !note) {
    toast('집에서 있었던 일을 적어 주세요');
    el.noteInput.focus();
    return;
  }

  el.formSave.disabled = true;
  el.formSave.textContent = '저장 중…';
  try {
    const now = new Date().toISOString();
    const existing = day.editingId ? day.entries.find((x) => x.id === day.editingId) : null;
    const entry = existing
      ? { ...existing, kind, place: kind === 'outing' ? place : '', note, updatedAt: now }
      : {
        id: uid(),
        date: day.date,
        kind,
        place: kind === 'outing' ? place : '',
        note,
        createdAt: now,
        updatedAt: now,
      };
    await putEntries([entry]);

    if (kind === 'home') {
      // 집 기록은 사진 없이 내용만 남긴다
      day.pending.forEach((p) => URL.revokeObjectURL(p.url));
      day.pending = [];
      for (const kept of day.kept) day.removeIds.push(kept.id);
      day.kept = [];
    }

    if (day.removeIds.length) {
      for (const id2 of day.removeIds) dropPhotoUrl(id2);
      await Promise.all(day.removeIds.map((id2) => deletePhotoById(id2)));
    }
    if (day.pending.length) {
      const pics = day.pending.map((p) => ({
        id: uid(),
        entryId: entry.id,
        date: day.date,
        full: p.full,
        thumb: p.thumb,
        w: p.w,
        h: p.h,
        createdAt: now,
      }));
      await putPhotos(pics);
      day.pending.forEach((p) => URL.revokeObjectURL(p.url));
      day.pending = [];
    }
    day.removeIds = [];
    invalidateEntries();

    const edited = !!existing;
    resetFormState();
    if (day.date.slice(0, 7) === monthPrefix()) await loadMonth();
    await loadDay();
    toast(edited ? '수정했어요' : '저장했어요');
  } catch (err) {
    console.error(err);
    toast('저장하지 못했어요. 잠시 뒤 다시 해보세요');
    el.formSave.disabled = false;
    el.formSave.textContent = day.editingId ? '수정 완료' : '저장';
  }
});

async function deletePhotoById(photoId) {
  const db = await openDB();
  const tx = db.transaction('photos', 'readwrite');
  tx.objectStore('photos').delete(photoId);
  await txDone(tx);
}

/* ---------------------------------------------------------
   라이트박스
   --------------------------------------------------------- */
let gallery = [];
let galleryIdx = 0;

function openLightbox(photos, idx) {
  gallery = photos.slice();
  galleryIdx = idx || 0;
  if (!gallery.length) return;
  el.lightbox.hidden = false;
  syncBodyLock();
  showGallery();
}
function showGallery() {
  const p = gallery[galleryIdx];
  if (!p) return;
  el.lbImg.src = fullUrl(p);
  el.lbCount.textContent = gallery.length > 1 ? `${galleryIdx + 1} / ${gallery.length}` : '';
  el.lbPrev.hidden = gallery.length < 2;
  el.lbNext.hidden = gallery.length < 2;
}
function closeLightbox() {
  el.lightbox.hidden = true;
  el.lbImg.removeAttribute('src');
  gallery = [];
  syncBodyLock();
}
el.lbClose.addEventListener('click', closeLightbox);
el.lightbox.addEventListener('click', (ev) => { if (ev.target === el.lightbox) closeLightbox(); });
el.lbPrev.addEventListener('click', (ev) => {
  ev.stopPropagation();
  galleryIdx = (galleryIdx - 1 + gallery.length) % gallery.length;
  showGallery();
});
el.lbNext.addEventListener('click', (ev) => {
  ev.stopPropagation();
  galleryIdx = (galleryIdx + 1) % gallery.length;
  showGallery();
});

/* ---------------------------------------------------------
   검색
   --------------------------------------------------------- */
let searchSeq = 0;

async function openSearch() {
  el.searchOverlay.hidden = false;
  syncBodyLock();
  el.searchInput.value = '';
  el.searchResults.replaceChildren();
  el.searchHint.hidden = false;
  el.searchHint.textContent = '가본 곳 이름이나 적어 둔 내용을 검색해 보세요.';
  invalidateEntries();
  await getAllEntriesCached();
  renderSearch('');
  el.searchInput.focus();
}

function closeSearch() {
  el.searchOverlay.hidden = true;
  syncBodyLock();
}

el.searchBtn.addEventListener('click', openSearch);
el.searchClose.addEventListener('click', closeSearch);
el.searchInput.addEventListener('input', () => renderSearch(el.searchInput.value));

function renderSearch(rawQuery) {
  const q = rawQuery.trim();
  const seq = ++searchSeq;
  el.searchResults.replaceChildren();
  if (!q) {
    el.searchHint.hidden = false;
    el.searchHint.textContent = '가본 곳 이름이나 적어 둔 내용을 검색해 보세요.';
    return;
  }
  const all = entriesCache || [];
  const ql = q.toLowerCase();
  const hits = all
    .filter((e) => (e.place || '').toLowerCase().includes(ql) || (e.note || '').toLowerCase().includes(ql))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  if (!hits.length) {
    el.searchHint.hidden = false;
    el.searchHint.textContent = `'${q}' 검색 결과가 없어요.`;
    return;
  }
  el.searchHint.hidden = true;

  let shown = 0;
  for (const entry of hits.slice(0, 80)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sres';
    btn.dataset.date = entry.date;
    btn.dataset.id = entry.id;

    const ico = document.createElement('span');
    ico.className = 'sres-ico';
    ico.textContent = entry.kind === 'home' ? '🏠' : '📍';
    btn.appendChild(ico);
    fillSearchThumb(ico, entry.id);

    const main = document.createElement('div');
    main.className = 'sres-main';
    const placeName = entry.kind === 'home' ? '집' : (entry.place || '외출');
    const noteHtml = entry.note ? highlight(entry.note, q) : '<span style="color:#B0B8C1">내용 없음</span>';
    main.innerHTML = `
      <div class="sres-top">
        <span class="sres-place">${highlight(placeName, q)}</span>
        <span class="sres-date">${esc(labelOf(entry.date))}</span>
      </div>
      <p class="sres-note">${noteHtml}</p>`;
    btn.appendChild(main);

    btn.addEventListener('click', () => gotoEntry(entry.date, entry.id));
    el.searchResults.appendChild(btn);
    shown++;
    if (seq !== searchSeq) return;
  }
  if (hits.length > shown) {
    const more = document.createElement('p');
    more.className = 'search-hint';
    more.textContent = `'${q}' 기록이 ${hits.length - shown}개 더 있어요.`;
    el.searchResults.appendChild(more);
  }
}

async function firstPhotoForEntry(entryId) {
  try {
    const db = await openDB();
    const st = db.transaction('photos').objectStore('photos');
    const rq = st.index('entryId').openCursor(entryId);
    return await new Promise((resolve) => {
      rq.onsuccess = () => resolve(rq.result ? rq.result.value : null);
      rq.onerror = () => resolve(null);
    });
  } catch (_) {
    return null;
  }
}

async function fillSearchThumb(placeholder, entryId) {
  const photo = await firstPhotoForEntry(entryId);
  if (!photo || !placeholder.isConnected) return;
  const img = document.createElement('img');
  img.className = 'sres-thumb';
  img.src = thumbUrl(photo);
  img.alt = '';
  img.loading = 'lazy';
  placeholder.replaceWith(img);
}

async function gotoEntry(date, entryId) {
  closeSearch();
  const { y, m } = parseKey(date);
  view.y = y;
  view.m = m;
  renderCalHead();
  await loadMonth();
  await selectDate(date, { highlightId: entryId, scroll: true });
}

/* ---------------------------------------------------------
   백업 · 설정
   --------------------------------------------------------- */
async function openBackup() {
  el.backupBackdrop.hidden = false;
  syncBodyLock();
  refreshStorageInfo();
}
function closeBackup() {
  el.backupBackdrop.hidden = true;
  syncBodyLock();
}
el.backupBtn.addEventListener('click', openBackup);
el.backupClose.addEventListener('click', closeBackup);
el.backupBackdrop.addEventListener('click', (ev) => { if (ev.target === el.backupBackdrop) closeBackup(); });

function fmtBytes(n) {
  if (!n) return '0MB';
  const mb = n / (1024 * 1024);
  if (mb >= 1) return mb.toFixed(1) + 'MB';
  return Math.max(1, Math.round(n / 1024)) + 'KB';
}

async function refreshStorageInfo() {
  const [entries, photos] = await Promise.all([getAll('entries'), getAll('photos')]);
  const bytes = photos.reduce((sum, p) => sum + (p.full ? p.full.size : 0) + (p.thumb ? p.thumb.size : 0), 0);
  el.storageInfo.textContent = `기록 ${entries.length}개 · 사진 ${photos.length}장 · 약 ${fmtBytes(bytes)}`;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est && est.quota) {
        el.storageTitle.textContent = `이 기기에 저장 중 (${fmtBytes(est.usage || 0)} 사용)`;
      }
    }
  } catch (_) { /* 무시 */ }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataURL) {
  const res = await fetch(dataURL);
  return res.blob();
}

async function exportBackup() {
  el.exportBtn.disabled = true;
  const label = el.exportBtn.textContent;
  el.exportBtn.textContent = '내보내는 중…';
  try {
    const [entries, photos, settings] = await Promise.all([
      getAll('entries'), getAll('photos'), getAll('settings'),
    ]);
    const grouped = new Map();
    for (const p of photos) {
      if (!grouped.has(p.entryId)) grouped.set(p.entryId, []);
      grouped.get(p.entryId).push(p);
    }
    const outEntries = [];
    for (const e of entries) {
      const pics = grouped.get(e.id) || [];
      const outPics = [];
      for (const p of pics) {
        outPics.push({
          id: p.id,
          w: p.w || null,
          h: p.h || null,
          createdAt: p.createdAt || null,
          full: await blobToDataURL(p.full),
          thumb: await blobToDataURL(p.thumb),
        });
      }
      outEntries.push({ ...e, photos: outPics });
    }
    const payload = {
      app: 'place-diary',
      version: 1,
      exportedAt: new Date().toISOString(),
      entries: outEntries,
      settings,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const now = new Date();
    const name = `place-diary-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;

    // 바로 저장을 시도하고, 아이폰에서 저장이 안 되면 사용자가 직접 누를 수 있는 링크도 남긴다
    if (el.exportLink.dataset.url) URL.revokeObjectURL(el.exportLink.dataset.url);
    const url = URL.createObjectURL(blob);
    el.exportLink.dataset.url = url;
    el.exportLink.href = url;
    el.exportLink.download = name;
    el.exportLink.textContent = `백업 파일 저장하기 (${name})`;
    el.exportLink.hidden = false;

    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`백업 파일을 만들었어요 · 기록 ${entries.length}개`);
  } catch (err) {
    console.error(err);
    toast('내보내지 못했어요. 잠시 뒤 다시 해보세요');
  } finally {
    el.exportBtn.disabled = false;
    el.exportBtn.textContent = label;
  }
}

el.exportBtn.addEventListener('click', exportBackup);
el.importBtn.addEventListener('click', () => el.importInput.click());
el.importInput.addEventListener('change', async () => {
  const file = el.importInput.files && el.importInput.files[0];
  el.importInput.value = '';
  if (!file) return;
  await importBackup(file);
});

async function importBackup(file) {
  el.importBtn.disabled = true;
  const label = el.importBtn.textContent;
  el.importBtn.textContent = '불러오는 중…';
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || data.app !== 'place-diary' || !Array.isArray(data.entries)) {
      throw new Error('invalid backup');
    }
    let entryCount = 0;
    let photoCount = 0;
    for (const raw of data.entries) {
      if (!raw || !raw.id || !raw.date || !raw.kind) continue;
      const { photos = [], ...entry } = raw;
      const clean = {
        id: entry.id,
        date: entry.date,
        kind: entry.kind === 'home' ? 'home' : 'outing',
        place: entry.place || '',
        note: entry.note || '',
        createdAt: entry.createdAt || new Date().toISOString(),
        updatedAt: entry.updatedAt || entry.createdAt || new Date().toISOString(),
      };
      await deletePhotosByEntry(clean.id);
      await putEntries([clean]);
      entryCount++;
      const pics = [];
      for (const p of photos) {
        if (!p || !p.full) continue;
        try {
          const full = await dataURLToBlob(p.full);
          const thumb = p.thumb ? await dataURLToBlob(p.thumb) : full;
          pics.push({
            id: p.id || uid(),
            entryId: clean.id,
            date: clean.date,
            full,
            thumb,
            w: p.w || null,
            h: p.h || null,
            createdAt: p.createdAt || new Date().toISOString(),
          });
        } catch (e) { /* 사진 한 장 실패는 건너뛴다 */ }
      }
      if (pics.length) {
        await putPhotos(pics);
        photoCount += pics.length;
      }
    }
    if (Array.isArray(data.settings)) {
      for (const s of data.settings) {
        if (s && s.key) await setSetting(s.key, s.value);
      }
    }
    thumbCache.forEach((u) => URL.revokeObjectURL(u));
    thumbCache.clear();
    fullCache.forEach((u) => URL.revokeObjectURL(u));
    fullCache.clear();
    invalidateEntries();
    await loadMonth();
    await loadDay();
    await refreshStorageInfo();
    toast(`기록 ${entryCount}개, 사진 ${photoCount}장을 불러왔어요`);
  } catch (err) {
    console.error(err);
    toast('이 파일은 불러올 수 없어요. 백업 JSON인지 확인해 주세요');
  } finally {
    el.importBtn.disabled = false;
    el.importBtn.textContent = label;
  }
}

/* ---------------------------------------------------------
   바깥 클릭 / 키보드
   --------------------------------------------------------- */
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!el.dialogBackdrop.hidden) return; // 확인 대화상자가 직접 처리
  if (!el.lightbox.hidden) { closeLightbox(); return; }
  if (!el.searchOverlay.hidden) { closeSearch(); return; }
  if (!el.backupBackdrop.hidden) { closeBackup(); return; }
});

/* ---------------------------------------------------------
   시작
   --------------------------------------------------------- */
async function init() {
  const now = new Date();
  view.y = now.getFullYear();
  view.m = now.getMonth();
  renderCalHead();
  try {
    await openDB();
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    await loadMonth();
    await loadDay();
  } catch (err) {
    console.error(err);
    toast('저장 공간을 열지 못했어요. 사파리 설정을 확인해 주세요');
  }
  if ('serviceWorker' in navigator) {
    const register = () => navigator.serviceWorker.register('./sw.js').catch(() => {});
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
}

init();
