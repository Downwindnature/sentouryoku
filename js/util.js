// 共用小工具
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 建立 DOM 元素：h('div', {class:'x', onClick: fn}, child, ...) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v; // 只用在程式內建的固定字串（例如圖示）
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const p2 = n => String(n).padStart(2, '0');

/** 2026/11/7 23:43:51 */
export function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 20261107-234351（檔名用） */
export function fileStamp(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 依時間排序、不會重複的 ID（與 Firebase push key 同格式） */
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastPushTime = 0;
const lastRand = [];
export function makeId() {
  let now = Date.now();
  const dup = now === lastPushTime;
  lastPushTime = now;
  const timeChars = new Array(8);
  for (let i = 7; i >= 0; i--) { timeChars[i] = PUSH_CHARS.charAt(now % 64); now = Math.floor(now / 64); }
  let id = timeChars.join('');
  if (!dup) {
    for (let i = 0; i < 12; i++) lastRand[i] = Math.floor(Math.random() * 64);
  } else {
    let i;
    for (i = 11; i >= 0 && lastRand[i] === 63; i--) lastRand[i] = 0;
    if (i >= 0) lastRand[i]++;
  }
  for (let i = 0; i < 12; i++) id += PUSH_CHARS.charAt(lastRand[i]);
  return id;
}

export const isId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);

/** 判斷是否為權限不足錯誤 */
export function isPermissionError(e) {
  const s = `${e && e.code || ''} ${e && e.message || e || ''}`;
  return /permission[_ ]denied/i.test(s);
}

/** localStorage（可能被瀏覽器封鎖，一律包 try/catch） */
export const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 忽略 */ } }
};

/** 下載檔案 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

/** 限制同時執行數量 */
export async function runLimited(tasks, limit = 3) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** 物件 → 陣列（附上 id） */
export function toList(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj).filter(k => obj[k] && typeof obj[k] === 'object').map(k => ({ ...obj[k], id: k }));
}

/** RTDB 讀回來的分塊（可能是陣列或物件）依序排好 */
export function orderedParts(v) {
  if (!v) return [];
  return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map(k => v[k]).filter(x => typeof x === 'string');
}

/** 戰力字串 → 可比較的數值（數字、萬/億/k/m、S/A/B 等級） */
const GRADES = ['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'];
export function powerValue(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const t = s.replace(/[,，\s]/g, '');
  const num = t.match(/-?\d+(?:\.\d+)?/);
  if (num) {
    let v = parseFloat(num[0]);
    const rest = t.slice(num.index + num[0].length);
    if (/^億/.test(rest)) v *= 1e8;
    else if (/^[萬wW]/.test(rest)) v *= 1e4;
    else if (/^[kK]/.test(rest)) v *= 1e3;
    else if (/^[mM]/.test(rest)) v *= 1e6;
    return v;
  }
  const g = s.toUpperCase().match(/^(S{1,3}|[A-F])\s*([+\-＋－]*)/);
  if (g) {
    const base = GRADES.indexOf(g[1]);
    const mod = (g[2].match(/[+＋]/g) || []).length * 0.3 - (g[2].match(/[\-－]/g) || []).length * 0.3;
    return -1e12 + base + mod; // 等級排在數字之後
  }
  return null;
}
