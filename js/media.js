// 媒體處理：圖片壓縮、縮圖、影片截圖、Base64 分塊
import { fmtBytes } from './util.js';

export const CHUNK = 512 * 1024; // 每塊字元數（4 的倍數，方便各塊獨立解碼）
const MB = 1024 * 1024;
const THUMB_SIDE = 360;

let webpOK;
export function canWebp() {
  if (webpOK === undefined) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 2;
      webpOK = c.toDataURL('image/webp').startsWith('data:image/webp');
    } catch { webpOK = false; }
  }
  return webpOK;
}

const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('圖片轉檔失敗'))), type, quality);
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('IMG_DECODE'));
    img.src = src;
  });
}

async function decodeImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    if (!img.naturalWidth) throw new Error('IMG_DECODE');
    return { img, url };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`「${file.name || '這張圖片'}」的格式瀏覽器讀不了，請換成 JPG、PNG、WebP 或 GIF。`);
  }
}

function hasAlpha(ctx, w, h) {
  try {
    const data = ctx.getImageData(0, 0, w, h).data;
    const step = Math.max(4, Math.floor((w * h) / 40000)) * 4;
    for (let i = 3; i < data.length; i += step) if (data[i] < 250) return true;
  } catch { return true; }
  return false;
}

/** 依透明度挑格式：WebP（支援透明）> PNG（透明）> JPEG */
async function encode(canvas, alpha, quality = 0.86) {
  if (canWebp()) return canvasToBlob(canvas, 'image/webp', quality);
  if (alpha) return canvasToBlob(canvas, 'image/png');
  return canvasToBlob(canvas, 'image/jpeg', Math.min(0.92, quality + 0.02));
}

/** 縮圖（data URL），預覽與卡片用 */
export function makeThumb(source, sw, sh, side = THUMB_SIDE) {
  const s = Math.min(1, side / Math.max(sw, sh));
  const c = makeCanvas(sw * s, sh * s);
  const ctx = c.getContext('2d');
  if (!canWebp()) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return canWebp() ? c.toDataURL('image/webp', 0.72) : c.toDataURL('image/jpeg', 0.78);
}

export function kindOf(file) {
  const t = (file.type || '').toLowerCase();
  const n = (file.name || '').toLowerCase();
  if (t === 'image/gif' || n.endsWith('.gif')) return 'gif';
  if (t.startsWith('image/') || /\.(jpe?g|png|webp|bmp|avif|heic|heif|svg)$/.test(n)) return 'image';
  if (t.startsWith('video/') || /\.(mp4|m4v|webm|mov|ogv)$/.test(n)) return 'video';
  return null;
}

export async function processImage(file, { maxSide = 1600 } = {}) {
  const { img, url } = await decodeImageFile(file);
  try {
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    const scale = Math.min(1, maxSide / Math.max(w0, h0));
    const c = makeCanvas(w0 * scale, h0 * scale);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const alpha = /png|webp|svg|avif|bmp/i.test(file.type || file.name) && hasAlpha(ctx, c.width, c.height);
    let blob = await encode(c, alpha);
    // 原檔已經夠小、不用縮放時保留原檔
    if (scale === 1 && file.size <= blob.size && /^image\/(jpeg|png|webp)$/i.test(file.type)) blob = file;
    return { type: 'image', mime: blob.type || file.type || 'image/jpeg', blob, size: blob.size, w: c.width, h: c.height, thumb: makeThumb(img, w0, h0) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function processGif(file, { gifMaxMB = 8 } = {}) {
  if (file.size > gifMaxMB * MB) throw new Error(`GIF 太大了（${fmtBytes(file.size)}），上限是 ${gifMaxMB} MB。可以先用線上工具壓縮再上傳。`);
  const { img, url } = await decodeImageFile(file);
  try {
    return { type: 'gif', mime: 'image/gif', blob: file, size: file.size, w: img.naturalWidth, h: img.naturalHeight, thumb: makeThumb(img, img.naturalWidth, img.naturalHeight) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function waitFor(el, okEvent, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('error')); };
    const cleanup = () => { clearTimeout(t); el.removeEventListener(okEvent, ok); el.removeEventListener('error', bad); };
    el.addEventListener(okEvent, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

export async function processVideo(file, { videoMaxMB = 20 } = {}) {
  if (file.size > videoMaxMB * MB) throw new Error(`影片太大了（${fmtBytes(file.size)}），上限是 ${videoMaxMB} MB。請先剪短或壓縮後再上傳。`);
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
  v.src = url;
  try {
    try { await waitFor(v, 'loadeddata', 20000); }
    catch { throw new Error(`「${file.name}」這個影片格式瀏覽器播不了，請轉成 MP4（H.264）後再上傳。`); }
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) throw new Error('這個檔案沒有影像畫面，無法當作影片插入。');
    const dur = isFinite(v.duration) ? v.duration : 0;
    let thumb = null;
    try {
      const target = Math.min(1, dur * 0.1);
      if (target > 0.05) { v.currentTime = target; await waitFor(v, 'seeked', 6000); }
      thumb = makeThumb(v, w, h);
    } catch { thumb = null; }
    let mime = (file.type || '').toLowerCase();
    if (!mime.startsWith('video/')) mime = /\.webm$/i.test(file.name) ? 'video/webm' : 'video/mp4';
    return { type: 'video', mime, blob: file, size: file.size, w, h, dur, thumb };
  } finally {
    v.removeAttribute('src'); v.load();
    URL.revokeObjectURL(url);
  }
}

/** 頭像：裁成正方形 256px */
export async function processAvatar(file) {
  const { img, url } = await decodeImageFile(file);
  try {
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - s) / 2, sy = (img.naturalHeight - s) / 2;
    const c = makeCanvas(256, 256);
    const ctx = c.getContext('2d');
    if (!canWebp()) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 256, 256); }
    ctx.drawImage(img, sx, sy, s, s, 0, 0, 256, 256);
    const blob = await encode(c, false, 0.88);
    return { type: 'image', mime: blob.type, blob, size: blob.size, w: 256, h: 256, thumb: makeThumb(c, 256, 256, 160) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 手繪畫布 → 圖片 */
export async function processCanvas(canvas, { alpha = true } = {}) {
  const blob = await encode(canvas, alpha, 0.9);
  return { type: 'image', mime: blob.type, blob, size: blob.size, w: canvas.width, h: canvas.height, thumb: makeThumb(canvas, canvas.width, canvas.height) };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result); resolve(s.slice(s.indexOf(',') + 1)); };
    fr.onerror = () => reject(fr.error || new Error('讀取檔案失敗'));
    fr.readAsDataURL(blob);
  });
}

export function chunkString(s, size = CHUNK) {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [''];
}

export function base64PartsToBlob(parts, mime) {
  const bufs = parts.map(p => {
    const bin = atob(p);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  });
  return new Blob(bufs, { type: mime || 'application/octet-stream' });
}
