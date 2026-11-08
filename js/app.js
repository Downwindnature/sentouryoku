// 戰力名單 — 主程式
import { firebaseConfig, settings } from './config.js';
import { h, $, fmtTime, fileStamp, makeId, ls, isPermissionError, downloadBlob, powerValue, debounce, clamp } from './util.js';
import { icon } from './icons.js';
import { createLocalAdapter } from './adapter-local.js';
import { createStore, collectRefs, rateScope } from './store.js';
import { RichEditor, renderRich, htmlIsEmpty } from './editor.js';
import { processAvatar } from './media.js';
import { openLayer, confirmBox, alertBox, promptBox, toast, busyBox, popover } from './ui.js';

const SORTS = [
  ['created', '新增順序'],
  ['updated', '最近更新'],
  ['powerDesc', '戰力高→低'],
  ['powerAsc', '戰力低→高'],
  ['name', '名字']
];

const S = {
  adapter: null, store: null,
  user: null, role: 'guest', ownerExists: true, publicRead: true, locked: false,
  pages: [], pagesLoaded: false, pid: ls.get('pr-current-page'),
  entries: [], entriesLoaded: false,
  search: '', sort: ls.get('pr-sort', 'created'), listPage: 1,
  online: true, justSaved: null, focusEid: null, fatal: null
};
if (!SORTS.some(([k]) => k === S.sort)) S.sort = 'created';

const canEdit = () => S.role === 'owner' || S.role === 'editor';
let OPEN = null; // 目前開著的名單視窗（用來即時更新）

const GOOGLE_G = '<svg class="i" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.68-.06-1.36-.18-2.02H12v3.83h5.4a4.62 4.62 0 0 1-2 3.03v2.5h3.24c1.9-1.75 2.96-4.33 2.96-7.34z"/><path fill="#34A853" d="M12 22c2.7 0 4.98-.9 6.64-2.43l-3.24-2.51c-.9.61-2.05.96-3.4.96-2.6 0-4.82-1.76-5.6-4.13H3.06v2.59A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.4 13.89a6 6 0 0 1 0-3.78V7.52H3.06a10 10 0 0 0 0 8.96z"/><path fill="#EA4335" d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.94 5.52L6.4 10.1C7.18 7.74 9.4 5.98 12 5.98z"/></svg>';

