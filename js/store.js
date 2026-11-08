// 資料層：所有讀寫都經過這裡（Firebase 與示範模式共用同一套邏輯）
//
// 資料結構（Realtime Database）
//   pages/{pid}                   分頁 {name, editor, order, createdAt, createdBy}
//   ratings/{pid}                 戰力評分方式 {html, updatedAt, updatedBy}
//   entries/{pid}/{eid}           名單 {name, power, avatar, html, createdAt, updatedAt, updatedBy, pinnedAt}
//   history/{eid}/{hid}           過往紀錄 {name, power, avatar, html, at, by}
//   media/{scope}/{mid}           媒體資訊 {t, m, s, c, w, h, d, at}
//   mediaThumb/{scope}/{mid}      縮圖（data URL）
//   mediaData/{scope}/{mid}/{i}   檔案內容（Base64 分塊）
//   scope = 名單 id，或 r_{pid}（戰力評分方式用）
import { settings } from './config.js';
import { makeId, toList, orderedParts, runLimited, isId } from './util.js';
import { CHUNK, blobToBase64, chunkString, base64PartsToBlob } from './media.js';

export const rateScope = pid => 'r_' + pid;
const APP_TAG = 'power-roster';
const FORMAT = 1;

/** 找出 HTML 與頭像用到的媒體 id */
export function collectRefs(html, avatar, into = new Set()) {
  if (avatar && isId(avatar)) into.add(avatar);
  const re = /data-mid="([A-Za-z0-9_-]{1,64})"/g;
  let m;
  while ((m = re.exec(String(html || '')))) into.add(m[1]);
  return into;
}

