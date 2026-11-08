// 自由編輯區：像 Word 一樣打字、插入圖片/GIF/影片、手繪，並支援文繞圖
import { h, makeId, clamp, isId, fmtBytes } from './util.js';
import { icon } from './icons.js';
import { kindOf, processImage, processGif, processVideo, processCanvas } from './media.js';
import { openDrawPad } from './draw.js';
import { toast, alertBox, busyBox } from './ui.js';

// ---------------------------------------------------------------------------
// 安全過濾：只留下允許的標籤與樣式（存檔與顯示時都會跑一次）
// ---------------------------------------------------------------------------
const KEEP = new Set(['P', 'DIV', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'HR', 'SUB', 'SUP', 'A', 'MARK', 'CODE', 'PRE']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'TEMPLATE', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'VIDEO', 'AUDIO', 'IMG', 'PICTURE', 'SOURCE', 'TRACK', 'CANVAS', 'NOSCRIPT', 'TITLE', 'HEAD', 'FRAME', 'FRAMESET', 'BASE', 'APPLET', 'DIALOG', 'MAP', 'AREA', 'XML']);
const BLOCKS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'PRE', 'UL', 'OL']);
export const FLOATS = ['f-left', 'f-right', 'f-center', 'f-inline'];
const MEDIA_TYPES = ['image', 'gif', 'video'];
const FONT_SIZES = { 1: '12px', 2: '14px', 3: '16px', 4: '20px', 5: '24px', 6: '32px', 7: '40px' };

const okColor = v => {
  const s = String(v).trim();
  if (/^(initial|inherit|unset|revert|revert-layer|currentcolor)$/i.test(s)) return false;
  return /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|transparent|[a-z]{3,20})$/i.test(s);
};
const okSize = v => /^(\d{1,3}(\.\d{1,2})?(px|em|rem|%)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large)$/i.test(String(v).trim());

function cleanStyle(el, isBlock) {
  const st = el.style;
  if (!st) return '';
  const out = [];
  if (st.color && okColor(st.color)) out.push(`color:${st.color}`);
  if (st.backgroundColor && okColor(st.backgroundColor)) out.push(`background-color:${st.backgroundColor}`);
  if (st.fontSize && okSize(st.fontSize)) out.push(`font-size:${st.fontSize}`);
  if (/^(bold|bolder|[6-9]00)$/.test(st.fontWeight)) out.push('font-weight:bold');
  else if (st.fontWeight === 'normal' || st.fontWeight === '400') out.push('font-weight:normal');
  if (st.fontStyle === 'italic') out.push('font-style:italic');
  const td = `${st.textDecorationLine || ''} ${st.textDecoration || ''}`;
  const decos = [];
  if (/underline/.test(td)) decos.push('underline');
  if (/line-through/.test(td)) decos.push('line-through');
  if (decos.length) out.push(`text-decoration:${decos.join(' ')}`);
  if (isBlock) {
    const ta = st.textAlign || el.getAttribute('align') || '';
    if (/^(left|center|right|justify)$/i.test(ta)) out.push(`text-align:${ta.toLowerCase()}`);
  }
  return out.join(';');
}

function cleanElement(el) {
  const tag = el.tagName;
  const style = (tag === 'BR' || tag === 'HR') ? '' : cleanStyle(el, BLOCKS.has(tag));
  const href = tag === 'A' ? (el.getAttribute('href') || '').trim() : '';
  for (const a of [...el.attributes]) el.removeAttribute(a.name);
  if (style) el.setAttribute('style', style);
  if (tag === 'A' && /^(https?:|mailto:)/i.test(href)) {
    el.setAttribute('href', href);
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
}

function fontToSpan(font, lastPx) {
  const span = font.ownerDocument.createElement('span');
  const color = font.getAttribute('color');
  const size = font.getAttribute('size');
  const extra = font.getAttribute('style') || '';
  const parts = [extra];
  if (color && okColor(color)) parts.push(`color:${color}`);
  if (size === '7' && lastPx) parts.push(`font-size:${lastPx}`);
  else if (size && FONT_SIZES[size]) parts.push(`font-size:${FONT_SIZES[size]}`);
  const css = parts.filter(Boolean).join(';');
  if (css) span.setAttribute('style', css);
  while (font.firstChild) span.append(font.firstChild);
  font.replaceWith(span);
  return span;
}

function cleanMedia(el) {
  const mid = el.getAttribute('data-mid');
  const type = el.getAttribute('data-type');
  if (!isId(mid) || !MEDIA_TYPES.includes(type)) { el.remove(); return; }
  const fl = FLOATS.find(f => el.classList.contains(f)) || 'f-left';
  const wide = el.classList.contains('m-wide');
  const ar = parseFloat(el.getAttribute('data-ar'));
  const wRaw = (el.style && el.style.width) || '';
  const w = wRaw.endsWith('%') ? parseFloat(wRaw) : NaN;
  for (const a of [...el.attributes]) el.removeAttribute(a.name);
  el.textContent = '';
  el.className = `m ${fl}${wide ? ' m-wide' : ''}`;
  el.setAttribute('data-mid', mid);
  el.setAttribute('data-type', type);
  if (ar > 0.05 && ar < 20) el.setAttribute('data-ar', String(Math.round(ar * 1000) / 1000));
  if (w >= 5 && w <= 100) el.setAttribute('style', `width:${Math.round(w * 10) / 10}%`);
}

function cleanChildren(parent, opts) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === 3) continue;
    if (node.nodeType !== 1) { node.remove(); continue; }
    const tag = node.tagName.toUpperCase();
    if (DROP.has(tag)) { if (tag === 'IMG' && opts) opts.droppedImg = true; node.remove(); continue; }
    if (tag === 'SPAN' && node.classList.contains('m')) {
      if (opts && opts.allowMid && !opts.allowMid(node.getAttribute('data-mid'))) { node.remove(); continue; }
      cleanMedia(node);
      continue;
    }
    if (tag === 'FONT') {
      const span = fontToSpan(node, opts && opts.lastPx);
      cleanChildren(span, opts);
      cleanElement(span);
      continue;
    }
    if (!KEEP.has(tag)) {
      cleanChildren(node, opts);
      node.replaceWith(...node.childNodes);
      continue;
    }
    cleanChildren(node, opts);
    cleanElement(node);
  }
}