const AUTH_ERRORS = {
  'auth/unauthorized-domain': () => `這個網址還沒加入 Firebase 的「已授權網域」。請到 Firebase 主控台 → Authentication → 設定 → 已授權網域，加入「${location.hostname}」。`,
  'auth/operation-not-allowed': () => 'Firebase 還沒啟用 Google 登入。請到 Firebase 主控台 → Authentication → 登入方式，啟用「Google」。',
  'auth/popup-blocked': () => '登入視窗被瀏覽器擋住了，請允許這個網站開啟彈出式視窗，再按一次登入。',
  'auth/network-request-failed': () => '網路連線失敗，請確認網路之後再試一次。',
  'auth/web-storage-unsupported': () => '這個瀏覽器封鎖了網站儲存空間，無法登入。請改用 Chrome 或 Safari。',
  'auth/internal-error': () => '登入時發生錯誤。如果是從 LINE、Facebook 等 App 裡開啟網址，請改用 Chrome 或 Safari 開啟。',
  'auth/configuration-not-found': () => 'Firebase 還沒啟用 Authentication。請到 Firebase 主控台 → Authentication → 開始使用，並啟用「Google」登入。',
  'auth/invalid-api-key': () => 'js/config.js 裡的 apiKey 不正確，請重新從 Firebase 主控台複製。'
};

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------
async function boot() {
  document.title = settings.siteTitle || '戰力名單';
  bindStatic();
  renderSortSelect();
  const cfg = firebaseConfig || {};
  try {
    if (cfg.apiKey) {
      if (!cfg.databaseURL) throw new Error('js/config.js 裡少了 databaseURL。請到 Firebase 主控台 → Realtime Database 複製資料庫網址（https://…firebasedatabase.app）貼進去。');
      const mod = await import('./adapter-firebase.js');
      S.adapter = await mod.createFirebaseAdapter(cfg);
    } else {
      S.adapter = await createLocalAdapter();
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    S.fatal = /databaseURL/.test(msg) ? msg : `無法載入 Firebase：${msg}\n請確認網路連線，並檢查 js/config.js 的設定是否完整。`;
    renderList();
    return;
  }
  S.store = createStore(S.adapter);
  document.documentElement.dataset.mode = S.adapter.mode;

  let offlineTimer = null;
  S.adapter.onConnection(on => {
    clearTimeout(offlineTimer);
    if (on) { S.online = true; renderWho(); }
    else offlineTimer = setTimeout(() => { S.online = false; renderWho(); }, 3000);
  });
  S.store.watchPublicRead(v => { S.publicRead = v; renderList(); });
  S.adapter.onAuth(onAuth);
  subscribePages();
}

async function onAuth(user) {
  S.user = user;
  let r = { role: user ? 'viewer' : 'guest', ownerExists: true };
  try { r = await S.store.resolveRole(user); } catch (e) { console.warn(e); }
  S.role = r.role;
  S.ownerExists = r.ownerExists;
  renderWho();
  renderChrome();
  subscribePages();
  subscribeEntries(true);
  if (user && !r.ownerExists && S.adapter.mode === 'firebase' && !S.claimAsked) {
    S.claimAsked = true;
    offerClaim();
  }
}

// ---------------------------------------------------------------------------
// 即時資料
// ---------------------------------------------------------------------------
let unsubPages = null, unsubEntries = null, entriesPid = null;

function subscribePages() {
  if (unsubPages) unsubPages();
  unsubPages = S.store.watchPages(pages => {
    S.locked = false;
    S.pages = pages;
    S.pagesLoaded = true;
    if (!pages.some(p => p.id === S.pid)) S.pid = pages.length ? pages[0].id : null;
    renderTabs();
    subscribeEntries();
    renderList();
  }, err => {
    S.pagesLoaded = true;
    if (isPermissionError(err)) { S.locked = true; S.pages = []; renderTabs(); renderList(); }
    else toast('讀取分頁失敗：' + (err.message || err), 'error');
  });
}

function subscribeEntries(force = false) {
  if (!force && entriesPid === S.pid && unsubEntries) return;
  if (unsubEntries) { unsubEntries(); unsubEntries = null; }
  entriesPid = S.pid;
  S.entries = [];
  S.entriesLoaded = false;
  if (!S.pid) { S.entriesLoaded = true; renderList(); return; }
  renderList();
  const pid = S.pid;
  unsubEntries = S.store.watchEntries(pid, list => {
    if (pid !== S.pid) return;
    S.entries = list;
    S.entriesLoaded = true;
    renderList();
    if (OPEN) OPEN.refresh();
  }, err => {
    S.entriesLoaded = true;
    if (isPermissionError(err)) { S.locked = true; renderList(); }
    else toast('讀取名單失敗：' + (err.message || err), 'error');
  });
}

function switchPage(pid) {
  if (!pid || pid === S.pid) return;
  S.pid = pid;
  ls.set('pr-current-page', pid);
  S.listPage = 1;
  renderTabs();
  subscribeEntries();
}

// ---------------------------------------------------------------------------
// 固定的畫面元件
// ---------------------------------------------------------------------------
function bindStatic() {
  $('#btn-who').addEventListener('click', openWhoMenu);
  $('#btn-new').addEventListener('click', () => {
    if (!S.pid) { if (canEdit()) toast('請先按左下角的 + 新增一個分頁', 'warn'); return; }
    if (requireEditor()) openEntry({ mode: 'edit' });
  });
  $('#btn-rating').addEventListener('click', openRating);

  const input = $('#search-input');
  const apply = () => {
    const v = input.value.trim();
    if (v === S.search) return;
    S.search = v;
    S.listPage = 1;
    renderList();
  };
  const applySoon = debounce(apply, 220);
  $('#search-form').addEventListener('submit', e => { e.preventDefault(); applySoon.cancel(); apply(); });
  input.addEventListener('input', e => { if (!e.isComposing) applySoon(); });
  input.addEventListener('compositionend', applySoon);
  $('#btn-clear').addEventListener('click', () => { input.value = ''; applySoon.cancel(); apply(); input.focus(); });

  $('#btn-prev').addEventListener('click', () => { S.listPage--; renderList(); scrollListTop(); });
  $('#btn-next').addEventListener('click', () => { S.listPage++; renderList(); scrollListTop(); });
  $('#sort-select').addEventListener('change', e => { S.sort = e.target.value; ls.set('pr-sort', S.sort); S.listPage = 1; renderList(); });

  $('#btn-add-page').addEventListener('click', addPage);
  bindTabs();
  renderWho();
  renderChrome();
}

function scrollListTop() { const l = $('#list'); if (l) l.scrollTop = 0; }

function renderSortSelect() {
  const sel = $('#sort-select');
  sel.replaceChildren(...SORTS.map(([k, label]) => h('option', { value: k, text: label })));
  sel.value = S.sort;
}

function renderWho() {
  const b = $('#btn-who');
  if (!b) return;
  const demo = S.adapter && S.adapter.mode === 'local';
  const kids = [h('span', { class: 'who-label', text: '編輯者：' })];
  if (S.user) {
    kids.push(h('span', { class: 'who-name', text: S.user.name }));
    if (demo) kids.push(h('span', { class: 'chip', text: '示範模式' }));
    else if (S.role === 'viewer') kids.push(h('span', { class: 'chip', text: '僅檢視' }));
  } else {
    kids.push(h('span', { class: 'who-name muted', text: '未登入' }));
    kids.push(h('span', { class: 'chip chip-cta', text: demo ? '訪客檢視' : '登入' }));
  }
  if (!S.online) kids.push(h('span', { class: 'chip chip-warn', html: icon('wifiOff') + '<span>離線</span>' }));
  b.replaceChildren(...kids);
  b.setAttribute('aria-label', S.user ? `編輯者：${S.user.name}，開啟帳號選單` : '尚未登入，開啟登入選單');
}

function renderChrome() {
  const ed = canEdit();
  $('#btn-new').hidden = !ed;
  $('#btn-add-page').hidden = !ed;
  document.documentElement.classList.toggle('can-edit', ed);
  renderTabs();
  renderList();
}

// ---------------------------------------------------------------------------
// 分頁籤（底部）
// ---------------------------------------------------------------------------
function renderTabs() {
  const list = $('#tab-list');
  if (!list) return;
  const ed = canEdit();
  list.replaceChildren(...S.pages.map(p => {
    const on = p.id === S.pid;
    return h('button', {
      type: 'button', class: 'tab' + (on ? ' on' : ''), role: 'tab', 'aria-selected': on ? 'true' : 'false',
      title: on && ed ? `${p.name}（再點一次開啟選單）` : p.name, dataset: { pid: p.id }
    }, h('span', { class: 'tab-name', text: p.name }), on && ed ? h('span', { class: 'tab-more', html: icon('chevLeft', 'rot') }) : null);
  }));
  const active = list.querySelector('.tab.on');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function bindTabs() {
  const list = $('#tab-list');
  let pressTimer = null, pressed = null, suppressClick = false, startX = 0, startY = 0;
  list.addEventListener('click', e => {
    const t = e.target.closest('.tab');
    if (!t) return;
    if (suppressClick) { suppressClick = false; return; }
    const pid = t.dataset.pid;
    if (pid !== S.pid) switchPage(pid);
    else if (canEdit()) openTabMenu(pid, t);
  });
  list.addEventListener('contextmenu', e => {
    const t = e.target.closest('.tab');
    if (!t || !canEdit()) return;
    e.preventDefault();
    openTabMenu(t.dataset.pid, t);
  });
  list.addEventListener('pointerdown', e => {
    const t = e.target.closest('.tab');
    if (!t || e.pointerType === 'mouse') return;
    pressed = t; startX = e.clientX; startY = e.clientY;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      if (pressed && canEdit()) { suppressClick = true; openTabMenu(pressed.dataset.pid, pressed); }
      pressed = null;
    }, 550);
  });
  const cancel = e => {
    if (e && e.type === 'pointermove' && Math.hypot(e.clientX - startX, e.clientY - startY) < 10) return;
    clearTimeout(pressTimer); pressed = null;
  };
  list.addEventListener('pointerup', cancel);
  list.addEventListener('pointercancel', cancel);
  list.addEventListener('pointermove', cancel);
}

async function addPage() {
  if (!requireEditor()) return;
  const name = await promptBox({
    title: '新增分頁', label: '分頁名稱', value: `分頁 ${S.pages.length + 1}`, maxLength: 40, okText: '新增',
    validate: v => (!v ? '請輸入分頁名稱' : (S.pages.some(p => p.name === v) ? '已經有同名的分頁了' : '')),
    extra: done => {
      const b = h('button', { type: 'button', class: 'btn link', html: icon('upload') + '<span>從備份檔匯入…</span>' });
      b.addEventListener('click', () => { done(null); importBackup(); });
      return b;
    }
  });
  if (!name) return;
  try {
    const pid = await S.store.createPage(name, S.user, S.pages);
    S.pid = null;
    switchPage(pid);
    toast(`已新增分頁「${name}」`);
  } catch (e) { reportWriteError(e, '新增分頁失敗'); }
}

