// 示範模式：用瀏覽器 IndexedDB 模擬 Firebase Realtime Database（資料只存在這台電腦）
import { ls } from './util.js';

const DB_NAME = 'power-roster-demo';
const STORE = 'kv';
const KEY = 'tree';
const DEMO_USER = { uid: 'demo-owner', name: '本機使用者', email: 'demo@local', photo: '' };

function openIdb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const split = path => String(path || '').split('/').filter(Boolean);

/** 模擬 RTDB：null 代表刪除、空物件不保留 */
function normalize(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) v = Object.assign({}, v);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const n = normalize(x);
      if (n !== null) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  }
  if (typeof v === 'number' && !isFinite(v)) return null;
  return v;
}
const clone = v => (v === undefined || v === null ? null : (typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v));

export async function createLocalAdapter() {
  let tree = {};
  let idb = null;
  try {
    idb = await openIdb();
    const saved = await idbGet(idb, KEY);
    if (saved && typeof saved === 'object') tree = saved;
  } catch {
    idb = null; // 無法使用 IndexedDB（例如私密瀏覽）→ 只存在記憶體
  }
  if (!tree.owner) tree.owner = DEMO_USER.uid;

  let saveTimer = null;
  const persist = () => {
    if (!idb) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { idbPut(idb, KEY, tree).catch(() => {}); }, 250);
  };

  const getAt = parts => {
    let n = tree;
    for (const p of parts) {
      if (n == null || typeof n !== 'object') return null;
      n = n[p];
    }
    return n === undefined ? null : n;
  };

  const setAt = (parts, value) => {
    const v = normalize(value);
    if (!parts.length) { tree = v || {}; return; }
    const chain = [tree];
    let n = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (n[p] == null || typeof n[p] !== 'object') {
        if (v === null) return;
        n[p] = {};
      }
      n = n[p];
      chain.push(n);
    }
    const last = parts[parts.length - 1];
    if (v === null) delete n[last]; else n[last] = v;
    // 往上清掉變空的節點
    for (let i = chain.length - 1; i > 0; i--) {
      if (Object.keys(chain[i]).length === 0) delete chain[i - 1][parts[i - 1]];
      else break;
    }
  };

  // ---- 監聽 ----
  const listeners = new Set();
  let pending = new Set();
  let flushQueued = false;
  const related = (a, b) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const changed = paths => {
    persist();
    for (const l of listeners) if (paths.some(p => related(l.parts, p))) pending.add(l);
    if (!flushQueued) {
      flushQueued = true;
      setTimeout(() => {
        flushQueued = false;
        const list = pending; pending = new Set();
        for (const l of list) if (listeners.has(l)) l.cb(clone(getAt(l.parts)));
      }, 0);
    }
  };

  // ---- 登入（示範模式只有一位本機使用者）----
  let signedIn = ls.get('pr-demo-signed-in', true) !== false;
  const authCbs = new Set();
  const emitAuth = () => { for (const cb of authCbs) cb(signedIn ? { ...DEMO_USER } : null); };

  return {
    mode: 'local',
    persistent: !!idb,
    now: () => Date.now(),
    onAuth(cb) {
      authCbs.add(cb);
      setTimeout(() => cb(signedIn ? { ...DEMO_USER } : null), 0);
      return () => authCbs.delete(cb);
    },
    async signIn() { signedIn = true; ls.set('pr-demo-signed-in', true); emitAuth(); },
    async signOut() { signedIn = false; ls.set('pr-demo-signed-in', false); emitAuth(); },
    async get(path) { return clone(getAt(split(path))); },
    async set(path, value) { setAt(split(path), clone(value)); changed([split(path)]); },
    async update(path, obj) {
      const base = split(path);
      const touched = [];
      for (const [k, v] of Object.entries(obj || {})) {
        const parts = [...base, ...split(k)];
        setAt(parts, clone(v));
        touched.push(parts);
      }
      changed(touched);
    },
    async remove(path) { setAt(split(path), null); changed([split(path)]); },
    on(path, cb) {
      const l = { parts: split(path), cb };
      listeners.add(l);
      setTimeout(() => { if (listeners.has(l)) cb(clone(getAt(l.parts))); }, 0);
      return () => listeners.delete(l);
    },
    onConnection(cb) { setTimeout(() => cb(true), 0); return () => {}; },
    async wipe() { tree = { owner: DEMO_USER.uid }; changed([[]]); }
  };
}