/** 把任何 HTML 洗成安全、只含允許格式的 HTML */
export function sanitizeHtml(html, opts) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  cleanChildren(tpl.content, opts);
  const box = document.createElement('div');
  box.append(tpl.content);
  return box.innerHTML;
}

/** 編輯區 → 要存進資料庫的 HTML（空內容回傳 ''） */
function serialize(root, lastPx) {
  const clone = root.cloneNode(true);
  for (const m of clone.querySelectorAll('span.m')) {
    const w = parseFloat(m.style.width) || 0;
    m.classList.toggle('m-wide', w >= 55);
  }
  const html = sanitizeHtml(clone.innerHTML, { lastPx });
  const probe = document.createElement('template');
  probe.innerHTML = html;
  const c = probe.content;
  const hasText = c.textContent.replace(/[\s​ ]+/g, '').length > 0;
  if (!hasText && !c.querySelector('span.m, hr')) return '';
  return html;
}

// ---------------------------------------------------------------------------
// 顯示媒體
// ---------------------------------------------------------------------------
const io = typeof IntersectionObserver !== 'undefined'
  ? new IntersectionObserver(list => {
    for (const e of list) {
      if (e.isIntersecting) { io.unobserve(e.target); const fn = e.target._prLoad; e.target._prLoad = null; if (fn) fn(); }
    }
  }, { rootMargin: '300px' })
  : null;
function whenVisible(el, fn) {
  if (io) { el._prLoad = fn; io.observe(el); } else fn();
}

function makeVideo(url) {
  const v = h('video', { controls: true, playsinline: true, preload: 'metadata' });
  v.src = url;
  return v;
}

/**
 * 把 <span class="m" data-mid data-type> 填上實際的圖片/影片
 * ctx = { store, scope, mode: 'preview'|'full'|'edit', localUrl?(mid), localThumb?(mid) }
 */
export function hydrateMedia(span, ctx) {
  const mid = span.dataset.mid;
  const type = span.dataset.type;
  const ar = parseFloat(span.dataset.ar);
  if (ar > 0) span.style.aspectRatio = String(ar);
  span.replaceChildren();
  span.classList.remove('is-loaded', 'is-error', 'is-busy');
  if (ctx.mode === 'edit') span.contentEditable = 'false';
  const local = ctx.localUrl ? ctx.localUrl(mid) : null;
  const { store, scope } = ctx;
  const fail = () => {
    span.classList.add('is-error');
    if (!span.querySelector('.m-err')) span.append(h('span', { class: 'm-err', text: '媒體載入失敗' }));
  };

  if (ctx.mode === 'preview') {
    const img = h('img', { alt: '', draggable: 'false' });
    span.append(img);
    if (type !== 'image') span.append(h('span', { class: 'm-badge', text: type === 'gif' ? 'GIF' : '影片' }));
    const set = url => { if (url) { img.src = url; span.classList.add('is-loaded'); } };
    const lt = local && ctx.localThumb ? ctx.localThumb(mid) : null;
    if (lt) set(lt);
    else whenVisible(span, () => store.getThumb(scope, mid).then(set, fail));
    return;
  }

  if (type === 'video') {
    if (local) { span.append(makeVideo(local)); span.classList.add('is-loaded'); return; }
    const poster = h('img', { alt: '', draggable: 'false', class: 'm-poster' });
    const label = h('span', { text: '播放影片' });
    const btn = h('button', { type: 'button', class: 'm-play', 'aria-label': '播放影片', html: icon('play') }, label);
    span.append(poster, btn);
    whenVisible(span, () => {
      store.getThumb(scope, mid).then(u => { if (u) poster.src = u; }).catch(() => {});
      store.getMeta(scope, mid).then(meta => {
        if (!meta) { fail(); return; }
        if (meta.s && !span.classList.contains('is-busy')) label.textContent = `播放影片（${fmtBytes(meta.s)}）`;
      }).catch(() => {});
    });
    return;
  }

  // 圖片 / GIF：先顯示縮圖，再換成原圖
  const img = h('img', { alt: '', draggable: 'false' });
  span.append(img);
  const show = url => { img.src = url; span.classList.add('is-loaded'); };
  if (local) { show(local); return; }
  whenVisible(span, () => {
    store.getThumb(scope, mid).then(u => { if (u && !span.classList.contains('is-loaded')) img.src = u; }).catch(() => {});
    store.getMediaUrl(scope, mid).then(show, fail);
  });
}

export async function loadVideo(span, ctx) {
  if (!span || span.classList.contains('is-busy')) return;
  span.classList.add('is-busy');
  const label = span.querySelector('.m-play span');
  if (label) label.textContent = '影片載入中…';
  try {
    const url = await ctx.store.getMediaUrl(ctx.scope, span.dataset.mid);
    const v = makeVideo(url);
    v.autoplay = true;
    span.replaceChildren(v);
    span.classList.add('is-loaded');
    v.play().catch(() => {});
  } catch {
    if (label) label.textContent = '載入失敗，點這裡重試';
  } finally {
    span.classList.remove('is-busy');
  }
}