function openTabMenu(pid, anchor) {
  if (!canEdit()) return;
  const page = S.pages.find(p => p.id === pid);
  if (!page) return;
  const mk = (ic, text, fn, cls = '') => {
    const b = h('button', { type: 'button', class: 'btn block ' + cls, html: icon(ic) + `<span>${text}</span>` });
    b.addEventListener('click', () => { pop.close(); fn(); });
    return b;
  };
  const pop = popover(anchor, h('div', { class: 'menu' },
    mk('download', '下載備份檔案', () => downloadBackup(page)),
    mk('rename', '重新命名', () => renamePage(page)),
    mk('trash', '刪除', () => deletePage(page), 'danger-text')
  ), { title: page.name, className: 'pop-tab' });
}

const safeFileName = s => String(s || '分頁').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);

async function downloadBackup(page) {
  if (window.PR_PREVIEW) {
    await alertBox('這是預覽版，這裡不允許下載檔案。部署到 GitHub Pages 或 Firebase 之後就能下載備份。', { title: '下載備份檔案' });
    return;
  }
  const ok = await confirmBox(`是否要下載「${page.name}」的備份檔案（JSON 檔案）？`, { title: '下載備份檔案' });
  if (!ok) return;
  const busy = busyBox('打包備份中…');
  try {
    const data = await S.store.exportPage(page.id, (d, t) => busy.progress(d, t, '打包中'));
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    downloadBlob(blob, `戰力名單_${safeFileName(page.name)}_${fileStamp()}.json`);
    toast('已下載備份檔案');
  } catch (e) {
    await alertBox('備份失敗：' + (e.message || e));
  } finally { busy.close(); }
}

async function renamePage(page) {
  const name = await promptBox({
    title: '重新命名分頁', label: '分頁名稱', value: page.name, maxLength: 40, okText: '儲存',
    validate: v => (!v ? '請輸入分頁名稱' : (S.pages.some(p => p.name === v && p.id !== page.id) ? '已經有同名的分頁了' : ''))
  });
  if (!name || name === page.name) return;
  try { await S.store.renamePage(page.id, name); toast('已重新命名'); }
  catch (e) { reportWriteError(e, '重新命名失敗'); }
}

async function deletePage(page) {
  let n = 0;
  try { n = await S.store.countEntries(page.id); } catch (e) { reportWriteError(e, '讀取失敗'); return; }
  if (n > 0) {
    await alertBox(`這個分頁還有 ${n} 筆資料。\n你必須先把這 ${n} 筆資料全部刪除，才能刪掉這個分頁。`, { title: '無法刪除分頁' });
    return;
  }
  const ok = await confirmBox(`是否刪除分頁「${page.name}」？`, { title: '刪除分頁', danger: true });
  if (!ok) return;
  try {
    await S.store.deletePage(page.id);
    toast(`已刪除分頁「${page.name}」`);
  } catch (e) {
    if (e.message === 'NOT_EMPTY') await alertBox(`這個分頁還有 ${e.count} 筆資料，必須全部刪除後才能刪掉分頁。`);
    else reportWriteError(e, '刪除分頁失敗');
  }
}

function importBackup() {
  if (!requireEditor()) return;
  const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    let json;
    try { json = JSON.parse(await file.text()); }
    catch { await alertBox('這個檔案不是有效的備份檔（JSON 格式錯誤）。'); return; }
    if (!json || json.app !== 'power-roster') { await alertBox('這不是「戰力名單」的備份檔。'); return; }
    const count = Object.keys(json.entries || {}).length;
    const ok = await confirmBox(`要把備份檔「${(json.page && json.page.name) || '未命名'}」（${count} 筆名單）匯入成新的分頁嗎？`, { title: '從備份檔匯入' });
    if (!ok) return;
    const busy = busyBox('匯入中…');
    try {
      const res = await S.store.importPage(json, S.user, S.pages, (d, t) => busy.progress(d, t, '上傳媒體'));
      busy.close();
      S.pid = null;
      switchPage(res.pid);
      toast(`已匯入「${res.name}」，共 ${res.count} 筆`);
    } catch (e) {
      busy.close();
      reportWriteError(e, '匯入失敗');
    }
  });
  input.click();
}

// ---------------------------------------------------------------------------
// 名單列表
// ---------------------------------------------------------------------------
function sortEntries(list, key) {
  const a = [...list];
  const byCreated = (x, y) => (x.createdAt || 0) - (y.createdAt || 0) || (x.id < y.id ? -1 : 1);
  if (key === 'updated') a.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0) || byCreated(x, y));
  else if (key === 'powerDesc' || key === 'powerAsc') {
    const dir = key === 'powerDesc' ? -1 : 1;
    a.sort((x, y) => {
      const vx = powerValue(x.power), vy = powerValue(y.power);
      if (vx == null && vy == null) return byCreated(x, y);
      if (vx == null) return 1;
      if (vy == null) return -1;
      return (vx - vy) * dir || byCreated(x, y);
    });
  } else if (key === 'name') a.sort((x, y) => String(x.name || '').localeCompare(String(y.name || ''), 'zh-Hant') || byCreated(x, y));
  else a.sort(byCreated);
  return a;
}

function visibleEntries() {
  const q = S.search.toLowerCase();
  const list = q ? S.entries.filter(e => String(e.name || '').toLowerCase().includes(q)) : S.entries;
  const sorted = sortEntries(list, S.sort);
  // 置頂的排最前面（最後置頂的在最上面），其餘照選擇的排序
  const pinned = sorted.filter(e => e.pinnedAt).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
  return pinned.concat(sorted.filter(e => !e.pinnedAt));
}

function stateBox(iconName, title, text, action) {
  return h('div', { class: 'state' },
    h('div', { class: 'state-icon', html: icon(iconName) }),
    h('div', { class: 'state-title', text: title }),
    text ? h('div', { class: 'state-text', text }) : null,
    action || null);
}

const cardCache = new Map();

