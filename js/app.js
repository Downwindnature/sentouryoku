// 戰力名單 — 主程式
import { firebaseConfig, settings } from './config.js';
import { h, $, fmtTime, fileStamp, makeId, ls, isPermissionError, downloadBlob, powerValue, debounce, clamp } from './util.js';
import { icon } from './icons.js';
import { createLocalAdapter } from './adapter-local.js';
import { createStore, collectRefs, rateScope } from './store.js';
import { RichEditor, renderRich, htmlIsEmpty } from './editor.js';
import { processAvatar } from './media.js';
import { openLayer, confirmBox, alertBox, toast, busyBox, popover } from './ui.js';

const SORTS = [
  ['created', '新增順序'],
  ['updated', '最近更新'],
  ['powerDesc', '戰力高→低'],
  ['powerAsc', '戰力低→高'],
  ['name', '名字']
];

const NAME_MAX = 20;

const S = {
  adapter: null, store: null,
  writeError: null, locked: false,
  pages: [], pagesLoaded: false, pid: ls.get('pr-current-page'),
  entries: [], entriesLoaded: false,
  search: '', sort: ls.get('pr-sort', 'created'), listPage: 1,
  online: true, justSaved: null, focusEid: null, fatal: null
};
if (!SORTS.some(([k]) => k === S.sort)) S.sort = 'created';

// 任何人都可以看、也可以編輯；「編輯者」是每個分頁各自的名字（新增分頁時填寫）
const canEdit = () => !!S.store && !S.fatal;
const currentPage = () => S.pages.find(p => p.id === S.pid) || null;
const me = () => ({ name: (currentPage() || {}).editor || '' });
const lastEditor = () => String(ls.get('pr-editor-name', '') || '').trim().slice(0, NAME_MAX);
let OPEN = null; // 目前開著的名單視窗（用來即時更新）

const WRITE_ERRORS = {
  'auth/operation-not-allowed': '編輯功能還沒開啟：請到 Firebase 主控台 → Authentication → 登入方式，啟用「匿名」。',
  'auth/admin-restricted-operation': '編輯功能還沒開啟：請到 Firebase 主控台 → Authentication → 登入方式，啟用「匿名」。',
  'auth/configuration-not-found': 'Firebase 還沒啟用 Authentication：請到 Firebase 主控台 → Authentication → 開始使用，然後在登入方式啟用「匿名」。',
  'auth/network-request-failed': '網路連線失敗，請確認網路之後再試一次。',
  'auth/invalid-api-key': 'js/config.js 裡的 apiKey 不正確，請重新從 Firebase 主控台複製。',
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'js/config.js 裡的 apiKey 不正確，請重新從 Firebase 主控台複製。'
};

function writeErrorText(e) {
  const code = (e && e.code) || '';
  if (WRITE_ERRORS[code]) return WRITE_ERRORS[code];
  if (isPermissionError(e)) return '資料庫拒絕寫入。請確認 Firebase 的 Realtime Database「規則」已經換成 database.rules.json 的內容並按了「發布」，而且 Authentication 已經啟用「匿名」登入。';
  return (e && e.message) || String(e);
}

function reportWriteError(e, prefix) {
  alertBox(writeErrorText(e), { title: prefix });
}

/**
 * 新增分頁／修改分頁的視窗：分頁名稱 + 編輯者
 * 回傳 {name, editor}，按「從備份檔匯入」回傳 {import:true, editor}，取消回傳 null
 */