/** 唯讀顯示（卡片預覽 mode:'preview'、完整內容 mode:'full'） */
export function renderRich(container, html, ctx) {
  container.classList.add('rc');
  container.innerHTML = sanitizeHtml(html);
  container._rcCtx = ctx;
  for (const m of container.querySelectorAll('span.m')) hydrateMedia(m, ctx);
  if (!container._rcBound) {
    container._rcBound = true;
    container.addEventListener('click', e => {
      const play = e.target.closest && e.target.closest('.m-play');
      if (play && container.contains(play)) {
        e.preventDefault();
        e.stopPropagation();
        loadVideo(play.closest('span.m'), container._rcCtx);
      }
    });
  }
}

export function htmlIsEmpty(html) {
  if (!html) return true;
  const t = document.createElement('template');
  t.innerHTML = html;
  return !t.content.querySelector('span.m, hr') && !t.content.textContent.replace(/[\s​ ]+/g, '');
}

// ---------------------------------------------------------------------------
// 游標位置工具
// ---------------------------------------------------------------------------
function caretFromPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (!p || !p.offsetNode) return null;
    const r = document.createRange();
    r.setStart(p.offsetNode, p.offset);
    r.collapse(true);
    return r;
  }
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  return null;
}

function caretRect(r) {
  const rr = r.getClientRects();
  if (rr.length && rr[0].height) return { x: rr[0].left, y: rr[0].top, h: rr[0].height };
  const c = r.startContainer, o = r.startOffset;
  const probe = document.createRange();
  if (c.nodeType === 3) {
    if (o < c.length) { probe.setStart(c, o); probe.setEnd(c, o + 1); const b = probe.getClientRects()[0]; if (b) return { x: b.left, y: b.top, h: b.height }; }
    if (o > 0) { probe.setStart(c, o - 1); probe.setEnd(c, o); const b = probe.getClientRects()[0]; if (b) return { x: b.right, y: b.top, h: b.height }; }
    return null;
  }
  const next = c.childNodes[o], prev = c.childNodes[o - 1];
  const el = next || prev;
  if (el) {
    let b;
    if (el.nodeType === 1) b = el.getBoundingClientRect();
    else { probe.selectNodeContents(el); b = probe.getBoundingClientRect(); }
    return { x: next ? b.left : b.right, y: b.top, h: Math.max(18, Math.min(b.height || 20, 40)) };
  }
  const b = c.getBoundingClientRect();
  return { x: b.left + 4, y: b.top + 4, h: 20 };
}

const closestMedia = node => {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return el && el.closest ? el.closest('span.m') : null;
};

// 以「字數」記錄游標位置（媒體與換行各算 1），復原時用
function measure(root, container, offset) {
  const r = document.createRange();
  r.setStart(root, 0);
  try { r.setEnd(container, offset); } catch { return 0; }
  const frag = r.cloneContents();
  let n = 0;
  const visit = node => {
    if (node.nodeType === 3) { n += node.length; return; }
    if (node.nodeType !== 1) return;
    if (node.matches('span.m') || node.tagName === 'BR') { n += 1; return; }
    node.childNodes.forEach(visit);
  };
  frag.childNodes.forEach(visit);
  return n;
}
function locate(root, target) {
  let n = 0, res = null;
  const idx = node => Array.prototype.indexOf.call(node.parentNode.childNodes, node);
  const visit = node => {
    if (res) return;
    if (node.nodeType === 3) {
      if (n + node.length >= target) { res = [node, target - n]; return; }
      n += node.length;
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.matches('span.m') || node.tagName === 'BR') {
      if (target <= n) { res = [node.parentNode, idx(node)]; return; }
      n += 1;
      if (n === target) res = [node.parentNode, idx(node) + 1];
      return;
    }
    for (const c of node.childNodes) { visit(c); if (res) return; }
  };
  for (const c of root.childNodes) { visit(c); if (res) break; }
  return res || [root, root.childNodes.length];
}
function saveSel(root) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
  return { s: measure(root, r.startContainer, r.startOffset), e: measure(root, r.endContainer, r.endOffset) };
}
function restoreSel(root, saved) {
  const sel = window.getSelection();
  const r = document.createRange();
  if (!saved) { r.selectNodeContents(root); r.collapse(false); }
  else {
    const [sn, so] = locate(root, saved.s);
    const [en, eo] = locate(root, saved.e);
    try { r.setStart(sn, so); r.setEnd(en, eo); } catch { r.selectNodeContents(root); r.collapse(false); }
  }
  sel.removeAllRanges();
  sel.addRange(r);
}

// ---------------------------------------------------------------------------
// 復原 / 重做
// ---------------------------------------------------------------------------
class Undo {
  constructor(ed) { this.ed = ed; this.stack = []; this.i = -1; this.t = null; }
  snap() { return { html: sanitizeHtml(this.ed.area.innerHTML, { lastPx: this.ed.lastFontPx }), sel: saveSel(this.ed.area) }; }
  reset() { clearTimeout(this.t); this.t = null; this.stack = [this.snap()]; this.i = 0; }
  record() {
    clearTimeout(this.t); this.t = null;
    const s = this.snap();
    const cur = this.stack[this.i];
    if (cur && cur.html === s.html) { cur.sel = s.sel; return; }
    this.stack.length = this.i + 1;
    this.stack.push(s);
    if (this.stack.length > 120) this.stack.shift();
    this.i = this.stack.length - 1;
  }
  soon() { clearTimeout(this.t); this.t = setTimeout(() => this.record(), 450); }
  flush() { if (this.t) this.record(); }
  undo() { this.flush(); if (this.i <= 0) return; this.i--; this.apply(this.stack[this.i]); }
  redo() { if (this.i >= this.stack.length - 1) return; this.i++; this.apply(this.stack[this.i]); }
  apply(s) {
    const ed = this.ed;
    ed.deselect();
    ed.area.innerHTML = s.html;
    ed.hydrateAll();
    ed.ensureBlock();
    ed.area.focus({ preventScroll: true });
    restoreSel(ed.area, s.sel);
    ed.updatePlaceholder();
    ed.onChange();
  }
}