function renderList() {
  const list = $('#list');
  if (!list) return;
  const pager = $('#pager');
  const showPager = on => { pager.classList.toggle('is-off', !on); };

  if (S.fatal) {
    list.replaceChildren(stateBox('wifiOff', '網站無法啟動', S.fatal));
    showPager(false);
    return;
  }
  const lockedView = S.locked || (S.publicRead === false && !canEdit());
  if (lockedView) {
    const act = !S.user ? h('button', { type: 'button', class: 'btn primary', html: GOOGLE_G + '<span>登入編輯者帳號</span>', onClick: signIn }) : null;
    list.replaceChildren(stateBox('lock', '這份戰力名單目前不公開', S.user ? '你的帳號沒有檢視權限，請聯絡擁有者。' : '只有編輯者登入後才能看到內容。', act));
    showPager(false);
    return;
  }
  if (!S.store || !S.pagesLoaded) {
    list.replaceChildren(h('div', { class: 'state' }, h('div', { class: 'spinner' }), h('div', { class: 'state-text', text: '載入中…' })));
    showPager(false);
    return;
  }
  if (!S.pages.length) {
    list.replaceChildren(stateBox('plus', '還沒有任何分頁', canEdit() ? '按左下角的「+」新增第一個分頁，再用「新增表單」加入名單。' : (S.user ? '請等編輯者新增分頁。' : '還沒有內容。編輯者請先點左上角「編輯者」登入。')));
    showPager(false);
    return;
  }
  if (!S.entriesLoaded) {
    list.replaceChildren(h('div', { class: 'state' }, h('div', { class: 'spinner' }), h('div', { class: 'state-text', text: '載入名單中…' })));
    showPager(false);
    return;
  }

  const all = visibleEntries();
  const size = Math.max(1, Number(settings.pageSize) || 5);
  const pages = Math.max(1, Math.ceil(all.length / size));
  let focusId = null;
  if (S.focusEid) {
    // 剛新增或剛置頂的名單：跳到它所在的那一頁（資料可能稍後才同步回來，所以等最多 5 秒）
    const f = S.focusEid;
    const i = all.findIndex(e => e.id === f.id && (!f.when || f.when(e)));
    if (i >= 0) { S.listPage = Math.floor(i / size) + 1; focusId = S.focusEid.id; S.focusEid = null; }
    else if (Date.now() > S.focusEid.until) S.focusEid = null;
  }
  S.listPage = clamp(S.listPage, 1, pages);
  const slice = all.slice((S.listPage - 1) * size, S.listPage * size);

  if (!all.length) {
    if (S.search) list.replaceChildren(stateBox('search', `找不到名字含「${S.search}」的名單`, '換個關鍵字，或按「清除」看全部。'));
    else list.replaceChildren(stateBox('user', '這個分頁還沒有名單', canEdit() ? '按上方「新增表單」加入第一筆。' : ''));
  } else {
    list.replaceChildren(...slice.map(cardFor));
  }

  $('#pager-count').textContent = S.search ? `符合 ${all.length} 筆` : `共 ${all.length} 筆`;
  $('#pager-num').textContent = `${S.listPage} / ${pages}`;
  $('#btn-prev').disabled = S.listPage <= 1;
  $('#btn-next').disabled = S.listPage >= pages;
  showPager(true);

  if (focusId) {
    const el = list.querySelector(`.card[data-eid="${focusId}"]`);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  if (S.justSaved) {
    const el = list.querySelector(`.card[data-eid="${S.justSaved}"]`);
    if (el) {
      el.classList.remove('just');
      void el.offsetWidth;
      el.classList.add('just');
      setTimeout(() => el.classList.remove('just'), 900);
      S.justSaved = null;
    }
  }
}

const DEFAULT_AVATAR = 'img/default-avatar.jpg';
const defaultAvatar = () => h('img', { src: DEFAULT_AVATAR, alt: '', class: 'av-default' });

/** 頭像：有設定就顯示自己的圖，沒有就用預設頭像 */
function avatarEl(mid, scope, { full = false, pendingUrl = null } = {}) {
  const box = h('div', { class: 'av' });
  if (pendingUrl) { box.append(h('img', { src: pendingUrl, alt: '' })); return box; }
  if (mid) {
    const img = h('img', { alt: '' });
    box.append(img);
    const fallback = () => box.replaceChildren(defaultAvatar());
    const p = full ? S.store.getMediaUrl(scope, mid) : S.store.getThumb(scope, mid);
    p.then(u => { if (u) img.src = u; else fallback(); }, fallback);
    return box;
  }
  box.append(defaultAvatar());
  return box;
}

function stampEl(power) {
  const v = String(power || '').trim();
  return v ? h('span', { class: 'stamp', text: v }) : h('span', { class: 'stamp empty', text: '未填' });
}

function cardFor(e) {
  const ed = canEdit();
  const pinned = !!e.pinnedAt;
  const sig = [e.updatedAt, e.name, e.power, e.avatar, e.pinnedAt || 0, ed ? 1 : 0, (e.html || '').length].join('|');
  const cached = cardCache.get(e.id);
  if (cached && cached.sig === sig) return cached.el;

  const preview = h('div', { class: 'preview' });
  renderRich(preview, e.html || '', { store: S.store, scope: e.id, mode: 'preview' });
  const empty = htmlIsEmpty(e.html);
  const paper = h('div', { class: 'c-paper' }, preview);
  const checkClip = () => paper.classList.toggle('is-clipped', preview.scrollHeight > paper.clientHeight + 2);
  paper.addEventListener('load', checkClip, true);
  requestAnimationFrame(checkClip);
  const content = h('div', { class: 'c-content' + (empty ? ' is-empty' : ''), role: 'button', tabindex: '0', 'aria-label': `看「${e.name}」的完整內容` },
    h('div', { class: 'c-content-row' }, h('span', { class: 'c-content-lbl', text: '內容：' }), h('span', { class: 'c-more', text: '點開來看完整內容' })),
    empty ? h('div', { class: 'c-none', text: '（還沒有內容）' }) : paper);
  content.addEventListener('click', () => openEntry({ eid: e.id, mode: 'view' }));
  content.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openEntry({ eid: e.id, mode: 'view' }); } });

  let actions = null;
  if (ed) {
    const pinBtn = h('button', {
      type: 'button', class: 'btn sm pin-btn' + (pinned ? ' on' : ''), 'aria-pressed': pinned ? 'true' : 'false',
      title: pinned ? '已置頂，再按一次可以取消置頂' : '把這筆名單固定在最上面',
      html: icon('pin') + `<span>${pinned ? '已置頂' : '置頂'}</span>`
    });
    pinBtn.addEventListener('click', () => togglePin(e, pinBtn));
    const editBtn = h('button', { type: 'button', class: 'btn sm', text: '編輯' });
    editBtn.addEventListener('click', () => openEntry({ eid: e.id, mode: 'edit' }));
    const delBtn = h('button', { type: 'button', class: 'btn sm danger-text', text: '刪除' });
    delBtn.addEventListener('click', () => deleteEntry(e));
    actions = h('div', { class: 'c-actions' }, pinBtn, editBtn, delBtn);
  } else if (pinned) {
    actions = h('div', { class: 'c-actions' }, h('span', { class: 'pin-tag', html: icon('pin') + '<span>已置頂</span>' }));
  }

  const el = h('article', { class: 'card' + (pinned ? ' is-pinned' : ''), dataset: { eid: e.id }, 'aria-label': e.name },
    h('div', { class: 'c-av' }, avatarEl(e.avatar, e.id)),
    h('div', { class: 'c-name' }, h('span', { class: 'lbl', text: '名稱：' }), h('span', { class: 'nm', text: e.name })),
    h('div', { class: 'c-head' },
      h('div', { class: 'c-power' }, h('span', { class: 'lbl', text: '戰力：' }), stampEl(e.power)),
      actions,
      h('div', { class: 'c-time' }, h('span', { class: 'lbl', text: '上次更新時間:' }), h('time', { text: fmtTime(e.updatedAt || e.createdAt) }))),
    content);
  cardCache.set(e.id, { sig, el });
  if (cardCache.size > 300) cardCache.delete(cardCache.keys().next().value);
  return el;
}