export function createStore(A) {
  const thumbCache = new Map(); // key → Promise<dataURL|null>
  const metaCache = new Map();  // key → Promise<meta|null>
  const urlCache = new Map();   // key → Promise<objectURL>

  const mkey = (scope, mid) => scope + '/' + mid;

  async function uploadPending(scope, pending, refs, onProgress) {
    const items = [...(pending ? pending.entries() : [])].filter(([mid]) => refs.has(mid));
    if (!items.length) return;
    const prepared = [];
    let total = 0, done = 0;
    for (const [mid, m] of items) {
      const b64 = await blobToBase64(m.blob);
      const chunks = chunkString(b64, CHUNK);
      prepared.push({ mid, m, chunks });
      total += chunks.length;
    }
    onProgress && onProgress(0, total);
    for (const { mid, m, chunks } of prepared) {
      await runLimited(chunks.map((c, i) => async () => {
        await A.set(`mediaData/${scope}/${mid}/${i}`, c);
        done++;
        onProgress && onProgress(done, total);
      }), 3);
      const meta = { t: m.type, m: m.mime, s: m.size || 0, c: chunks.length, w: m.w || 0, h: m.h || 0, d: Math.round((m.dur || 0) * 10) / 10, at: A.now() };
      await A.update('', {
        [`mediaThumb/${scope}/${mid}`]: m.thumb || null,
        [`media/${scope}/${mid}`]: meta
      });
      const k = mkey(scope, mid);
      metaCache.set(k, Promise.resolve(meta));
      thumbCache.set(k, Promise.resolve(m.thumb || null));
      if (m.url) urlCache.set(k, Promise.resolve(m.url));
    }
  }

  async function gcScope(scope, keep) {
    const metas = await A.get('media/' + scope);
    if (!metas) return;
    const upd = {};
    for (const mid of Object.keys(metas)) {
      if (keep.has(mid)) continue;
      upd[`media/${scope}/${mid}`] = null;
      upd[`mediaThumb/${scope}/${mid}`] = null;
      upd[`mediaData/${scope}/${mid}`] = null;
    }
    if (Object.keys(upd).length) await A.update('', upd);
  }

  async function writeBatched(upd) {
    // 大量資料分批寫入，避免單次寫入過大
    let batch = {}, size = 0;
    for (const [k, v] of Object.entries(upd)) {
      const len = JSON.stringify(v ?? null).length + k.length;
      if (size + len > 2_000_000 && Object.keys(batch).length) {
        await A.update('', batch);
        batch = {}; size = 0;
      }
      batch[k] = v; size += len;
    }
    if (Object.keys(batch).length) await A.update('', batch);
  }

  const store = {
    adapter: A,

    // ---------- 分頁 ----------
    watchPages(cb, errCb) {
      return A.on('pages', v => cb(toList(v).sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0))), errCb);
    },
    async createPage(name, editor, pages) {
      const id = makeId();
      const order = pages.reduce((m, p) => Math.max(m, p.order || 0), 0) + 1;
      await A.set('pages/' + id, { name, editor: editor || '', order, createdAt: A.now(), createdBy: editor || '' });
      return id;
    },
    /** 修改分頁名稱與編輯者 */
    updatePage: (pid, { name, editor }) => A.update('pages/' + pid, { name, editor: editor || '' }),
    async countEntries(pid) {
      const v = await A.get('entries/' + pid);
      return v ? Object.keys(v).length : 0;
    },
    async deletePage(pid) {
      const n = await store.countEntries(pid);
      if (n > 0) { const e = new Error('NOT_EMPTY'); e.count = n; throw e; }
      const rs = rateScope(pid);
      await A.update('', {
        ['pages/' + pid]: null, ['ratings/' + pid]: null, ['entries/' + pid]: null,
        ['media/' + rs]: null, ['mediaThumb/' + rs]: null, ['mediaData/' + rs]: null
      });
    },

    // ---------- 名單 ----------
    watchEntries(pid, cb, errCb) { return A.on('entries/' + pid, v => cb(toList(v)), errCb); },
    getEntry: (pid, eid) => A.get(`entries/${pid}/${eid}`),

    /**
     * 儲存名單。舊版本自動放進過往紀錄。
     * baseUpdatedAt：開始編輯時的更新時間，用來偵測別人是否同時修改。
     */
    async saveEntry({ pid, eid, data, baseUpdatedAt = null, force = false, pending, user, onProgress }) {
      const cur = await A.get(`entries/${pid}/${eid}`);
      if (!force) {
        if (cur && baseUpdatedAt && cur.updatedAt !== baseUpdatedAt) { const e = new Error('CONFLICT'); e.current = cur; throw e; }
        if (cur && !baseUpdatedAt) { const e = new Error('CONFLICT'); e.current = cur; throw e; }
        if (!cur && baseUpdatedAt) throw new Error('GONE');
      }
      const refs = collectRefs(data.html, data.avatar);
      await uploadPending(eid, pending, refs, onProgress);
      const now = A.now();
      const upd = {};
      if (cur) {
        upd[`history/${eid}/${makeId()}`] = {
          name: cur.name || '', power: cur.power || '', avatar: cur.avatar || null, html: cur.html || '',
          at: cur.updatedAt || cur.createdAt || now, by: cur.updatedBy || ''
        };
      }
      const entry = {
        name: data.name, power: data.power || '', avatar: data.avatar || null, html: data.html || '',
        createdAt: (cur && cur.createdAt) || now, createdBy: (cur && cur.createdBy) || (user ? user.name : ''),
        updatedAt: now, updatedBy: user ? user.name : '',
        pinnedAt: (cur && cur.pinnedAt) || null // 置頂狀態不受編輯影響
      };
      upd[`entries/${pid}/${eid}`] = entry;
      await A.update('', upd);
      try { await store.trimAndGc(eid, entry); } catch (e) { console.warn('整理過往紀錄時發生問題', e); }
      return entry;
    },

    async trimAndGc(eid, entry) {
      const hist = (await A.get('history/' + eid)) || {};
      const upd = {};
      const limit = Number(settings.historyLimit) || 0;
      const ids = Object.keys(hist).sort((a, b) => (hist[a].at || 0) - (hist[b].at || 0) || (a < b ? -1 : 1));
      if (limit > 0 && ids.length > limit) {
        for (const id of ids.slice(0, ids.length - limit)) { upd[`history/${eid}/${id}`] = null; delete hist[id]; }
      }
      if (Object.keys(upd).length) await A.update('', upd);
      const keep = collectRefs(entry.html, entry.avatar);
      for (const h of Object.values(hist)) collectRefs(h.html, h.avatar, keep);
      await gcScope(eid, keep);
    },

    /** 置頂（記下置頂時間）或取消置頂；不算修改內容，所以不動上次更新時間、也不產生過往紀錄 */
    setPinned: (pid, eid, on) => A.set(`entries/${pid}/${eid}/pinnedAt`, on ? A.now() : null),

    async deleteEntry(pid, eid) {
      await A.update('', {
        [`entries/${pid}/${eid}`]: null, [`history/${eid}`]: null,
        [`media/${eid}`]: null, [`mediaThumb/${eid}`]: null, [`mediaData/${eid}`]: null
      });
    },

    async listHistory(eid) {
      const v = await A.get('history/' + eid);
      return toList(v).sort((a, b) => (b.at || 0) - (a.at || 0) || (a.id < b.id ? 1 : -1));
    },

    // ---------- 戰力評分方式 ----------
    getRating: pid => A.get('ratings/' + pid),
    async saveRating({ pid, html, pending, user, onProgress }) {
      const scope = rateScope(pid);
      const refs = collectRefs(html);
      await uploadPending(scope, pending, refs, onProgress);
      const rec = { html: html || '', updatedAt: A.now(), updatedBy: user ? user.name : '' };
      await A.set('ratings/' + pid, rec);
      try { await gcScope(scope, refs); } catch (e) { console.warn(e); }
      return rec;
    },

    // ---------- 媒體讀取（有快取）----------
    getThumb(scope, mid) {
      const k = mkey(scope, mid);
      if (!thumbCache.has(k)) {
        const p = A.get(`mediaThumb/${scope}/${mid}`).then(v => (typeof v === 'string' && v.startsWith('data:image/') ? v : null));
        p.catch(() => thumbCache.delete(k));
        thumbCache.set(k, p);
      }
      return thumbCache.get(k);
    },
    getMeta(scope, mid) {
      const k = mkey(scope, mid);
      if (!metaCache.has(k)) {
        const p = A.get(`media/${scope}/${mid}`);
        p.catch(() => metaCache.delete(k));
        metaCache.set(k, p);
      }
      return metaCache.get(k);
    },
    getMediaUrl(scope, mid) {
      const k = mkey(scope, mid);
      if (!urlCache.has(k)) {
        const p = (async () => {
          const meta = await store.getMeta(scope, mid);
          if (!meta) throw new Error('MEDIA_MISSING');
          const parts = orderedParts(await A.get(`mediaData/${scope}/${mid}`));
          if (parts.length < (meta.c || 1)) throw new Error('MEDIA_INCOMPLETE');
          return URL.createObjectURL(base64PartsToBlob(parts, meta.m));
        })();
        p.catch(() => urlCache.delete(k));
        urlCache.set(k, p);
      }
      return urlCache.get(k);
    },

    // ---------- 備份（JSON）----------
    async exportPage(pid, onProgress) {
      const [page, rating, entriesObj] = await Promise.all([A.get('pages/' + pid), A.get('ratings/' + pid), A.get('entries/' + pid)]);
      const entries = entriesObj || {};
      const eids = Object.keys(entries);
      const history = {};
      const media = {};
      const scopes = [...eids.map(e => [e, e]), [rateScope(pid), '__rating__']];
      let step = 0;
      for (const eid of eids) {
        const hv = await A.get('history/' + eid);
        if (hv) history[eid] = hv;
      }
      for (const [scope, key] of scopes) {
        const metas = await A.get('media/' + scope);
        if (metas) {
          media[key] = {};
          for (const [mid, meta] of Object.entries(metas)) {
            const [thumb, data] = await Promise.all([A.get(`mediaThumb/${scope}/${mid}`), A.get(`mediaData/${scope}/${mid}`)]);
            media[key][mid] = { ...meta, thumb: thumb || null, data: orderedParts(data).join('') };
          }
        }
        onProgress && onProgress(++step, scopes.length);
      }
      return {
        app: APP_TAG, format: FORMAT, exportedAt: A.now(),
        page: { name: (page && page.name) || '', editor: (page && page.editor) || '', createdAt: (page && page.createdAt) || 0 },
        rating: rating || null, entries, history, media
      };
    },

    async importPage(json, user, pages, onProgress) {
      if (!json || json.app !== APP_TAG || typeof json.entries !== 'object') throw new Error('這不是「戰力名單」的備份檔。');
      if (json.format > FORMAT) throw new Error('這個備份檔是新版網站產生的，請先更新網站。');
      const pid = makeId();
      const eidMap = {};
      for (const old of Object.keys(json.entries || {})) if (isId(old)) eidMap[old] = makeId();

      // 1) 媒體
      const jobs = [];
      for (const [oldScope, items] of Object.entries(json.media || {})) {
        const scope = oldScope === '__rating__' ? rateScope(pid) : eidMap[oldScope];
        if (!scope || !items || typeof items !== 'object') continue;
        for (const [mid, m] of Object.entries(items)) {
          if (isId(mid) && m && typeof m.data === 'string') jobs.push({ scope, mid, m });
        }
      }
      let total = 0, done = 0;
      const prepared = jobs.map(j => { const chunks = chunkString(j.m.data, CHUNK); total += chunks.length; return { ...j, chunks }; });
      onProgress && onProgress(0, total);
      for (const { scope, mid, m, chunks } of prepared) {
        await runLimited(chunks.map((c, i) => async () => {
          await A.set(`mediaData/${scope}/${mid}/${i}`, c);
          done++;
          onProgress && onProgress(done, total);
        }), 3);
        await A.update('', {
          [`mediaThumb/${scope}/${mid}`]: typeof m.thumb === 'string' ? m.thumb : null,
          [`media/${scope}/${mid}`]: { t: m.t || 'image', m: m.m || 'application/octet-stream', s: m.s || 0, c: chunks.length, w: m.w || 0, h: m.h || 0, d: m.d || 0, at: m.at || A.now() }
        });
      }

      // 2) 文字資料
      const str = (v, max) => String(v == null ? '' : v).slice(0, max);
      const upd = {};
      for (const [old, eid] of Object.entries(eidMap)) {
        const e = json.entries[old] || {};
        upd[`entries/${pid}/${eid}`] = {
          name: str(e.name, 60) || '（未命名）', power: str(e.power, 40), avatar: isId(e.avatar) ? e.avatar : null, html: str(e.html, 1000000),
          createdAt: Number(e.createdAt) || A.now(), createdBy: str(e.createdBy, 80), updatedAt: Number(e.updatedAt) || A.now(), updatedBy: str(e.updatedBy, 80),
          pinnedAt: Number(e.pinnedAt) || null
        };
        for (const [hid, rec] of Object.entries((json.history || {})[old] || {})) {
          if (!isId(hid) || !rec) continue;
          upd[`history/${eid}/${hid}`] = { name: str(rec.name, 60), power: str(rec.power, 40), avatar: isId(rec.avatar) ? rec.avatar : null, html: str(rec.html, 1000000), at: Number(rec.at) || 0, by: str(rec.by, 80) };
        }
      }
      if (json.rating && typeof json.rating === 'object') {
        upd[`ratings/${pid}`] = { html: str(json.rating.html, 1000000), updatedAt: Number(json.rating.updatedAt) || A.now(), updatedBy: str(json.rating.updatedBy, 80) };
      }
      await writeBatched(upd);

      // 3) 最後才建立分頁（避免看到匯入到一半的分頁）
      let name = str(json.page && json.page.name, 40).trim() || '匯入的分頁';
      if (pages.some(p => p.name === name)) name = (name.slice(0, 36) + '（匯入）');
      const order = pages.reduce((m, p) => Math.max(m, p.order || 0), 0) + 1;
      const editor = str(json.page && json.page.editor, 20).trim() || (user ? user.name : '');
      await A.set('pages/' + pid, { name, editor, order, createdAt: A.now(), createdBy: editor });
      return { pid, name, count: Object.keys(eidMap).length };
    }
  };
  return store;
}