// ---------------------------------------------------------------------------
// 編輯器
// ---------------------------------------------------------------------------
const TEXT_COLORS = [['墨黑', '#1a2736'], ['朱紅', '#c23a2c'], ['橘', '#d4691c'], ['金黃', '#b88a00'], ['綠', '#2f8a4c'], ['青', '#13879b'], ['藍', '#2459c4'], ['紫', '#7a3fb8'], ['粉', '#c43d84'], ['灰', '#7b8794']];
const HIGHLIGHTS = [['黃', '#fff1a0'], ['綠', '#c8f0c4'], ['藍', '#cfe5ff'], ['粉', '#ffd5e1'], ['橘', '#ffdfb6'], ['無', 'transparent']];
const SIZES = [['小', '13px'], ['標準', '16px'], ['大', '20px'], ['特大', '26px'], ['超大', '34px']];

let editorCount = 0;

export class RichEditor {
  /**
   * @param {object} o
   *   store, scope, settings, placeholder, onChange
   */
  constructor(o) {
    this.store = o.store;
    this.scope = o.scope;
    this.settings = o.settings;
    this.onChange = o.onChange || (() => {});
    this.pending = new Map();
    this.known = new Set();
    this.selMedia = null;
    this.lastRange = null;
    this.lastFontPx = null;
    this.uid = ++editorCount;
    this.jobs = 0;            // 正在處理中的圖片/影片數量
    this.idleWaiters = [];
    this.destroyed = false;

    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* 舊瀏覽器 */ }