/** 置頂 / 取消置頂（不算修改內容，不會改到上次更新時間） */
async function togglePin(e, btn) {
  if (!requireEditor()) return;
  const pin = !e.pinnedAt;
  btn.disabled = true;
  // 等置頂狀態真的更新後，再跳到那筆名單所在的頁面
  S.focusEid = { id: e.id, until: Date.now() + 5000, when: x => !!x.pinnedAt === pin };
  try {
    await S.store.setPinned(S.pid, e.id, pin);
    renderList();
    if (pin) toast('已置頂。再按一次「已置頂」就可以取消置頂', 'info', 4200);
    else toast('已取消置頂');
  } catch (err) {
    btn.disabled = false;
    S.focusEid = null;
    reportWriteError(err, pin ? '置頂失敗' : '取消置頂失敗');
  }
}

async function deleteEntry(e) {
  if (!requireEditor()) return;
  const ok = await confirmBox(`確定要刪除「${e.name}」嗎？\n這筆名單的內容和過往紀錄會一起刪除，無法復原。`, { title: '刪除名單', danger: true });
  if (!ok) return;
  const busy = busyBox('刪除中…');
  try { await S.store.deleteEntry(S.pid, e.id); toast(`已刪除「${e.name}」`); }
  catch (err) { reportWriteError(err, '刪除失敗'); }
  finally { busy.close(); }
}