function pageFormBox({ title, name = '', editor = '', okText = '確定', withImport = false, excludeId = null }) {
  return new Promise(resolve => {
    const nameInput = h('input', { type: 'text', class: 'field-input', id: 'pf-name', maxlength: 40, autocomplete: 'off' });
    nameInput.value = name;
    const editorInput = h('input', { type: 'text', class: 'who-input', id: 'pf-editor', size: 8, maxlength: NAME_MAX, placeholder: '你的名字', autocomplete: 'nickname' });
    editorInput.value = editor;
    const err = h('div', { class: 'dlg-err', role: 'alert' });
    const okBtn = h('button', { type: 'button', class: 'btn primary', text: okText });
    const noBtn = h('button', { type: 'button', class: 'btn', text: '取消' });
    let importBtn = null;
    if (withImport) importBtn = h('button', { type: 'button', class: 'btn link', html: icon('upload') + '<span>從備份檔匯入…</span>' });
    const panel = h('div', { class: 'panel dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pf-title' },
      h('div', { class: 'dlg-title', id: 'pf-title', text: title }),
      h('label', { class: 'dlg-label', for: 'pf-name', text: '分頁名稱' }),
      nameInput, err,
      h('div', { class: 'dlg-btns pf-row' },
        h('label', { class: 'who pf-editor', for: 'pf-editor' }, h('span', { class: 'who-label', text: '編輯者：' }), editorInput),
        h('div', { class: 'pf-actions' }, okBtn, noBtn)),
      importBtn ? h('div', { class: 'dlg-extra' }, importBtn) : null);
    const layer = openLayer(panel, { className: 'layer-dialog', onRequestClose: () => done(null) });
    function done(v) { layer.close(); resolve(v); }
    const submit = () => {
      const n = nameInput.value.trim();
      const ed = editorInput.value.trim().slice(0, NAME_MAX);
      if (!n) { err.textContent = '請輸入分頁名稱'; nameInput.focus(); return; }
      if (S.pages.some(p => p.name === n && p.id !== excludeId)) { err.textContent = '已經有同名的分頁了'; nameInput.focus(); return; }
      if (!ed) { err.textContent = '請輸入編輯者'; editorInput.focus(); return; }
      done({ name: n, editor: ed });
    };
    okBtn.addEventListener('click', submit);
    noBtn.addEventListener('click', () => done(null));
    if (importBtn) importBtn.addEventListener('click', () => done({ import: true, editor: editorInput.value.trim().slice(0, NAME_MAX) }));
    for (const inp of [nameInput, editorInput]) {
      inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
    }
    requestAnimationFrame(() => { nameInput.focus(); nameInput.select(); });
  });
}

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
    renderChrome();
    return;
  }
  S.store = createStore(S.adapter);
  document.documentElement.dataset.mode = S.adapter.mode;
  renderWho();
  renderChrome();

  let offlineTimer = null;
  S.adapter.onConnection(on => {
    clearTimeout(offlineTimer);
    if (on) { S.online = true; renderWho(); }
    else offlineTimer = setTimeout(() => { S.online = false; renderWho(); }, 3000);
  });
  // 背景完成匿名登入；失敗時大家還是可以瀏覽，只是不能存檔
  S.adapter.ready().catch(e => {
    S.writeError = e;
    toast('目前只能瀏覽，不能存檔：' + writeErrorText(e), 'warn', 9000);
  });
  subscribePages();
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
  $('#btn-new').addEventListener('click', () => {
    if (!S.pid) { toast('請先按左下角的 + 新增一個分頁', 'warn'); return; }
    openEntry({ mode: 'edit' });
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
}

function scrollListTop() { const l = $('#list'); if (l) l.scrollTop = 0; }

function renderSortSelect() {
  const sel = $('#sort-select');
  sel.replaceChildren(...SORTS.map(([k, label]) => h('option', { value: k, text: label })));
  sel.value = S.sort;
}

/** 左上角：顯示目前分頁的編輯者（只能看，要改請到分頁選單） */
function renderWho() {
  const chips = $('#who-chips');
  const nameEl = $('#who-name');
  if (!chips || !nameEl) return;
  const page = currentPage();
  const ed = page && page.editor;
  nameEl.textContent = ed || (page ? '未填' : '—');
  nameEl.classList.toggle('muted', !ed);
  $('#who').title = !page ? '新增分頁時填寫編輯者' : (ed ? `「${page.name}」的編輯者` : '這個分頁還沒填編輯者：點下方的分頁 →「修改名稱與編輯者」');
  const kids = [];
  if (S.adapter && S.adapter.mode === 'local') {
    kids.push(h('span', { class: 'chip', text: '示範模式', title: '資料只存在這台電腦的瀏覽器裡。在 js/config.js 填好 Firebase 設定後，大家就會看到同一份資料。' }));
  }
  if (!S.online) kids.push(h('span', { class: 'chip chip-warn', html: icon('wifiOff') + '<span>離線</span>' }));
  chips.replaceChildren(...kids);
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
  renderWho();
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
  const res = await pageFormBox({ title: '新增分頁', name: `分頁 ${S.pages.length + 1}`, editor: lastEditor(), okText: '新增', withImport: true });
  if (!res) return;
  if (res.editor) ls.set('pr-editor-name', res.editor);
  if (res.import) { importBackup(res.editor); return; }
  try {
    const pid = await S.store.createPage(res.name, res.editor, S.pages);
    S.pid = null;
    switchPage(pid);
    toast(`已新增分頁「${res.name}」`);
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
    mk('rename', '修改名稱與編輯者', () => renamePage(page)),
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
  const res = await pageFormBox({ title: '修改分頁', name: page.name, editor: page.editor || lastEditor(), okText: '儲存', excludeId: page.id });
  if (!res || (res.name === page.name && res.editor === (page.editor || ''))) return;
  ls.set('pr-editor-name', res.editor);
  try { await S.store.updatePage(page.id, { name: res.name, editor: res.editor }); toast('已儲存'); }
  catch (e) { reportWriteError(e, '修改失敗'); }
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

async function importBackup(editor = '') {
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
      const res = await S.store.importPage(json, { name: editor || lastEditor() }, S.pages, (d, t) => busy.progress(d, t, '上傳媒體'));
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
  if (S.locked) {
    list.replaceChildren(stateBox('lock', '無法讀取資料', 'Firebase 的資料庫規則不允許讀取。\n請到 Realtime Database → 規則，貼上 database.rules.json 的內容並按「發布」。'));
    showPager(false);
    return;
  }
  if (!S.store || !S.pagesLoaded) {
    list.replaceChildren(h('div', { class: 'state' }, h('div', { class: 'spinner' }), h('div', { class: 'state-text', text: '載入中…' })));
    showPager(false);
    return;
  }
  if (!S.pages.length) {
    list.replaceChildren(stateBox('plus', '還沒有任何分頁', '按左下角的「+」新增第一個分頁，再用「新增表單」加入名單。'));
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
        h('span', { text: '上次更新時間:' }), h('time', { text: fmtTime(M.entry.updatedAt) })));
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
        h('div', { class: 'f-info' }, h('span', { text: '當時紀錄:' }), h('time', { text: fmtTime(rec.at) })),
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
    if (M.editor.jobs) {
      M.saving = true;
      const wait = busyBox('圖片處理中，處理完就會存檔…');
      await M.editor.whenIdle();
      wait.close();
      M.saving = false;
    }
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
          baseUpdatedAt: M.isNew ? null : M.base, force, pending, user: me(),
          onProgress: (d, t) => busy.progress(d, t, '上傳媒體')
        });
        break;
      } catch (err) {
        busy.close();
        if (!force && (err.message === 'CONFLICT' || err.message === 'GONE')) {
          const cur = err.current;
          const msg = err.message === 'GONE'
            ? '這筆名單在你編輯的期間被刪除了。要用你現在的內容重新建立嗎？'
            : `這筆名單在你編輯的期間，已經在 ${fmtTime(cur && cur.updatedAt)} 被其他人改過了。\n要用你現在的內容覆蓋嗎？（對方的版本會保留在過往紀錄裡）`;
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
      const meta = rec && rec.updatedAt ? h('div', { class: 'r-meta' }, h('span', { text: '上次更新時間:' }), h('time', { text: fmtTime(rec.updatedAt) })) : null;
      body.replaceChildren(h('div', { class: 'e-view-scroll r-scroll' }, v), meta);
    } else {
      left.replaceChildren(mk('儲存', save, 'primary', 'check'), mk('取消', cancelEdit));
      body.replaceChildren(editor.el);
    }
  }

  function startEdit() {
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
    if (editor.jobs) {
      saving = true;
      const wait = busyBox('圖片處理中，處理完就會存檔…');
      await editor.whenIdle();
      wait.close();
      saving = false;
    }
    if (!dirty) { await cancelEdit(); return; }
    const html = editor.getHtml();
    saving = true;
    const b = busyBox('儲存中…');
    try {
      rec = await S.store.saveRating({ pid, html, pending: editor.pending, user: me(), onProgress: (d, t) => b.progress(d, t, '上傳媒體') });
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

boot();
