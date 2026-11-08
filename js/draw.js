// 手繪板：畫筆、螢光筆、直線、箭頭、方框、圓形、橡皮擦；可以畫在空白處或圖片上
import { h, clamp } from './util.js';
import { icon } from './icons.js';
import { openLayer, alertBox, confirmBox } from './ui.js';
import { loadImage } from './media.js';

const COLORS = ['#1a2736', '#ffffff', '#c23a2c', '#e8792b', '#f2c230', '#2f8a4c', '#13879b', '#2459c4', '#7a3fb8', '#e05a9c'];
const SIZES = [2, 4, 8, 14, 24];
const TOOLS = [
  ['pen', 'pen', '畫筆'], ['marker', 'marker', '螢光筆'], ['line', 'line', '直線'], ['arrow', 'arrow', '箭頭'],
  ['rect', 'rect', '方框'], ['ellipse', 'ellipse', '圓形'], ['eraser', 'eraser', '橡皮擦']
];

function drawStroke(ctx, s) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.size;
  if (s.tool === 'marker') { ctx.globalAlpha = 0.35; ctx.lineWidth = s.size * 2.6; ctx.lineCap = 'butt'; }
  if (s.tool === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = '#000'; ctx.lineWidth = s.size * 2.2; }
  const p = s.points;
  if (s.tool === 'pen' || s.tool === 'marker' || s.tool === 'eraser') {
    ctx.beginPath();
    if (p.length === 1) {
      ctx.arc(p[0][0], p[0][1], ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    } else {
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length - 1; i++) {
        const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
        ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
      }
      const last = p[p.length - 1];
      ctx.lineTo(last[0], last[1]);
      ctx.stroke();
    }
  } else if (p.length >= 2) {
    const [x1, y1] = p[0], [x2, y2] = p[p.length - 1];
    ctx.beginPath();
    if (s.tool === 'line' || s.tool === 'arrow') {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      if (s.tool === 'arrow') {
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const len = Math.max(12, s.size * 4);
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - len * Math.cos(ang - 0.45), y2 - len * Math.sin(ang - 0.45));
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - len * Math.cos(ang + 0.45), y2 - len * Math.sin(ang + 0.45));
      }
    } else if (s.tool === 'rect') {
      ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (s.tool === 'ellipse') {
      ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function inkBounds(canvas) {
  const { width: w, height: hgt } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, w, hgt).data;
  let minX = w, minY = hgt, maxX = -1, maxY = -1;
  for (let y = 0; y < hgt; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * 開啟手繪板
 * @returns {Promise<HTMLCanvasElement|null>} 完成時回傳畫好的畫布，取消回傳 null
 */
export function openDrawPad({ title = '手繪', bgUrl = null } = {}) {
  return new Promise(async resolve => {
    let bgImg = null;
    if (bgUrl) {
      try { bgImg = await loadImage(bgUrl); } catch { await alertBox('圖片載入失敗，無法標註。'); resolve(null); return; }
    }

    // 畫布實際解析度
    let W, H;
    if (bgImg) {
      const s = Math.min(1, 1600 / Math.max(bgImg.naturalWidth, bgImg.naturalHeight));
      W = Math.round(bgImg.naturalWidth * s);
      H = Math.round(bgImg.naturalHeight * s);
    } else {
      const portrait = window.innerHeight > window.innerWidth * 1.15;
      W = portrait ? 900 : 1200;
      H = portrait ? 1200 : 760;
    }

    const state = { tool: 'pen', color: COLORS[2], size: SIZES[1], whiteBg: false, strokes: [], cur: null };
    const bg = h('canvas', { class: 'dp-bg', width: W, height: H });
    const ink = h('canvas', { class: 'dp-ink', width: W, height: H });
    const live = h('canvas', { class: 'dp-live', width: W, height: H });
    const stage = h('div', { class: 'dp-stage' + (bgImg ? '' : ' checker') }, bg, ink, live);
    const stageWrap = h('div', { class: 'dp-wrap' }, stage);
    const bctx = bg.getContext('2d'), ictx = ink.getContext('2d'), lctx = live.getContext('2d');

    const paintBg = () => {
      bctx.clearRect(0, 0, W, H);
      if (bgImg) bctx.drawImage(bgImg, 0, 0, W, H);
      else if (state.whiteBg) { bctx.fillStyle = '#ffffff'; bctx.fillRect(0, 0, W, H); }
      stage.classList.toggle('checker', !bgImg && !state.whiteBg);
    };
    const redraw = () => {
      ictx.clearRect(0, 0, W, H);
      for (const s of state.strokes) {
        if (s.tool === 'clear') ictx.clearRect(0, 0, W, H);
        else drawStroke(ictx, s);
      }
    };

    // ---- 工具列 ----
    const toolBtns = TOOLS.map(([key, ic, label]) => {
      const b = h('button', { type: 'button', class: 'dp-tool', title: label, 'aria-label': label, 'aria-pressed': 'false', html: icon(ic) }, h('span', { text: label }));
      b.addEventListener('click', () => { state.tool = key; sync(); });
      b._key = key;
      return b;
    });
    const colorBtns = COLORS.map(c => {
      const b = h('button', { type: 'button', class: 'dp-color', title: c, 'aria-label': '顏色 ' + c, style: { '--c': c } });
      b.addEventListener('click', () => { state.color = c; sync(); });
      b._c = c;
      return b;
    });
    const custom = h('input', { type: 'color', class: 'dp-custom', title: '自訂顏色', 'aria-label': '自訂顏色', value: '#2459c4' });
    custom.addEventListener('input', () => { state.color = custom.value; sync(); });
    const sizeBtns = SIZES.map(s => {
      const b = h('button', { type: 'button', class: 'dp-size', title: `粗細 ${s}`, 'aria-label': `粗細 ${s}`, style: { '--s': Math.min(18, s + 2) + 'px' } }, h('i'));
      b.addEventListener('click', () => { state.size = s; sync(); });
      b._s = s;
      return b;
    });
    const undoBtn = h('button', { type: 'button', class: 'btn', html: icon('undo') + '<span>復原</span>' });
    undoBtn.addEventListener('click', () => { state.strokes.pop(); redraw(); sync(); });
    const clearBtn = h('button', { type: 'button', class: 'btn', html: icon('trash') + '<span>清除</span>' });
    clearBtn.addEventListener('click', () => {
      if (!state.strokes.length) return;
      state.strokes.push({ tool: 'clear' });
      redraw();
      sync();
    });
    const bgToggle = h('label', { class: 'dp-bgtoggle' + (bgImg ? ' hidden' : '') },
      h('input', { type: 'checkbox', id: 'dp-whitebg' }), h('span', { text: '白色底' }));
    bgToggle.querySelector('input').addEventListener('change', e => { state.whiteBg = e.target.checked; paintBg(); });

    const sync = () => {
      for (const b of toolBtns) { const on = b._key === state.tool; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
      for (const b of colorBtns) b.classList.toggle('on', b._c === state.color);
      for (const b of sizeBtns) b.classList.toggle('on', b._s === state.size);
      undoBtn.disabled = !state.strokes.length;
      stage.dataset.tool = state.tool;
    };

    const cancelBtn = h('button', { type: 'button', class: 'btn', text: '取消' });
    const doneBtn = h('button', { type: 'button', class: 'btn primary', html: icon('check') + '<span>完成並插入</span>' });
    const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '關閉', html: icon('x') });

    const panel = h('div', { class: 'panel drawpad', role: 'dialog', 'aria-label': title },
      h('div', { class: 'dp-head' }, h('div', { class: 'dp-title', text: title }), closeBtn),
      h('div', { class: 'dp-bar' },
        h('div', { class: 'dp-tools' }, toolBtns),
        h('div', { class: 'dp-colors' }, colorBtns, custom),
        h('div', { class: 'dp-sizes' }, sizeBtns),
        h('div', { class: 'dp-actions' }, undoBtn, clearBtn, bgToggle)),
      stageWrap,
      h('div', { class: 'dp-foot' }, h('span', { class: 'dp-hint', text: bgImg ? '直接在圖片上畫，完成後會取代原本的圖片。' : '畫好後會插入到游標位置，之後可以調整大小和文繞圖。' }), h('div', { class: 'dp-foot-btns' }, cancelBtn, doneBtn))
    );

    // ---- 畫布大小（依畫面縮放顯示） ----
    const fit = () => {
      const avW = stageWrap.clientWidth - 2, avH = stageWrap.clientHeight - 2;
      if (avW <= 0 || avH <= 0) return;
      const s = Math.min(avW / W, avH / H);
      stage.style.width = Math.floor(W * s) + 'px';
      stage.style.height = Math.floor(H * s) + 'px';
    };

    // ---- 繪圖 ----
    const toXY = e => {
      const r = live.getBoundingClientRect();
      return [clamp((e.clientX - r.left) * (W / r.width), 0, W), clamp((e.clientY - r.top) * (H / r.height), 0, H)];
    };
    const scale = () => W / Math.max(1, live.getBoundingClientRect().width);
    let pointerId = null;
    live.addEventListener('pointerdown', e => {
      if (pointerId !== null) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      pointerId = e.pointerId;
      try { live.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      state.cur = { tool: state.tool, color: state.color, size: state.size * scale(), points: [toXY(e)] };
      if (state.tool === 'eraser') drawStroke(ictx, state.cur);
      else drawStroke(lctx, state.cur);
    });
    live.addEventListener('pointermove', e => {
      if (e.pointerId !== pointerId || !state.cur) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const s = state.cur;
      if (['pen', 'marker', 'eraser'].includes(s.tool)) for (const ev of (evs.length ? evs : [e])) s.points.push(toXY(ev));
      else s.points[1] = toXY(e);
      if (s.tool === 'eraser') drawStroke(ictx, s);
      else { lctx.clearRect(0, 0, W, H); drawStroke(lctx, s); }
    });
    const end = e => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      const s = state.cur;
      state.cur = null;
      lctx.clearRect(0, 0, W, H);
      if (!s) return;
      if (s.points.length < 2 && !['pen', 'marker', 'eraser'].includes(s.tool)) return;
      state.strokes.push(s);
      redraw();
      sync();
    };
    live.addEventListener('pointerup', end);
    live.addEventListener('pointercancel', end);

    // ---- 開啟 / 關閉 ----
    let finished = false;
    const finish = val => {
      if (finished) return;
      finished = true;
      window.removeEventListener('resize', fit);
      layer.close();
      resolve(val);
    };
    const askCancel = async () => {
      if (state.strokes.length && !(await confirmBox('畫好的內容不會保留，確定要關閉嗎？', { yes: '關閉', no: '繼續畫' }))) return;
      finish(null);
    };
    const layer = openLayer(panel, { className: 'layer-draw', onRequestClose: askCancel, closeOnBackdrop: false });
    cancelBtn.addEventListener('click', askCancel);
    closeBtn.addEventListener('click', askCancel);
    doneBtn.addEventListener('click', async () => {
      if (!state.strokes.some(s => s.tool !== 'clear')) { await alertBox('還沒有畫任何東西。'); return; }
      if (bgImg) {
        const out = h('canvas', { width: W, height: H });
        const o = out.getContext('2d');
        o.drawImage(bg, 0, 0);
        o.drawImage(ink, 0, 0);
        finish(out);
        return;
      }
      const b = inkBounds(ink);
      if (!b) { await alertBox('畫布是空的，請先畫點東西。'); return; }
      const pad = 12;
      const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
      const w = Math.min(W - x, b.w + pad * 2), hh = Math.min(H - y, b.h + pad * 2);
      const out = h('canvas', { width: w, height: hh });
      const o = out.getContext('2d');
      if (state.whiteBg) { o.fillStyle = '#ffffff'; o.fillRect(0, 0, w, hh); }
      o.drawImage(ink, x, y, w, hh, 0, 0, w, hh);
      out._alpha = !state.whiteBg;
      finish(out);
    });

    paintBg();
    sync();
    requestAnimationFrame(fit);
    window.addEventListener('resize', fit);
  });
}