// ---------------------------------------------------------------------------
// 新增 / 編輯 / 查看 名單視窗
// ---------------------------------------------------------------------------
function openEntry({ eid = null, mode = 'view' } = {}) {
  if (!S.pid) return;
  if (mode === 'edit' && !requireEditor()) return;
  if (OPEN) OPEN.close();
  const store = S.store;
  const M = {
    pid: S.pid, eid: eid || makeId(), isNew: !eid, wasNew: !eid,
    entry: eid ? (S.entries.find(x => x.id === eid) || null) : null,
    mode, prevMode: mode, dirty: false, editor: null, saving: false,
    avatar: null, avatarPending: new Map(), history: null, hIndex: 0
  };
  if (!M.isNew && !M.entry) { toast('找不到這筆資料，可能已經被刪除', 'warn'); return; }
  M.base = M.entry ? M.entry.updatedAt : null;
  M.avatar = M.entry ? (M.entry.avatar || null) : null;

  // ---- 元件 ----
  const closeX = h('button', { type: 'button', class: 'icon-btn modal-x', 'aria-label': '關閉', html: icon('x') });
  const avBox = h('div', { class: 'e-av-box' });
  const avHint = h('div', { class: 'e-av-hint', text: '點這裡設定頭像（不設定就用預設）' });
  const avRemove = h('button', { type: 'button', class: 'e-av-remove', title: '移除頭像', 'aria-label': '移除頭像', html: icon('x') });
  const avInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const avWrap = h('div', { class: 'e-av', role: 'button', 'aria-label': '頭像' }, avBox, avHint, avRemove, avInput);

  const powerInput = h('input', { type: 'text', class: 'e-input', id: 'e-power', maxlength: 40, placeholder: '例如 9850、S、12.5萬', autocomplete: 'off' });
  const nameInput = h('input', { type: 'text', class: 'e-input', id: 'e-name', maxlength: 60, placeholder: '名字（必填）', autocomplete: 'off' });
  const powerView = h('div', { class: 'e-view-val' });
  const nameView = h('div', { class: 'e-view-val e-name-view' });
  const fields = h('div', { class: 'e-fields' },
    h('div', { class: 'e-field' }, h('label', { class: 'e-lbl', for: 'e-power', text: '戰力' }), h('div', { class: 'e-val' }, powerInput, powerView)),
    h('div', { class: 'e-field' }, h('label', { class: 'e-lbl', for: 'e-name', text: '名字' }), h('div', { class: 'e-val' }, nameInput, nameView)));

  const contentHost = h('div', { class: 'e-content-host' });
  const contentBox = h('section', { class: 'e-content', 'aria-label': '內容' }, h('div', { class: 'e-content-title', text: '內容' }), contentHost);
  const foot = h('div', { class: 'e-foot' });
  const panel = h('div', { class: 'panel entry-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': M.isNew ? '新增名單' : `名單：${M.entry.name}` },
    closeX, h('div', { class: 'e-head' }, avWrap, fields), contentBox, foot);

  const layer = openLayer(panel, { className: 'layer-entry', onRequestClose: requestClose, closeOnBackdrop: false });

  // ---- 狀態 ----
  const markDirty = () => { if (M.mode === 'edit') M.dirty = true; };
  powerInput.addEventListener('input', markDirty);
  nameInput.addEventListener('input', markDirty);

  function ensureEditor() {
    if (M.editor) return;
    M.editor = new RichEditor({
      store, scope: M.eid, settings,
      placeholder: '在這裡打字，也可以插入圖片、GIF、影片或手繪。圖片可以設定文繞圖。',
      onChange: markDirty
    });
    M.editor.setHtml(M.entry ? M.entry.html : '');
    powerInput.value = M.entry ? (M.entry.power || '') : '';
    nameInput.value = M.entry ? (M.entry.name || '') : '';
  }

  function drawAvatar() {
    const editing = M.mode === 'edit';
    const pend = M.avatar ? M.avatarPending.get(M.avatar) : null;
    avBox.replaceChildren(avatarEl(M.avatar, M.eid, { full: true, pendingUrl: pend ? pend.url : null }));
    avWrap.classList.toggle('editable', editing);
    avWrap.tabIndex = editing ? 0 : -1;
    avHint.hidden = !editing;
    avRemove.hidden = !(editing && M.avatar);
  }

  const pickAvatar = () => { if (M.mode === 'edit') { avInput.value = ''; avInput.click(); } };
  avWrap.addEventListener('click', e => { if (e.target.closest('.e-av-remove')) return; pickAvatar(); });
  avWrap.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickAvatar(); } });
  avRemove.addEventListener('click', e => { e.stopPropagation(); M.avatar = null; markDirty(); drawAvatar(); });
  avInput.addEventListener('change', async () => {
    const file = avInput.files[0];
    if (!file) return;
    const busy = busyBox('處理頭像…');
    try {
      const m = await processAvatar(file);
      const mid = makeId();
      m.url = URL.createObjectURL(m.blob);
      M.avatarPending.set(mid, m);
      M.avatar = mid;
      markDirty();
      drawAvatar();
    } catch (err) { await alertBox(err.message || String(err)); }
    finally { busy.close(); }
  });

  // ---- 畫面 ----
  function btn(text, fn, cls = '', ic = null) {
    const b = h('button', { type: 'button', class: 'btn ' + cls, html: (ic ? icon(ic) : '') + `<span>${text}</span>` });
    b.addEventListener('click', fn);
    return b;
  }

  function render() {
    panel.dataset.mode = M.mode;
    if (M.mode === 'history') { renderHistory(); return; }
    const editing = M.mode === 'edit';
    const e = M.entry;
    if (editing) ensureEditor();
    powerInput.hidden = nameInput.hidden = !editing;
    powerView.hidden = nameView.hidden = editing;
    if (!editing) {
      powerView.replaceChildren(stampEl(e ? e.power : ''));
      nameView.textContent = e ? e.name : '';
    }
    drawAvatar();
    if (editing) contentHost.replaceChildren(M.editor.el);
    else {
      const v = h('div', { class: 'rc full' });
      renderRich(v, e ? e.html : '', { store, scope: M.eid, mode: 'full' });
      if (htmlIsEmpty(e ? e.html : '')) v.replaceChildren(h('p', { class: 'e-empty', text: '（還沒有內容）' }));
      contentHost.replaceChildren(h('div', { class: 'e-view-scroll' }, v));
    }
    renderFoot();
    panel.setAttribute('aria-label', M.isNew ? '新增名單' : `名單：${(e && e.name) || ''}`);
  }

  function renderFoot() {
    const editing = M.mode === 'edit';
    const left = [];
    if (M.isNew) left.push(h('div', { class: 'f-info' }, h('span', { text: '新增名單' })));
    else {
      left.push(h('div', { class: 'f-info' },
        h('span', { text: '上次更新時間:' }), h('time', { text: fmtTime(M.entry.updatedAt) }),
        M.entry.updatedBy ? h('span', { class: 'f-by', text: `（${M.entry.updatedBy}）` }) : null));
      left.push(btn('翻閱過往紀錄', openHistory, 'f-hist', 'history'));
    }
    const right = editing
      ? [btn('套用', () => save(false)), btn('確定', () => save(true), 'primary'), btn('取消', requestClose)]
      : [canEdit() ? btn('編輯', () => { M.mode = 'edit'; M.prevMode = 'edit'; render(); setTimeout(() => nameInput.focus(), 30); }, '', 'edit') : null, btn('關閉', requestClose)];
    foot.replaceChildren(h('div', { class: 'f-left' }, left), h('div', { class: 'f-right' }, right));
  }

  async function openHistory() {
    const busy = busyBox('讀取過往紀錄…');
    try { M.history = await store.listHistory(M.eid); }
    catch (err) { busy.close(); reportWriteError(err, '讀取過往紀錄失敗'); return; }
    busy.close();
    if (!M.history.length) { toast('這筆名單還沒有過往紀錄。之後每次修改並存檔，舊版本都會留在這裡。'); return; }
    M.prevMode = M.mode;
    M.mode = 'history';
    M.hIndex = 0;
    render();
  }

  function renderHistory() {
    const list = M.history;
    const rec = list[M.hIndex];
    avBox.replaceChildren(avatarEl(rec.avatar, M.eid, { full: true }));
    avWrap.classList.remove('editable');
    avWrap.tabIndex = -1;
    avHint.hidden = true;
    avRemove.hidden = true;
    powerInput.hidden = nameInput.hidden = true;
    powerView.hidden = nameView.hidden = false;
    powerView.replaceChildren(stampEl(rec.power));
    nameView.textContent = rec.name || '';
    const v = h('div', { class: 'rc full' });
    renderRich(v, rec.html || '', { store, scope: M.eid, mode: 'full' });
    if (htmlIsEmpty(rec.html)) v.replaceChildren(h('p', { class: 'e-empty', text: '（這個版本沒有內容）' }));
    contentHost.replaceChildren(h('div', { class: 'e-view-scroll' }, v));
    const n = list.length;
    const prev = btn('上一頁', () => { M.hIndex--; render(); }, '', 'chevLeft');
    const next = btn('下一頁', () => { M.hIndex++; render(); }, 'icon-right', 'chevRight');
    prev.disabled = M.hIndex <= 0;
    next.disabled = M.hIndex >= n - 1;
    const restore = M.prevMode === 'edit' && canEdit() ? btn('還原此版本', restoreVersion, '', 'undo') : null;
    const back = btn(M.prevMode === 'edit' ? '返回編輯' : '返回', () => { M.mode = M.prevMode; render(); }, 'primary');
    foot.replaceChildren(
      h('div', { class: 'f-left' },
        h('div', { class: 'f-info' }, h('span', { text: '當時紀錄:' }), h('time', { text: fmtTime(rec.at) }), rec.by ? h('span', { class: 'f-by', text: `（${rec.by}）` }) : null),
        h('div', { class: 'f-pages', text: `頁數:${M.hIndex + 1}/${n}` })),
      h('div', { class: 'f-right' }, prev, next, restore, back));
  }

  function restoreVersion() {
    const rec = M.history[M.hIndex];
    ensureEditor();
    powerInput.value = rec.power || '';
    nameInput.value = rec.name || '';
    M.editor.replaceHtml(rec.html || '');
    M.avatar = rec.avatar || null;
    M.mode = 'edit';
    M.dirty = true;
    render();
    toast('已載入這個版本。按「套用」或「確定」才會儲存。');
  }

  async function save(close) {
    if (M.saving) return;
    const name = nameInput.value.trim();
    const power = powerInput.value.trim();
    if (!name) { await alertBox('請先填寫名字。'); nameInput.focus(); return; }
    const html = M.editor.getHtml();
    const same = !M.isNew && M.entry && html === (M.entry.html || '') && name === M.entry.name &&
      power === (M.entry.power || '') && (M.avatar || null) === (M.entry.avatar || null);
    if (!M.isNew && (!M.dirty || same)) {
      M.dirty = false;
      if (close) finish(); else toast('沒有需要儲存的變更');
      return;
    }
    const pending = new Map([...M.editor.pending, ...M.avatarPending]);
    M.saving = true;
    let busy = busyBox('儲存中…');
    let saved = null;
    let force = false;
    for (;;) {
      try {
        saved = await store.saveEntry({
          pid: M.pid, eid: M.eid, data: { name, power, avatar: M.avatar, html },
          baseUpdatedAt: M.isNew ? null : M.base, force, pending, user: S.user,
          onProgress: (d, t) => busy.progress(d, t, '上傳媒體')
        });
        break;
      } catch (err) {
        busy.close();
        if (!force && (err.message === 'CONFLICT' || err.message === 'GONE')) {
          const cur = err.current;
          const msg = err.message === 'GONE'
            ? '這筆名單在你編輯的期間被刪除了。要用你現在的內容重新建立嗎？'
            : `這筆名單在你編輯的期間，被「${(cur && cur.updatedBy) || '其他人'}」在 ${fmtTime(cur && cur.updatedAt)} 改過了。\n要用你現在的內容覆蓋嗎？（對方的版本會保留在過往紀錄裡）`;
          if (await confirmBox(msg, { title: '有人同時在編輯' })) { force = true; busy = busyBox('儲存中…'); continue; }
          M.saving = false;
          return;
        }
        M.saving = false;
        reportWriteError(err, '儲存失敗');
        return;
      }
    }
    busy.close();
    M.saving = false;
    const refs = collectRefs(html, M.avatar);
    M.editor.markSaved(refs);
    for (const mid of [...M.avatarPending.keys()]) if (refs.has(mid)) M.avatarPending.delete(mid);
    M.entry = { ...saved, id: M.eid };
    M.base = saved.updatedAt;
    M.isNew = false;
    M.dirty = false;
    M.history = null;
    S.justSaved = M.eid;
    if (M.wasNew) { S.focusEid = { id: M.eid, until: Date.now() + 5000 }; M.wasNew = false; }
    renderList();
    toast(close ? '已儲存' : '已套用');
    if (close) finish(); else render();
  }

  async function requestClose() {
    if (M.saving) return;
    if (M.dirty) {
      const ok = await confirmBox('還沒儲存的修改會消失，確定要關閉嗎？', { title: '關閉視窗' });
      if (!ok) return;
    }
    finish();
  }

  function finish() {
    layer.close();
    if (M.editor) M.editor.destroy();
    for (const m of M.avatarPending.values()) if (m.url) URL.revokeObjectURL(m.url);
    M.avatarPending.clear();
    if (OPEN === api) OPEN = null;
  }

  closeX.addEventListener('click', requestClose);

  const api = {
    close: finish,
    refresh() {
      if (M.isNew || M.mode !== 'view') return;
      const cur = S.entries.find(x => x.id === M.eid);
      if (!cur) { toast('這筆名單已經被刪除了', 'warn'); finish(); return; }
      if (cur.updatedAt !== (M.entry && M.entry.updatedAt)) { M.entry = cur; M.base = cur.updatedAt; render(); }
    }
  };
  OPEN = api;
  render();
  if (mode === 'edit') setTimeout(() => (M.isNew ? nameInput : nameInput).focus(), 40);
}

