/* 사진 자르기(크롭) 모달 — 내 물건 · 주유일기 · 오늘의 발자국 공통
 * -----------------------------------------------------------------------------
 *  · <input type="file"> 로 사진을 고르면 한 장씩 크롭 모달이 뜬다.
 *    여러 장을 고르면 1 / N 순서로 한 장씩 ‘원본 그대로’ 또는 ‘자르기 적용’으로 넘긴다.
 *  · 열 때 ✨ 자동 맞춤: 배경과 구분되는 영수증·카드 영역을 찾아 크롭 박스를 맞춘다 (버튼으로 다시)
 *  · 크롭 박스: 네 모서리 핸들 + 박스 몸통 드래그 (Pointer/Touch, touch-action: none)
 *  · 비율 칩: 자유(기본) · 1:1 · 3:4 · 4:3 / ↺ 90° 회전
 *  · ‘자르기 적용’은 고른 영역만 캔버스로 잘라 긴 변 1600px JPEG(0.9) File 로 돌려준다.
 *
 *   const files = await CropKit.open(선택한 파일들);
 *   // 사용자가 넘긴 사진만, 고른 순서대로 (취소하면 그때까지 넘긴 것만)
 */
(() => {
  'use strict';
  if (window.CropKit) return;

  const OUT_MAX = 1600;      // 크롭 결과 긴 변 (이후 앱이 한 번 더 압축한다)
  const OUT_QUALITY = 0.9;
  const WORK_MAX = 2000;     // 회전·표시용 작업 캔버스 긴 변
  const MIN_BOX = 48;        // 화면 기준 최소 크롭 크기
  const RATIO_VALUE = { free: 0, '1:1': 1, '3:4': 3 / 4, '4:3': 4 / 3 };

  // 자동 맞춤 — 작은 분석용 캔버스에서 배경과 다른 영역(영수증·카드)을 찾는다
  const AUTO_SIDE = 160;
  const AUTO_THRESHOLD = 24;   // 배경 밝기와의 차이
  const AUTO_MIN_AREA = 0.06;  // 이미지의 6%보다 작으면 믿지 않는다
  const AUTO_MAX_AREA = 0.94;  // 거의 전체면 믿지 않는다

  const MARKUP = `
    <div class="crop-panel" role="dialog" aria-modal="true" aria-label="사진 자르기">
      <div class="crop-head">
        <button type="button" class="crop-cancel" id="cropCancel">취소</button>
        <div class="crop-title">
          <span>사진 자르기</span>
          <span class="crop-step" id="cropStep">1 / 1</span>
        </div>
        <div class="crop-tools">
          <button type="button" class="crop-auto" id="cropAuto" aria-label="자동 맞춤" title="자동 맞춤">
            <span class="crop-auto-glyph" aria-hidden="true">✨</span><span class="crop-auto-text">자동 맞춤</span>
          </button>
          <button type="button" class="crop-rotate" id="cropRotate" aria-label="90도 회전" title="90도 회전">
            <span class="crop-rotate-glyph" aria-hidden="true">↺</span><small>90°</small>
          </button>
        </div>
      </div>
      <div class="crop-stage" id="cropStage">
        <canvas class="crop-canvas" id="cropCanvas"></canvas>
        <div class="crop-box" id="cropBox">
          <span class="crop-grid" aria-hidden="true"></span>
          <span class="crop-handle tl" data-corner="nw" aria-hidden="true"></span>
          <span class="crop-handle tr" data-corner="ne" aria-hidden="true"></span>
          <span class="crop-handle bl" data-corner="sw" aria-hidden="true"></span>
          <span class="crop-handle br" data-corner="se" aria-hidden="true"></span>
        </div>
        <p class="crop-hint" id="cropHint">테두리를 끌어 자를 곳을 맞춰 보세요</p>
      </div>
      <div class="crop-chips" id="cropChips" role="group" aria-label="자르기 비율">
        <button type="button" data-ratio="free" aria-pressed="true">자유</button>
        <button type="button" data-ratio="1:1" aria-pressed="false">1:1</button>
        <button type="button" data-ratio="3:4" aria-pressed="false">3:4</button>
        <button type="button" data-ratio="4:3" aria-pressed="false">4:3</button>
      </div>
      <div class="crop-actions">
        <button type="button" class="crop-btn ghost" id="cropOriginal">원본 그대로</button>
        <button type="button" class="crop-btn primary" id="cropApply">자르기 적용</button>
      </div>
    </div>`;

  let ui = null;
  let queue = [];
  let index = 0;
  let accepted = [];
  let settle = null;
  let img = null;
  let imgUrl = '';
  let base = null;                 // 회전이 적용된 작업 캔버스
  let rotation = 0;
  let ratio = 'free';
  let fit = { x: 0, y: 0, w: 1, h: 1, scale: 1 };   // 화면에 그려진 사진 영역
  let box = { x: 0, y: 0, w: 1, h: 1 };             // 자를 영역 (스테이지 기준 px)
  let drag = null;
  let busy = false;
  let outMax = OUT_MAX;
  let lockDepth = 0;
  let savedLock = null;
  let autoRect = null;      // 자동 맞춤이 찾은 영역 (0~1 비율)
  let autoUsed = false;     // 지금 박스가 자동 맞춤 결과인지
  let lastStage = { w: 0, h: 0 };

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const ratioVal = () => RATIO_VALUE[ratio] || 0;

  /* ── 화면 만들기 ───────────────────────── */
  function ensureUi() {
    if (ui) return ui;
    const wrap = document.createElement('div');
    wrap.className = 'crop-wrap';
    wrap.id = 'cropWrap';
    wrap.hidden = true;
    wrap.innerHTML = MARKUP;
    document.body.appendChild(wrap);
    ui = {
      wrap,
      stage: wrap.querySelector('#cropStage'),
      canvas: wrap.querySelector('#cropCanvas'),
      boxEl: wrap.querySelector('#cropBox'),
      step: wrap.querySelector('#cropStep'),
      cancel: wrap.querySelector('#cropCancel'),
      auto: wrap.querySelector('#cropAuto'),
      rotate: wrap.querySelector('#cropRotate'),
      chips: wrap.querySelector('#cropChips'),
      original: wrap.querySelector('#cropOriginal'),
      apply: wrap.querySelector('#cropApply'),
      hint: wrap.querySelector('#cropHint'),
    };
    bindEvents();
    return ui;
  }

  function bindEvents() {
    ui.cancel.addEventListener('click', () => finish(accepted));
    ui.auto.addEventListener('click', () => {
      if (busy || !base) return;
      if (autoBox()) flashHint('✨ 배경과 구분되는 영역을 찾아 맞췄어요');
      else flashHint('자동으로 찾기 어려워요. 테두리를 직접 맞춰 보세요');
    });
    ui.rotate.addEventListener('click', rotate90);
    ui.apply.addEventListener('click', applyCurrent);
    ui.original.addEventListener('click', keepOriginal);

    ui.chips.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-ratio]');
      if (!btn || busy) return;
      setRatio(btn.dataset.ratio);
    });

    ui.stage.addEventListener('pointerdown', onPointerDown);
    ui.stage.addEventListener('pointermove', onPointerMove);
    ui.stage.addEventListener('pointerup', onPointerUp);
    ui.stage.addEventListener('pointercancel', onPointerUp);
    // 드래그 중 배경 스크롤·확대를 막는다 (touch-action: none 보조)
    ui.stage.addEventListener('touchmove', (e) => { if (drag || e.target.closest('#cropBox')) e.preventDefault(); }, { passive: false });
    ui.wrap.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !settle) return;
      e.preventDefault();
      finish(accepted);
    }, true);

    window.addEventListener('resize', () => {
      if (!settle || !base) return;
      frameImage();
    });
  }

  /* ── 페이지 스크롤 잠금 ───────────────────────── */
  function lockPage() {
    if (lockDepth > 0) { lockDepth += 1; return; }
    lockDepth = 1;
    savedLock = {
      html: document.documentElement.style.overflow,
      body: document.body.style.overflow,
      over: document.body.style.overscrollBehavior,
    };
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';
    document.documentElement.classList.add('crop-open');
  }

  function unlockPage() {
    if (lockDepth === 0) return;
    lockDepth -= 1;
    if (lockDepth > 0) return;
    const prev = savedLock || {};
    document.documentElement.style.overflow = prev.html || '';
    document.body.style.overflow = prev.body || '';
    document.body.style.overscrollBehavior = prev.over || '';
    document.documentElement.classList.remove('crop-open');
    savedLock = null;
  }

  /* ── 열기 / 닫기 ───────────────────────── */
  function open(files, opts) {
    const list = Array.from(files || []).filter((f) => f && String(f.type || '').startsWith('image/'));
    if (!list.length) return Promise.resolve([]);
    ensureUi();
    queue = list;
    index = 0;
    accepted = [];
    rotation = 0;
    ratio = 'free';
    drag = null;
    busy = false;
    outMax = (opts && opts.maxSide) || OUT_MAX;
    syncChips();
    ui.step.textContent = `1 / ${queue.length}`;
    lockPage();
    ui.wrap.hidden = false;
    setBusy(true, '불러오는 중…');
    return new Promise((resolve) => {
      settle = resolve;
      showCurrent();
    });
  }

  function finish(result) {
    const done = settle;
    settle = null;
    drag = null;
    busy = false;
    if (imgUrl) { URL.revokeObjectURL(imgUrl); imgUrl = ''; }
    img = null;
    base = null;
    if (ui) ui.wrap.hidden = true;
    unlockPage();
    if (done) done((result || []).slice());
  }

  async function showCurrent() {
    const file = queue[index];
    if (!file) { finish(accepted); return; }
    ui.step.textContent = `${index + 1} / ${queue.length}`;
    setBusy(true, '불러오는 중…');
    try {
      await loadFile(file);
      // 첫 프레임에 스테이지 크기가 아직 0일 수 있어 한 번 더 그린다
      requestAnimationFrame(() => {
        if (!settle) return;
        const w = Math.round(ui.stage.clientWidth);
        const h = Math.round(ui.stage.clientHeight);
        if (Math.abs(w - lastStage.w) > 1 || Math.abs(h - lastStage.h) > 1) frameImage();
      });
      setBusy(false);
      ui.hint.textContent = queue.length > 1
        ? `${index + 1}장째 · 테두리를 끌어 자를 곳을 맞춰 보세요`
        : '테두리를 끌어 자를 곳을 맞춰 보세요';
    } catch (err) {
      // 못 읽은 사진은 조용히 건너뛴다 (앱 쪽에서 실패 안내를 한다)
      index += 1;
      showCurrent();
    }
  }

  function loadFile(file) {
    return new Promise((resolve, reject) => {
      if (imgUrl) { URL.revokeObjectURL(imgUrl); imgUrl = ''; }
      img = null;
      base = null;
      imgUrl = URL.createObjectURL(file);
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => {
        try {
          if (!(im.naturalWidth || im.width)) throw new Error('empty image');
          img = im;
          makeBase();
          frameImage();
          resolve();
        } catch (err) { reject(err); }
      };
      im.onerror = () => reject(new Error('이미지를 읽지 못했어요'));
      im.src = imgUrl;
    });
  }

  /* ── 캔버스 ───────────────────────── */
  function makeBase() {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const k = Math.min(1, WORK_MAX / Math.max(iw, ih));
    const w0 = Math.max(1, Math.round(iw * k));
    const h0 = Math.max(1, Math.round(ih * k));
    const swap = rotation % 180 !== 0;
    const cv = document.createElement('canvas');
    cv.width = swap ? h0 : w0;
    cv.height = swap ? w0 : h0;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(cv.width / 2, cv.height / 2);
    ctx.rotate((-rotation * Math.PI) / 180);   // ↺ 반시계 방향
    ctx.drawImage(img, -w0 / 2, -h0 / 2, w0, h0);
    base = cv;
  }

  function drawStage() {
    if (!base || !ui) return;
    const W = Math.round(ui.stage.clientWidth);
    const H = Math.round(ui.stage.clientHeight);
    if (W < 2 || H < 2) return;
    lastStage = { w: W, h: H };
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const cv = ui.canvas;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = `${W}px`;
    cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 모서리 핸들이 잘리지 않도록 사진 둘레에 약간의 여백을 둔다
    const inset = 24;
    const availW = Math.max(40, W - inset * 2);
    const availH = Math.max(40, H - inset * 2);
    const scale = Math.min(availW / base.width, availH / base.height);
    const w = base.width * scale;
    const h = base.height * scale;
    const x = (W - w) / 2;
    const y = (H - h) / 2;
    fit = { x, y, w, h, scale };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, x, y, w, h);
  }

  /* ── 크롭 박스 ───────────────────────── */
  function paintBox() {
    const el = ui.boxEl;
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
  }

  function resetBox() {
    if (!fit.w || !fit.h) return;
    if (!ratioVal()) {
      box = { x: fit.x, y: fit.y, w: fit.w, h: fit.h };
    } else {
      box = largestRect(fit, ratioVal());
    }
    paintBox();
  }

  function largestRect(area, r) {
    let w = area.w;
    let h = w / r;
    if (h > area.h) { h = area.h; w = h * r; }
    return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
  }

  /* ── 자동 맞춤 ─────────────────────────
     작은 캔버스로 줄여 밝기를 비교한다. 테두리(배경)의 중앙값과 충분히 다른
     픽셀을 내용으로 보고, 가로·세로 투영으로 바운딩 박스를 만든다.
     영수증·카드처럼 배경과 밝기가 다른 물체에 잘 듣는다. */
  function autoDetect() {
    if (!base || !base.width || !base.height) return null;
    const k = Math.min(1, AUTO_SIDE / Math.max(base.width, base.height));
    const w = Math.max(8, Math.round(base.width * k));
    const h = Math.max(8, Math.round(base.height * k));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(base, 0, 0, w, h);
    let px;
    try { px = ctx.getImageData(0, 0, w, h).data; } catch (err) { return null; }

    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i += 1) {
      lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    }

    // 배경 밝기 — 바깥 테두리 픽셀의 중앙값
    const edge = [];
    for (let x = 0; x < w; x += 1) { edge.push(lum[x], lum[(h - 1) * w + x]); }
    for (let y = 0; y < h; y += 1) { edge.push(lum[y * w], lum[y * w + (w - 1)]); }
    edge.sort((a, b) => a - b);
    const bg = edge[Math.floor(edge.length / 2)];

    const rowCount = new Int32Array(h);
    const colCount = new Int32Array(w);
    let total = 0;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (Math.abs(lum[y * w + x] - bg) > AUTO_THRESHOLD) {
          rowCount[y] += 1;
          colCount[x] += 1;
          total += 1;
        }
      }
    }
    if (total / (w * h) < AUTO_MIN_AREA || total / (w * h) > AUTO_MAX_AREA) return null;

    const rowMin = Math.max(2, Math.round(w * 0.08));
    const colMin = Math.max(2, Math.round(h * 0.08));
    let top = -1, bottom = -1, left = -1, right = -1;
    for (let y = 0; y < h; y += 1) if (rowCount[y] >= rowMin) { if (top < 0) top = y; bottom = y; }
    for (let x = 0; x < w; x += 1) if (colCount[x] >= colMin) { if (left < 0) left = x; right = x; }
    if (top < 0 || left < 0) return null;

    const bw = right - left + 1;
    const bh = bottom - top + 1;
    const rel = (bw * bh) / (w * h);
    if (rel < AUTO_MIN_AREA || rel > AUTO_MAX_AREA) return null;

    // 살짝 여유를 두고 잘라 내야 테두리가 잘리지 않는다
    const padX = Math.max(1, bw * 0.015);
    const padY = Math.max(1, bh * 0.015);
    const nx = Math.max(0, (left - padX) / w);
    const ny = Math.max(0, (top - padY) / h);
    const nw = Math.min(1 - nx, (bw + padX * 2) / w);
    const nh = Math.min(1 - ny, (bh + padY * 2) / h);
    return { x: nx, y: ny, w: nw, h: nh };
  }

  /** 자동 영역을 화면 좌표로 옮겨 박스를 맞춘다. 못 찾으면 false */
  function autoBox() {
    if (!base || !fit.w || !fit.h) return false;
    const rect = autoDetect();
    autoRect = rect;
    if (!rect) { autoUsed = false; resetBox(); return false; }

    let b = {
      x: fit.x + rect.x * fit.w,
      y: fit.y + rect.y * fit.h,
      w: rect.w * fit.w,
      h: rect.h * fit.h,
    };
    if (b.w < MIN_BOX || b.h < MIN_BOX) { autoUsed = false; resetBox(); return false; }
    if (ratioVal()) {
      b = fitRatioIn(b, ratioVal());
      if (!b) { autoUsed = false; resetBox(); return false; }
    }
    b.x = clamp(b.x, fit.x, fit.x + fit.w - b.w);
    b.y = clamp(b.y, fit.y, fit.y + fit.h - b.h);
    box = b;
    autoUsed = true;
    paintBox();
    return true;
  }

  /** 어떤 사각형 안에 꽉 차는 비율 r 의 사각형 (가운데 정렬) */
  function fitRatioIn(area, r) {
    let w = area.w;
    let h = w / r;
    if (h > area.h) { h = area.h; w = h * r; }
    if (w < MIN_BOX || h < MIN_BOX) return null;
    return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
  }

  function flashHint(text) {
    if (!ui) return;
    ui.hint.textContent = text;
    ui.hint.classList.add('crop-hint-strong');
    clearTimeout(flashHint.timer);
    flashHint.timer = setTimeout(() => {
      if (!ui) return;
      ui.hint.classList.remove('crop-hint-strong');
      ui.hint.textContent = queue.length > 1
        ? `${index + 1}장째 · 테두리를 끌어 자를 곳을 맞춰 보세요`
        : '테두리를 끌어 자를 곳을 맞춰 보세요';
    }, 2200);
  }

  /** 사진을 새로 올리거나 돌릴 때: 그린 뒤 자동 영역으로 박스를 맞춘다 */
  function frameImage() {
    drawStage();
    if (!autoBox()) resetBox();
  }

  function setRatio(next) {
    if (!RATIO_VALUE[next]) next = 'free';
    ratio = next;
    autoUsed = false;
    syncChips();
    const r = ratioVal();
    if (!r) { paintBox(); return; }
    // 지금 박스의 가운데를 지키며 비율에 맞는 가장 큰 사각형으로
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let w = Math.max(MIN_BOX, box.w);
    let h = w / r;
    if (h > fit.h) { h = fit.h; w = h * r; }
    if (w > fit.w) { w = fit.w; h = w / r; }
    let x = clamp(cx - w / 2, fit.x, fit.x + fit.w - w);
    let y = clamp(cy - h / 2, fit.y, fit.y + fit.h - h);
    box = { x, y, w, h };
    paintBox();
  }

  function syncChips() {
    if (!ui) return;
    ui.chips.querySelectorAll('button[data-ratio]').forEach((b) => {
      b.setAttribute('aria-pressed', b.dataset.ratio === ratio ? 'true' : 'false');
    });
  }

  function stagePoint(e) {
    const r = ui.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onPointerDown(e) {
    if (busy || !base || !settle) return;
    if (e.button != null && e.button > 0) return;
    const corner = e.target.closest && e.target.closest('[data-corner]');
    const inBox = e.target.closest && e.target.closest('#cropBox');
    if (!corner && !inBox) return;
    e.preventDefault();
    autoUsed = false;
    drag = {
      mode: corner ? 'corner' : 'move',
      corner: corner ? corner.dataset.corner : '',
      id: e.pointerId,
      from: stagePoint(e),
      start: { ...box },
    };
    if (ui.stage.setPointerCapture) {
      try { ui.stage.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    }
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    const p = stagePoint(e);
    if (drag.mode === 'move') {
      box.x = clamp(drag.start.x + (p.x - drag.from.x), fit.x, fit.x + fit.w - drag.start.w);
      box.y = clamp(drag.start.y + (p.y - drag.from.y), fit.y, fit.y + fit.h - drag.start.h);
      box.w = drag.start.w;
      box.h = drag.start.h;
      paintBox();
      return;
    }
    dragCorner(p);
  }

  function onPointerUp(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    if (ui.stage.releasePointerCapture) {
      try { ui.stage.releasePointerCapture(drag.id); } catch (err) { /* noop */ }
    }
    drag = null;
  }

  function dragCorner(p) {
    const s = drag.start;
    const c = drag.corner;
    const r = ratioVal();
    // 움직이지 않는 반대쪽 모서리
    const ax = c.includes('w') ? s.x + s.w : s.x;
    const ay = c.includes('n') ? s.y + s.h : s.y;

    // 모서리가 움직일 수 있는 최대 폭·높이
    const maxW = Math.max(1, c.includes('w') ? ax - fit.x : fit.x + fit.w - ax);
    const maxH = Math.max(1, c.includes('n') ? ay - fit.y : fit.y + fit.h - ay);

    let w = Math.abs(p.x - ax);
    let h = Math.abs(p.y - ay);

    if (r) {
      // 끌어온 방향 중 더 큰 쪽을 기준으로 비율을 맞춘다
      if (w / r < h) w = h * r; else h = w / r;
      if (w > maxW) { w = maxW; h = w / r; }
      if (h > maxH) { h = maxH; w = h * r; }
      if (w < MIN_BOX && maxW >= MIN_BOX) { w = MIN_BOX; h = w / r; }
      if (h < MIN_BOX && maxH >= MIN_BOX) { h = MIN_BOX; w = h * r; }
    } else {
      w = clamp(w, Math.min(MIN_BOX, maxW), maxW);
      h = clamp(h, Math.min(MIN_BOX, maxH), maxH);
    }

    box.w = Math.max(1, Math.min(w, maxW));
    box.h = Math.max(1, Math.min(h, maxH));
    box.x = c.includes('w') ? ax - box.w : ax;
    box.y = c.includes('n') ? ay - box.h : ay;
    box.x = clamp(box.x, fit.x, fit.x + fit.w - box.w);
    box.y = clamp(box.y, fit.y, fit.y + fit.h - box.h);
    paintBox();
  }

  /* ── 버튼 ───────────────────────── */
  function rotate90() {
    if (busy || !img) return;
    rotation = (rotation + 90) % 360;
    makeBase();
    frameImage();
  }

  function setBusy(on, label) {
    busy = on;
    if (!ui) return;
    ui.apply.disabled = on;
    ui.original.disabled = on;
    ui.rotate.disabled = on;
    ui.auto.disabled = on;
    ui.wrap.classList.toggle('crop-busy', on);
    ui.apply.textContent = on ? (label || '자르는 중…') : '자르기 적용';
  }

  function keepOriginal() {
    if (busy || !settle) return;
    if (queue[index]) accepted.push(queue[index]);
    index += 1;
    if (index >= queue.length) finish(accepted);
    else showCurrent();
  }

  async function applyCurrent() {
    if (busy || !settle || !base) return;
    setBusy(true);
    let file = null;
    try {
      const blob = await cropBlob();
      if (blob) {
        const src = queue[index];
        const name = String((src && src.name) || 'photo').replace(/\.[^./\\]+$/, '') || 'photo';
        file = new File([blob], `${name}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
      }
    } catch (err) { file = null; }
    if (file) accepted.push(file);
    else if (queue[index]) accepted.push(queue[index]);   // 실패하면 원본으로라도 담는다
    setBusy(false);
    index += 1;
    if (index >= queue.length) finish(accepted);
    else showCurrent();
  }

  function cropBlob() {
    const sx = (box.x - fit.x) / fit.scale;
    const sy = (box.y - fit.y) / fit.scale;
    const sw = box.w / fit.scale;
    const sh = box.h / fit.scale;
    const k = Math.min(1, outMax / Math.max(sw, sh));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sw * k));
    out.height = Math.max(1, Math.round(sh * k));
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(base, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return new Promise((resolve) => {
      if (out.toBlob) out.toBlob((b) => resolve(b), 'image/jpeg', OUT_QUALITY);
      else resolve(dataUrlToBlob(out.toDataURL('image/jpeg', OUT_QUALITY)));
    });
  }

  function dataUrlToBlob(url) {
    const parts = String(url).split(',');
    const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(parts[1] || '');
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  window.CropKit = {
    open,
    get active() { return !!settle; },
    get state() {
      return {
        index,
        total: queue.length,
        rotation,
        ratio,
        ratioValue: ratioVal(),
        auto: autoUsed,
        autoRect: autoRect ? { ...autoRect } : null,
        box: { ...box },
        fit: { ...fit },
        busy,
      };
    },
  };
})();