    this.area = h('div', {
      class: 'rc ed-area', contenteditable: 'true', spellcheck: 'false', role: 'textbox',
      'aria-multiline': 'true', 'aria-label': '內容', 'data-placeholder': o.placeholder || '在這裡輸入內容'
    });
    this.mbar = this.buildMediaBar();
    this.dropLine = h('div', { class: 'ed-dropline', hidden: true });
    this.scroller = h('div', { class: 'ed-scroll' }, this.area, this.mbar, this.dropLine);
    this.fileImage = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    this.fileVideo = h('input', { type: 'file', accept: 'video/mp4,video/webm,video/quicktime,.mp4,.m4v,.webm,.mov', multiple: true, hidden: true });
    this.toolbar = this.buildToolbar();
    this.el = h('div', { class: 'ed' }, this.toolbar, this.scroller, this.fileImage, this.fileVideo);
    this.history = new Undo(this);
    this.bind();
  }

  ctx() {
    return {
      store: this.store, scope: this.scope, mode: 'edit',
      localUrl: mid => (this.pending.get(mid) || {}).url || null
    };
  }

  // ---------- 內容 ----------
  setHtml(html) {
    this.deselect();
    this.area.innerHTML = sanitizeHtml(html);
    this.known = new Set([...this.area.querySelectorAll('span.m')].map(m => m.dataset.mid));
    for (const k of this.pending.keys()) this.known.add(k);
    this.hydrateAll();
    this.ensureBlock();
    this.history.reset();
    this.updatePlaceholder();
  }

  /** 換掉整份內容（可以用「復原」回到換之前） */
  replaceHtml(html) {
    this.history.flush();
    this.deselect();
    this.area.innerHTML = sanitizeHtml(html);
    for (const m of this.area.querySelectorAll('span.m')) this.known.add(m.dataset.mid);
    this.hydrateAll();
    this.ensureBlock();
    this.changed();
  }

  getHtml() {
    this.normalizeFonts();
    return serialize(this.area, this.lastFontPx);
  }

  hydrateAll() {
    const ctx = this.ctx();
    for (const m of this.area.querySelectorAll('span.m')) hydrateMedia(m, ctx);
  }

  ensureBlock() {
    if (!this.area.firstChild || (!this.area.querySelector('span.m, hr, br, li') && !this.area.textContent.trim() && !this.area.querySelector('p'))) {
      this.area.innerHTML = '<p><br></p>';
    }
  }

  isEmpty() {
    return !this.area.querySelector('span.m, hr, li') && !this.area.textContent.replace(/[\s​ ]+/g, '');
  }

  updatePlaceholder() { this.area.classList.toggle('is-empty', this.isEmpty()); }

  /** 存檔成功後：已上傳的媒體不再算「待上傳」 */
  markSaved(refs) {
    for (const mid of [...this.pending.keys()]) if (refs.has(mid)) this.pending.delete(mid);
  }

  /** 等所有正在處理的圖片、影片都插好（存檔前呼叫） */
  whenIdle() {
    return this.jobs ? new Promise(r => this.idleWaiters.push(r)) : Promise.resolve();
  }

  beginJob() { this.jobs++; }
  endJob() {
    this.jobs = Math.max(0, this.jobs - 1);
    if (!this.jobs) { const w = this.idleWaiters; this.idleWaiters = []; w.forEach(f => f()); }
  }

  destroy() {
    this.destroyed = true;
    document.removeEventListener('selectionchange', this._onSel);
    if (this._ro) this._ro.disconnect();
    for (const m of this.pending.values()) if (m.url) URL.revokeObjectURL(m.url);
    this.pending.clear();
    this.closePop();
  }

  focus() { this.area.focus({ preventScroll: true }); }

  changed(record = true) {
    if (record) this.history.record();
    this.updatePlaceholder();
    this.onChange();
  }

  // ---------- 工具列 ----------
  buildToolbar() {
    const btn = (name, title, fn, cls = '') => {
      const b = h('button', { type: 'button', class: 'tb ' + cls, title, 'aria-label': title, html: icon(name) });
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', () => fn(b));
      return b;
    };
    const sep = () => h('span', { class: 'tb-sep', 'aria-hidden': 'true' });

    const size = h('select', { class: 'tb-size', title: '字級', 'aria-label': '字級', id: `ed-size-${this.uid}` },
      h('option', { value: '', text: '字級' }),
      SIZES.map(([lbl, px]) => h('option', { value: px, text: `${lbl}` })));
    size.addEventListener('change', () => { const v = size.value; size.value = ''; if (v) this.applyFontSize(v); });

    const colorBtn = h('button', { type: 'button', class: 'tb tb-color', title: '文字顏色', 'aria-label': '文字顏色', html: '<span class="tb-a">A</span><span class="tb-bar"></span>' });
    colorBtn.addEventListener('mousedown', e => e.preventDefault());
    colorBtn.addEventListener('click', () => this.openPalette(colorBtn, TEXT_COLORS, c => this.exec('foreColor', c)));

    const hlBtn = btn('highlight', '螢光標記', b => this.openPalette(b, HIGHLIGHTS, c => this.highlight(c)));

    this.btnUndo = btn('undo', '復原（Ctrl+Z）', () => this.history.undo());
    this.btnRedo = btn('redo', '重做（Ctrl+Y）', () => this.history.redo());

    return h('div', { class: 'ed-toolbar', role: 'toolbar', 'aria-label': '內容編輯工具' },
      h('div', { class: 'tb-group' }, this.btnUndo, this.btnRedo),
      sep(),
      h('div', { class: 'tb-group' }, size),
      sep(),
      h('div', { class: 'tb-group' },
        btn('bold', '粗體（Ctrl+B）', () => this.exec('bold')),
        btn('italic', '斜體（Ctrl+I）', () => this.exec('italic')),
        btn('underline', '底線（Ctrl+U）', () => this.exec('underline')),
        btn('strike', '刪除線', () => this.exec('strikeThrough')),
        colorBtn, hlBtn),
      sep(),
      h('div', { class: 'tb-group' },
        btn('alignLeft', '靠左', () => this.exec('justifyLeft')),
        btn('alignCenter', '置中', () => this.exec('justifyCenter')),
        btn('alignRight', '靠右', () => this.exec('justifyRight')),
        btn('list', '項目符號', () => this.exec('insertUnorderedList')),
        btn('listNum', '編號清單', () => this.exec('insertOrderedList'))),
      sep(),
      h('div', { class: 'tb-group tb-insert' },
        this.labeled('image', '圖片/GIF', () => this.pickFile(this.fileImage)),
        this.labeled('video', '影片', () => this.pickFile(this.fileVideo)),
        this.labeled('pen', '手繪', () => this.draw())),
      sep(),
      btn('clearFormat', '清除格式', () => this.exec('removeFormat'))
    );
  }

  labeled(name, text, fn) {
    const b = h('button', { type: 'button', class: 'tb tb-label', title: `插入${text}`, html: icon(name) }, h('span', { text }));
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', fn);
    return b;
  }

  openPalette(anchor, colors, apply) {
    if (this.pop && this.pop._anchor === anchor) { this.closePop(); return; }
    this.closePop();
    const range = this.lastRange ? this.lastRange.cloneRange() : null;
    const pop = h('div', { class: 'tb-pop', role: 'menu' },
      colors.map(([name, c]) => {
        const sw = h('button', { type: 'button', class: 'sw' + (c === 'transparent' ? ' sw-none' : ''), title: name, 'aria-label': name, style: { '--c': c } });
        sw.addEventListener('mousedown', e => e.preventDefault());
        sw.addEventListener('click', () => {
          this.closePop();
          if (range) { const s = getSelection(); s.removeAllRanges(); s.addRange(range); this.lastRange = range; }
          apply(c);
        });
        return sw;
      }));
    pop._anchor = anchor;
    this.el.append(pop);
    const er = this.el.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    pop.style.left = clamp(ar.left - er.left, 4, Math.max(4, er.width - 230)) + 'px';
    pop.style.top = (ar.bottom - er.top + 4) + 'px';
    this.pop = pop;
    this._popOutside = e => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) this.closePop(); };
    setTimeout(() => document.addEventListener('pointerdown', this._popOutside), 0);
  }

  closePop() {
    if (this.pop) { this.pop.remove(); this.pop = null; }
    if (this._popOutside) { document.removeEventListener('pointerdown', this._popOutside); this._popOutside = null; }
  }

  hasRangeInArea() {
    const sel = getSelection();
    return sel.rangeCount > 0 && this.area.contains(sel.getRangeAt(0).commonAncestorContainer);
  }

  restoreRange() {
    const sel = getSelection();
    if (this.hasRangeInArea()) return;
    this.area.focus({ preventScroll: true });
    let r = this.lastRange && this.area.contains(this.lastRange.commonAncestorContainer) ? this.lastRange : null;
    if (!r) { r = document.createRange(); r.selectNodeContents(this.area); r.collapse(false); }
    sel.removeAllRanges();
    sel.addRange(r);
  }

  exec(cmd, val = null) {
    this.history.flush();
    this.deselect();
    this.restoreRange();
    try { document.execCommand('styleWithCSS', false, false); } catch { /* ignore */ }
    document.execCommand(cmd, false, val);
    this.afterCommand();
  }

  highlight(color) {
    this.history.flush();
    this.restoreRange();
    try { document.execCommand('styleWithCSS', false, true); } catch { /* ignore */ }
    if (!document.execCommand('hiliteColor', false, color)) document.execCommand('backColor', false, color);
    try { document.execCommand('styleWithCSS', false, false); } catch { /* ignore */ }
    this.afterCommand();
  }

  applyFontSize(px) {
    this.history.flush();
    this.normalizeFonts();   // 先把之前的字級固定下來
    this.lastFontPx = px;
    this.area.style.setProperty('--ed-last-size', px);
    this.restoreRange();
    try { document.execCommand('styleWithCSS', false, false); } catch { /* ignore */ }
    document.execCommand('fontSize', false, '7');
    for (const s of this.area.querySelectorAll('span[style*="xxx-large"]')) s.style.fontSize = px;
    this.afterCommand();
  }

  normalizeFonts() {
    const fonts = this.area.querySelectorAll('font');
    if (!fonts.length) return;
    const saved = saveSel(this.area);
    for (const f of fonts) fontToSpan(f, this.lastFontPx);
    if (saved && document.activeElement === this.area) restoreSel(this.area, saved);
  }

  afterCommand() {
    this.normalizeFonts();
    this.changed();
  }

  pickFile(input) {
    this.history.flush();
    this.insertRange = this.lastRange ? this.lastRange.cloneRange() : null;
    input.value = '';
    input.click();
  }

  // ---------- 媒體 ----------
  async insertFiles(files, range) {
    this.beginJob();
    try {
      await this._insertFiles(files, range);
    } finally { this.endJob(); }
  }

  async _insertFiles(files, range) {
    for (const file of files) {
      if (this.destroyed) return;
      const kind = kindOf(file);
      if (!kind) { toast(`不支援「${file.name}」這種檔案`, 'warn'); continue; }
      const busy = busyBox(kind === 'video' ? '正在處理影片…' : '正在處理圖片…');
      let m;
      try {
        if (kind === 'video') m = await processVideo(file, this.settings);
        else if (kind === 'gif') m = await processGif(file, this.settings);
        else m = await processImage(file, { maxSide: this.settings.imageMaxSide });
      } catch (err) {
        busy.close();
        await alertBox(err.message || String(err), { title: '無法插入' });
        continue;
      }
      busy.close();
      this.addMedia(m, { range });
      range = null;
    }
  }

  addMedia(m, { range = null, float = null, width = null } = {}) {
    if (this.destroyed) return null; // 視窗已經關掉了
    const mid = makeId();
    m.url = URL.createObjectURL(m.blob);
    this.pending.set(mid, m);
    this.known.add(mid);
    const areaW = Math.max(200, this.contentWidth(this.area));
    const natural = (m.w / areaW) * 100;
    const fl = float || (m.drawing ? 'f-center' : 'f-left');
    const w = width || clamp(Math.round(m.drawing ? Math.min(100, natural) : Math.min(45, natural)), 10, 100);
    const span = h('span', { class: `m ${fl}`, 'data-mid': mid, 'data-type': m.type, 'data-ar': (m.w && m.h ? m.w / m.h : 1.5).toFixed(3) });
    span.style.width = w + '%';
    this.history.flush();
    this.insertNodeAtCaret(span, range);
    hydrateMedia(span, this.ctx());
    this.selectMedia(span);
    this.changed();
    return span;
  }

  insertNodeAtCaret(node, range) {
    const sel = getSelection();
    let r = range && this.area.contains(range.commonAncestorContainer) ? range : null;
    if (!r) {
      this.restoreRange();
      r = sel.rangeCount ? sel.getRangeAt(0) : null;
    }
    if (!r || !this.area.contains(r.commonAncestorContainer)) { r = document.createRange(); r.selectNodeContents(this.area); r.collapse(false); }
    const inside = closestMedia(r.startContainer);
    if (inside && this.area.contains(inside)) { r = document.createRange(); r.setStartAfter(inside); r.collapse(true); }
    if (!r.collapsed) { r = r.cloneRange(); r.collapse(false); } // 有選取文字時插在後面，不會吃掉文字
    // 游標直接在編輯區最外層時，包進段落裡
    if (r.startContainer === this.area) {
      const p = h('p');
      r.insertNode(p);
      p.append(node);
    } else {
      r.insertNode(node);
    }
    const after = document.createRange();
    after.setStartAfter(node);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    this.lastRange = after.cloneRange();
  }

  contentWidth(el) {
    const cs = getComputedStyle(el);
    return el.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
  }

  /** 媒體寬度百分比的基準：最近的區塊元素（段落、清單項目或整個編輯區） */
  blockWidth(m) {
    let el = m.parentElement;
    while (el && el !== this.area && getComputedStyle(el).display.startsWith('inline')) el = el.parentElement;
    return Math.max(50, this.contentWidth(el || this.area));
  }

  buildMediaBar() {
    const b = (name, title, fn, extra = {}) => {
      const el = h('button', { type: 'button', class: 'mb', title, 'aria-label': title, html: icon(name), ...extra });
      el.addEventListener('mousedown', e => e.preventDefault());
      if (fn) el.addEventListener('click', fn);
      return el;
    };
    this.mbFloat = {
      'f-left': b('floatLeft', '靠左，文字繞在右邊', () => this.setFloat('f-left')),
      'f-center': b('floatCenter', '置中，不繞圖', () => this.setFloat('f-center')),
      'f-right': b('floatRight', '靠右，文字繞在左邊', () => this.setFloat('f-right')),
      'f-inline': b('inline', '跟文字排在同一行', () => this.setFloat('f-inline'))
    };
    this.mbSize = h('span', { class: 'mb-size', text: '45%' });
    this.mbAnnotate = b('pen', '在圖片上手繪標註', () => this.annotate());
    const moveBtn = b('move', '按住拖曳到想放的位置', null, { class: 'mb mb-move' });
    moveBtn.addEventListener('pointerdown', e => this.startMove(e));
    const bar = h('div', { class: 'ed-mbar', hidden: true, role: 'toolbar', 'aria-label': '媒體設定' },
      Object.values(this.mbFloat),
      h('span', { class: 'tb-sep' }),
      b('minus', '縮小', () => this.resizeBy(-10)), this.mbSize, b('plus', '放大', () => this.resizeBy(10)),
      h('span', { class: 'tb-sep' }),
      moveBtn, this.mbAnnotate,
      h('span', { class: 'tb-sep' }),
      b('trash', '刪除', () => this.selMedia && this.removeMedia(this.selMedia), { class: 'mb mb-del' }));
    return bar;
  }

  selectMedia(m) {
    if (this.selMedia && this.selMedia !== m) this.deselect();
    this.selMedia = m;
    m.classList.add('sel');
    if (!m.querySelector('.m-handle')) m.append(h('span', { class: 'm-handle', title: '拖曳調整大小' }));
    this.updateMediaBar();
    this.placeMediaBar();
  }

  deselect() {
    if (this.selMedia) {
      this.selMedia.classList.remove('sel');
      const hd = this.selMedia.querySelector('.m-handle');
      if (hd) hd.remove();
    }
    this.selMedia = null;
    this.mbar.hidden = true;
  }

  updateMediaBar() {
    const m = this.selMedia;
    if (!m) return;
    for (const [f, el] of Object.entries(this.mbFloat)) el.classList.toggle('on', m.classList.contains(f));
    this.mbSize.textContent = Math.round(parseFloat(m.style.width) || 0) + '%';
    this.mbAnnotate.hidden = m.dataset.type !== 'image';
  }

  placeMediaBar() {
    const m = this.selMedia;
    if (!m || !m.isConnected) { this.mbar.hidden = true; return; }
    this.mbar.hidden = false;
    const sc = this.scroller;
    const sr = sc.getBoundingClientRect(), mr = m.getBoundingClientRect();
    const bh = this.mbar.offsetHeight, bw = this.mbar.offsetWidth;
    let top = mr.top - sr.top + sc.scrollTop - bh - 6;
    if (top < sc.scrollTop + 2) top = Math.min(mr.bottom - sr.top + sc.scrollTop + 6, sc.scrollTop + sc.clientHeight - bh - 4);
    let left = mr.left - sr.left + sc.scrollLeft;
    left = clamp(left, 4, Math.max(4, sc.clientWidth - bw - 4));
    this.mbar.style.top = Math.max(2, top) + 'px';
    this.mbar.style.left = left + 'px';
  }

  setFloat(fl) {
    const m = this.selMedia;
    if (!m) return;
    this.history.flush();
    for (const f of FLOATS) m.classList.remove(f);
    m.classList.add(fl);
    this.updateMediaBar();
    requestAnimationFrame(() => this.placeMediaBar());
    this.changed();
  }

  resizeBy(d) {
    const m = this.selMedia;
    if (!m) return;
    this.history.flush();
    const cur = parseFloat(m.style.width) || 40;
    m.style.width = clamp(Math.round(cur / 5) * 5 + d, 10, 100) + '%';
    this.updateMediaBar();
    requestAnimationFrame(() => this.placeMediaBar());
    this.changed();
  }

  startResize(e, m) {
    e.preventDefault();
    e.stopPropagation();
    this.history.flush();
    const handle = e.target;
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const cw = this.blockWidth(m);
    const startX = e.clientX;
    const startW = m.getBoundingClientRect().width;
    const factor = m.classList.contains('f-center') ? 2 : (m.classList.contains('f-right') ? -1 : 1);
    const move = ev => {
      const w = startW + (ev.clientX - startX) * factor;
      m.style.width = clamp((w / cw) * 100, 8, 100).toFixed(1) + '%';
      this.updateMediaBar();
      this.placeMediaBar();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      this.changed();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  startMove(e) {
    const m = this.selMedia;
    if (!m) return;
    e.preventDefault();
    const btn = e.currentTarget;
    try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    m.classList.add('moving');
    this.mbar.classList.add('ghost');
    let target = null;
    const sc = this.scroller;
    const move = ev => {
      const sr = sc.getBoundingClientRect();
      if (ev.clientY < sr.top + 36) sc.scrollTop -= 14;
      else if (ev.clientY > sr.bottom - 36) sc.scrollTop += 14;
      const r = caretFromPoint(ev.clientX, ev.clientY);
      if (r && this.area.contains(r.startContainer) && !m.contains(r.startContainer) && !closestMedia(r.startContainer)) {
        target = r;
        const rect = caretRect(r);
        if (rect) {
          Object.assign(this.dropLine.style, {
            left: (rect.x - sr.left + sc.scrollLeft - 1) + 'px',
            top: (rect.y - sr.top + sc.scrollTop) + 'px',
            height: rect.h + 'px'
          });
          this.dropLine.hidden = false;
        }
      } else {
        target = null;
        this.dropLine.hidden = true;
      }
    };
    const up = () => {
      btn.removeEventListener('pointermove', move);
      btn.removeEventListener('pointerup', up);
      btn.removeEventListener('pointercancel', up);
      m.classList.remove('moving');
      this.mbar.classList.remove('ghost');
      this.dropLine.hidden = true;
      if (target) {
        this.history.flush();
        if (target.startContainer === this.area) { const p = h('p'); target.insertNode(p); p.append(m); }
        else target.insertNode(m);
        this.selectMedia(m);
        this.changed();
      } else {
        this.placeMediaBar();
      }
    };
    btn.addEventListener('pointermove', move);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
  }

  removeMedia(m) {
    this.history.flush();
    const r = document.createRange();
    r.setStartBefore(m);
    r.collapse(true);
    this.deselect();
    m.remove();
    this.area.focus({ preventScroll: true });
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    this.ensureBlock();
    this.changed();
  }

  async draw() {
    this.history.flush();
    const range = this.lastRange ? this.lastRange.cloneRange() : null;
    const canvas = await openDrawPad({ title: '手繪' });
    if (!canvas) return;
    this.beginJob();
    try {
      const media = await processCanvas(canvas, { alpha: canvas._alpha !== false });
      media.drawing = true;
      this.addMedia(media, { range });
    } finally { this.endJob(); }
  }

  async annotate() {
    const m = this.selMedia;
    if (!m || m.dataset.type !== 'image') return;
    const mid = m.dataset.mid;
    let url = (this.pending.get(mid) || {}).url;
    if (!url) {
      const busy = busyBox('載入圖片中…');
      try { url = await this.store.getMediaUrl(this.scope, mid); }
      catch { busy.close(); await alertBox('這張圖片還沒載入成功，請稍後再試。'); return; }
      busy.close();
    }
    const canvas = await openDrawPad({ title: '在圖片上手繪', bgUrl: url });
    if (!canvas || !m.isConnected) return;
    this.beginJob();
    let media;
    try { media = await processCanvas(canvas, { alpha: true }); } finally { this.endJob(); }
    if (this.destroyed || !m.isConnected) return;
    const newMid = makeId();
    media.url = URL.createObjectURL(media.blob);
    this.pending.set(newMid, media);
    this.known.add(newMid);
    this.history.flush();
    m.dataset.mid = newMid;
    m.dataset.ar = (media.w / media.h).toFixed(3);
    hydrateMedia(m, this.ctx());
    this.selectMedia(m);
    this.changed();
  }

  // ---------- 事件 ----------
  bind() {
    const a = this.area;
    this._onSel = () => {
      const sel = getSelection();
      if (!sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      if (a.contains(r.commonAncestorContainer)) this.lastRange = r.cloneRange();
    };
    document.addEventListener('selectionchange', this._onSel);

    a.addEventListener('input', () => { this.history.soon(); this.updatePlaceholder(); this.onChange(); if (this.selMedia) this.placeMediaBar(); });
    a.addEventListener('beforeinput', e => {
      if (e.inputType === 'historyUndo') { e.preventDefault(); this.history.undo(); }
      else if (e.inputType === 'historyRedo') { e.preventDefault(); this.history.redo(); }
    });
    a.addEventListener('keydown', e => this.onKeyDown(e));
    a.addEventListener('click', e => this.onClick(e));
    a.addEventListener('pointerdown', e => {
      const hd = e.target.closest && e.target.closest('.m-handle');
      if (hd && a.contains(hd)) this.startResize(e, hd.closest('span.m'));
    });
    a.addEventListener('paste', e => this.onPaste(e));
    a.addEventListener('dragstart', e => {
      if (closestMedia(e.target)) { e.preventDefault(); return; }
      this.dragInternal = true;
    });
    a.addEventListener('dragend', () => { this.dragInternal = false; });
    a.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    a.addEventListener('drop', e => this.onDrop(e));
    this.fileImage.addEventListener('change', () => { const f = [...this.fileImage.files]; if (f.length) this.insertFiles(f, this.insertRange); });
    this.fileVideo.addEventListener('change', () => { const f = [...this.fileVideo.files]; if (f.length) this.insertFiles(f, this.insertRange); });
    this.scroller.addEventListener('scroll', () => { if (this.pop) this.closePop(); });
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => { if (this.selMedia) this.placeMediaBar(); });
      this._ro.observe(this.area);
    }
  }

  onKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey;
    const k = (e.key || '').toLowerCase();
    if (mod && !e.altKey && k === 'z') { e.preventDefault(); if (e.shiftKey) this.history.redo(); else this.history.undo(); return; }
    if (mod && !e.altKey && k === 'y') { e.preventDefault(); this.history.redo(); return; }
    if (this.selMedia) {
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); this.removeMedia(this.selMedia); return; }
      if (e.key === 'Escape') { e.stopPropagation(); this.deselect(); return; }
      if (!mod) this.deselect();
    }
    if (mod && ['b', 'i', 'u'].includes(k)) {
      this.history.flush();
      setTimeout(() => this.afterCommand(), 0);
    }
  }

  onClick(e) {
    const play = e.target.closest && e.target.closest('.m-play');
    if (play && this.area.contains(play)) {
      e.preventDefault();
      loadVideo(play.closest('span.m'), this.ctx());
      return;
    }
    const m = closestMedia(e.target);
    if (m && this.area.contains(m)) {
      if (e.target.closest('.m-handle')) return;
      this.selectMedia(m);
      const r = document.createRange();
      r.setStartAfter(m);
      r.collapse(true);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    this.deselect();
  }

  onPaste(e) {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...(dt.files || [])].filter(f => kindOf(f));
    if (files.length) {
      e.preventDefault();
      this.insertFiles(files);
      return;
    }
    const html = dt.getData('text/html');
    if (html) {
      e.preventDefault();
      this.history.flush();
      const opts = { allowMid: mid => this.known.has(mid), lastPx: this.lastFontPx };
      const clean = sanitizeHtml(html, opts);
      if (clean) document.execCommand('insertHTML', false, clean);
      for (const m of this.area.querySelectorAll('span.m')) if (!m.firstChild) hydrateMedia(m, this.ctx());
      if (opts.droppedImg) toast('網頁上的圖片不會跟著貼上，請用「圖片/GIF」按鈕上傳', 'warn');
      this.afterCommand();
    }
  }

  onDrop(e) {
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = [...(dt.files || [])].filter(f => kindOf(f));
    if (files.length) {
      e.preventDefault();
      const r = caretFromPoint(e.clientX, e.clientY);
      this.insertFiles(files, r && this.area.contains(r.startContainer) && !closestMedia(r.startContainer) ? r : null);
      return;
    }
    if (this.dragInternal) return; // 編輯區內移動文字：交給瀏覽器
    e.preventDefault();
    const r = caretFromPoint(e.clientX, e.clientY);
    if (r && this.area.contains(r.startContainer)) {
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } else this.restoreRange();
    this.history.flush();
    const html = dt.getData('text/html');
    if (html) {
      const clean = sanitizeHtml(html, { allowMid: () => false });
      if (clean) document.execCommand('insertHTML', false, clean);
    } else {
      const text = dt.getData('text/plain');
      if (text) document.execCommand('insertText', false, text);
    }
    this.afterCommand();
  }
}