// ---------------------------------------------------------------------------
// 戰力評分方式
// ---------------------------------------------------------------------------
async function openRating() {
  if (!S.pid) {
    toast(canEdit() ? '請先按左下角的 + 新增一個分頁' : '目前還沒有分頁', 'warn');
    return;
  }
  const pid = S.pid;
  const page = S.pages.find(p => p.id === pid);
  let rec = null;
  const busy = busyBox('讀取中…');
  try { rec = await S.store.getRating(pid); }
  catch (e) { busy.close(); reportWriteError(e, '讀取失敗'); return; }
  busy.close();

  let mode = 'view', editor = null, dirty = false, saving = false;
  const left = h('div', { class: 'r-left' });
  const closeX = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '關閉', html: icon('x') });
  const sub = h('div', { class: 'r-sub' });
  const body = h('div', { class: 'r-body' });
  const panel = h('div', { class: 'panel rating-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '戰力評分方式' },
    h('div', { class: 'r-head' }, left, h('div', { class: 'r-titles' }, h('div', { class: 'r-title', text: '戰力評分方式' }), sub), h('div', { class: 'r-right' }, closeX)),
    body);
  const layer = openLayer(panel, { className: 'layer-rating', onRequestClose: requestClose, closeOnBackdrop: true });
  closeX.addEventListener('click', requestClose);

  function mk(text, fn, cls = '', ic = null) {
    const b = h('button', { type: 'button', class: 'btn sm ' + cls, html: (ic ? icon(ic) : '') + `<span>${text}</span>` });
    b.addEventListener('click', fn);
    return b;
  }

  function render() {
    panel.dataset.mode = mode;
    sub.textContent = page ? `分頁：${page.name}` : '';
    if (mode === 'view') {
      left.replaceChildren(canEdit() ? mk('編輯', startEdit, '', 'edit') : '');
      const v = h('div', { class: 'rc full' });
      renderRich(v, rec ? rec.html : '', { store: S.store, scope: rateScope(pid), mode: 'full' });
      if (htmlIsEmpty(rec ? rec.html : '')) v.replaceChildren(h('p', { class: 'e-empty', text: canEdit() ? '還沒有寫評分方式。按左上角的「編輯」開始寫，可以打字、放圖片、GIF、影片或手繪。' : '還沒有寫評分方式。' }));
      const meta = rec && rec.updatedAt ? h('div', { class: 'r-meta' }, h('span', { text: '上次更新時間:' }), h('time', { text: fmtTime(rec.updatedAt) }), rec.updatedBy ? h('span', { text: `（${rec.updatedBy}）` }) : null) : null;
      body.replaceChildren(h('div', { class: 'e-view-scroll r-scroll' }, v), meta);
    } else {
      left.replaceChildren(mk('儲存', save, 'primary', 'check'), mk('取消', cancelEdit));
      body.replaceChildren(editor.el);
    }
  }

  function startEdit() {
    if (!requireEditor()) return;
    editor = new RichEditor({ store: S.store, scope: rateScope(pid), settings, placeholder: '寫下你的戰力評分方式，例如分數怎麼算、各等級代表什麼…', onChange: () => { dirty = true; } });
    editor.setHtml(rec ? rec.html : '');
    mode = 'edit';
    dirty = false;
    render();
    setTimeout(() => editor.focus(), 30);
  }

  async function cancelEdit() {
    if (dirty && !(await confirmBox('還沒儲存的修改會消失，確定要取消嗎？'))) return;
    if (editor) { editor.destroy(); editor = null; }
    mode = 'view';
    dirty = false;
    render();
  }

  async function save() {
    if (saving) return;
    if (!dirty) { await cancelEdit(); return; }
    const html = editor.getHtml();
    saving = true;
    const b = busyBox('儲存中…');
    try {
      rec = await S.store.saveRating({ pid, html, pending: editor.pending, user: S.user, onProgress: (d, t) => b.progress(d, t, '上傳媒體') });
      editor.markSaved(collectRefs(html));
      editor.destroy();
      editor = null;
      mode = 'view';
      dirty = false;
      render();
      toast('已儲存戰力評分方式');
    } catch (e) {
      reportWriteError(e, '儲存失敗');
    } finally { saving = false; b.close(); }
  }

  async function requestClose() {
    if (saving) return;
    if (mode === 'edit' && dirty && !(await confirmBox('還沒儲存的修改會消失，確定要關閉嗎？', { title: '關閉視窗' }))) return;
    if (editor) editor.destroy();
    layer.close();
  }

  render();
}

// ---------------------------------------------------------------------------
// 帳號
// ---------------------------------------------------------------------------
async function signIn() {
  try { await S.adapter.signIn(); }
  catch (e) {
    const code = (e && e.code) || '';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
    const f = AUTH_ERRORS[code];
    await alertBox(f ? f() : `登入失敗：${(e && e.message) || code}`, { title: '無法登入' });
  }
}

async function signOut() {
  try { await S.adapter.signOut(); toast('已登出'); }
  catch (e) { alertBox('登出失敗：' + (e.message || e)); }
}

async function offerClaim() {
  const ok = await confirmBox(`這個網站還沒有擁有者。\n要把你（${S.user.name}）設為擁有者嗎？擁有者可以編輯所有內容，也能決定還有誰可以編輯。`, { title: '設定擁有者', yes: '設為擁有者', no: '先不要' });
  if (!ok) return;
  try {
    await S.store.claimOwner(S.user.uid);
    toast('你現在是這個網站的擁有者了');
    await onAuth(S.user);
  } catch (e) {
    await alertBox(isPermissionError(e) ? '已經有人先成為擁有者了。' : '設定失敗：' + (e.message || e));
    await onAuth(S.user);
  }
}

function requireEditor() {
  if (canEdit()) return true;
  if (!S.user) {
    confirmBox('需要登入編輯者帳號才能編輯。要現在登入嗎？', { title: '需要登入', yes: '登入', no: '先不要' }).then(ok => { if (ok) signIn(); });
  } else {
    alertBox('你的帳號沒有編輯權限。請擁有者把你的 Email 加入編輯者名單。');
  }
  return false;
}

function reportWriteError(e, prefix) {
  if (isPermissionError(e)) {
    alertBox(S.user ? '你的帳號沒有權限做這件事。請擁有者把你的 Email 加入編輯者名單。' : '需要登入編輯者帳號才能做這件事。', { title: prefix });
  } else {
    alertBox(`${prefix}：${(e && e.message) || e}`);
  }
}

function openWhoMenu() {
  const anchor = $('#btn-who');
  const A = S.adapter;
  if (!A) return;
  const box = h('div', { class: 'who-menu' });
  let pop = null;
  const mk = (htmlLabel, fn, cls = '') => {
    const b = h('button', { type: 'button', class: 'btn block ' + cls, html: htmlLabel });
    b.addEventListener('click', () => { if (pop) pop.close(); fn(); });
    return b;
  };

  if (A.mode === 'local') {
    box.append(h('p', { class: 'who-note', text: '目前是「示範模式」，資料只存在這台電腦的瀏覽器裡。把 Firebase 設定填進 js/config.js 之後，就會改用 Firebase，所有人看到的會是同一份資料。' }));
    if (S.user) box.append(mk(icon('user') + '<span>切換成訪客檢視</span>', signOut));
    else box.append(mk(icon('edit') + '<span>切回編輯者</span>', signIn, 'primary'));
  } else if (!S.user) {
    box.append(h('p', { class: 'who-note', text: '目前只能瀏覽。登入編輯者帳號後，才能新增、編輯和刪除。' }));
    box.append(mk(GOOGLE_G + '<span>使用 Google 登入</span>', signIn, 'primary'));
  } else {
    const roleText = { owner: '擁有者', editor: '編輯者', viewer: '僅檢視（沒有編輯權限）' }[S.role] || '';
    box.append(h('div', { class: 'who-user' },
      h('img', { class: 'who-photo', src: S.user.photo || DEFAULT_AVATAR, alt: '', referrerpolicy: 'no-referrer' }),
      h('div', { class: 'who-meta' }, h('div', { class: 'who-n', text: S.user.name }), h('div', { class: 'who-e', text: S.user.email }), h('div', { class: 'who-r', text: roleText }))));
    if (!S.ownerExists) box.append(mk(icon('check') + '<span>設為擁有者</span>', offerClaim, 'primary'));
    else if (S.role === 'viewer') box.append(h('p', { class: 'who-note', text: '請擁有者把你的 Email 加入編輯者名單，重新整理網頁後就能編輯。' }));
    if (S.role === 'owner') {
      box.append(editorsSection(), publicToggle());
    }
    box.append(mk(icon('logout') + '<span>登出</span>', signOut));
  }
  pop = popover(anchor, box, { title: '編輯者', className: 'pop-who' });
}

function publicToggle() {
  const id = 'pub-toggle';
  const cb = h('input', { type: 'checkbox', id });
  cb.checked = S.publicRead !== false;
  cb.addEventListener('change', async () => {
    try { await S.store.setPublicRead(cb.checked); toast(cb.checked ? '已設為公開：任何拿到網址的人都能看' : '已設為不公開：只有編輯者登入後能看'); }
    catch (e) { cb.checked = !cb.checked; reportWriteError(e, '設定失敗'); }
  });
  return h('label', { class: 'who-toggle', for: id }, cb, h('span', {}, h('b', { text: '公開檢視' }), h('small', { text: '開啟時，沒登入的人也能看名單（不能編輯）' })));
}

function editorsSection() {
  const list = h('ul', { class: 'ed-list' }, h('li', { class: 'muted', text: '讀取中…' }));
  const input = h('input', { type: 'email', class: 'field-input', id: 'add-editor', placeholder: '輸入 Google 帳號 Email', autocomplete: 'off' });
  const addBtn = h('button', { type: 'button', class: 'btn sm primary', text: '新增' });
  const load = async () => {
    try {
      const emails = await S.store.listEditors();
      list.replaceChildren(...(emails.length ? emails.map(em => {
        const rm = h('button', { type: 'button', class: 'btn sm danger-text', text: '移除' });
        rm.addEventListener('click', async () => {
          if (!(await confirmBox(`把 ${em} 移出編輯者名單？`))) return;
          try { await S.store.removeEditor(em); load(); } catch (e) { reportWriteError(e, '移除失敗'); }
        });
        return h('li', {}, h('span', { class: 'ed-mail', text: em }), rm);
      }) : [h('li', { class: 'muted', text: '還沒有其他編輯者' })]));
    } catch (e) { list.replaceChildren(h('li', { class: 'muted', text: '讀取失敗' })); }
  };
  const add = async () => {
    const v = input.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /[#$[\]/]/.test(v)) { toast('請輸入正確的 Email', 'warn'); input.focus(); return; }
    try { await S.store.addEditor(v); input.value = ''; load(); toast(`已加入 ${v}`); }
    catch (e) { reportWriteError(e, '新增失敗'); }
  };
  addBtn.addEventListener('click', add);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } });
  load();
  return h('div', { class: 'who-editors' },
    h('div', { class: 'who-sec', text: '編輯者名單' }),
    h('p', { class: 'who-small', text: '名單裡的 Google 帳號登入後就能編輯。' }),
    list, h('div', { class: 'who-add' }, input, addBtn));
}

boot();
