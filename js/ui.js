// 視窗、確認框、提示訊息
import { h } from './util.js';
import { icon } from './icons.js';

const stack = [];

/** 開一層視窗（背後是半透明遮罩）；Esc 或點遮罩會呼叫 onRequestClose */
export function openLayer(panel, { className = '', onRequestClose = null, closeOnBackdrop = true } = {}) {
  const prevFocus = document.activeElement;
  const back = h('div', { class: 'layer ' + className });
  back.append(panel);
  let downOnBack = false;
  back.addEventListener('pointerdown', e => { downOnBack = e.target === back; });
  back.addEventListener('click', e => {
    if (e.target === back && downOnBack && closeOnBackdrop) request();
    downOnBack = false;
  });
  const entry = { back, request: () => request() };
  function request() { if (onRequestClose) onRequestClose(); else api.close(); }
  const api = {
    el: back,
    closed: false,
    close() {
      if (api.closed) return;
      api.closed = true;
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      back.remove();
      if (!stack.length) document.documentElement.classList.remove('has-layer');
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) { try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
    }
  };
  stack.push(entry);
  document.body.append(back);
  document.documentElement.classList.add('has-layer');
  requestAnimationFrame(() => {
    const f = panel.querySelector('[autofocus]') || panel.querySelector('.btn.primary') || panel.querySelector('button, input, select, textarea, [tabindex="0"]');
    if (f && !panel.contains(document.activeElement)) { try { f.focus({ preventScroll: true }); } catch { /* ignore */ } }
  });
  return api;
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !stack.length) return;
  if (e.defaultPrevented) return;
  e.preventDefault();
  stack[stack.length - 1].request();
});

/** 是 / 否 確認框 */
export function confirmBox(message, { title = '', yes = '是', no = '否', danger = false } = {}) {
  return new Promise(resolve => {
    const yesBtn = h('button', { type: 'button', class: 'btn primary' + (danger ? ' danger' : ''), text: yes });
    const noBtn = h('button', { type: 'button', class: 'btn', text: no });
    const panel = h('div', { class: 'panel dialog', role: 'alertdialog', 'aria-modal': 'true' },
      title ? h('div', { class: 'dlg-title', text: title }) : null,
      h('div', { class: 'dlg-msg', text: message }),
      h('div', { class: 'dlg-btns' }, yesBtn, noBtn));
    const layer = openLayer(panel, { className: 'layer-dialog', onRequestClose: () => done(false) });
    function done(v) { layer.close(); resolve(v); }
    yesBtn.addEventListener('click', () => done(true));
    noBtn.addEventListener('click', () => done(false));
  });
}

export function alertBox(message, { title = '', ok = '知道了' } = {}) {
  return new Promise(resolve => {
    const okBtn = h('button', { type: 'button', class: 'btn primary', text: ok });
    const panel = h('div', { class: 'panel dialog', role: 'alertdialog', 'aria-modal': 'true' },
      title ? h('div', { class: 'dlg-title', text: title }) : null,
      h('div', { class: 'dlg-msg', text: message }),
      h('div', { class: 'dlg-btns' }, okBtn));
    const layer = openLayer(panel, { className: 'layer-dialog', onRequestClose: () => done() });
    function done() { layer.close(); resolve(); }
    okBtn.addEventListener('click', done);
  });
}

/** 輸入框；extra 可以放額外的按鈕（例如「從備份檔匯入」） */
export function promptBox({ title, label = '', value = '', placeholder = '', maxLength = 40, okText = '確定', cancelText = '取消', extra = null, validate = null } = {}) {
  return new Promise(resolve => {
    const id = 'pr-prompt-' + Math.random().toString(36).slice(2, 8);
    const input = h('input', { type: 'text', class: 'field-input', id, value, placeholder, maxlength: maxLength, autocomplete: 'off', autofocus: true });
    const err = h('div', { class: 'dlg-err', role: 'alert' });
    const okBtn = h('button', { type: 'button', class: 'btn primary', text: okText });
    const noBtn = h('button', { type: 'button', class: 'btn', text: cancelText });
    const panel = h('div', { class: 'panel dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id + '-t' },
      h('div', { class: 'dlg-title', id: id + '-t', text: title }),
      label ? h('label', { class: 'dlg-label', for: id, text: label }) : null,
      input, err,
      h('div', { class: 'dlg-btns' }, okBtn, noBtn),
      extra ? h('div', { class: 'dlg-extra' }, extra(done)) : null);
    const layer = openLayer(panel, { className: 'layer-dialog', onRequestClose: () => done(null) });
    function done(v) { layer.close(); resolve(v); }
    const submit = () => {
      const v = input.value.trim();
      const msg = validate ? validate(v) : (v ? '' : '請輸入內容');
      if (msg) { err.textContent = msg; input.focus(); return; }
      done(v);
    };
    okBtn.addEventListener('click', submit);
    noBtn.addEventListener('click', () => done(null));
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}

/** 底部提示訊息 */
let toastBox = null;
export function toast(message, type = 'info', ms = 2800) {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  for (const old of [...toastBox.children]) if (old.textContent === message) old.remove(); // 同樣的訊息不要疊好幾個
  const t = h('div', { class: 'toast ' + type, text: message });
  toastBox.append(t);
  while (toastBox.children.length > 3) toastBox.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

/** 忙碌中遮罩（可顯示進度） */
export function busyBox(text = '處理中…') {
  const label = h('div', { class: 'busy-text', text });
  const bar = h('div', { class: 'busy-bar', hidden: true }, h('i'));
  const panel = h('div', { class: 'panel busy', role: 'status', 'aria-live': 'polite' }, h('div', { class: 'spinner' }), label, bar);
  const back = h('div', { class: 'layer layer-busy' }, panel);
  let shown = false;
  const timer = setTimeout(() => { document.body.append(back); shown = true; }, 120);
  return {
    set(t) { label.textContent = t; },
    progress(done, total, prefix = '') {
      if (!total) return;
      bar.hidden = false;
      bar.firstChild.style.width = Math.round((done / total) * 100) + '%';
      if (prefix) label.textContent = `${prefix}… ${Math.round((done / total) * 100)}%`;
    },
    close() { clearTimeout(timer); if (shown) back.remove(); }
  };
}

/** 貼在某個元素旁邊的小視窗（點旁邊空白處或 × 會關閉） */
export function popover(anchor, content, { title = '', onClose = null, className = '' } = {}) {
  const closeBtn = h('button', { type: 'button', class: 'icon-btn pop-x', 'aria-label': '關閉', html: icon('x') });
  const panel = h('div', { class: 'panel popover ' + className, role: 'dialog', 'aria-label': title || '選單' },
    h('div', { class: 'pop-head' }, h('div', { class: 'pop-title', text: title }), closeBtn),
    content);
  const layer = openLayer(panel, { className: 'layer-pop', onRequestClose: () => api.close() });
  const api = {
    el: panel,
    close() { if (layer.closed) return; layer.close(); window.removeEventListener('resize', place); if (onClose) onClose(); }
  };
  closeBtn.addEventListener('click', () => api.close());
  function place() {
    const r = anchor.getBoundingClientRect();
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), vw - pw - 8);
    let top = r.top - ph - 10;
    if (top < 8) top = Math.min(r.bottom + 10, vh - ph - 8);
    panel.style.left = Math.max(8, left) + 'px';
    panel.style.top = Math.max(8, top) + 'px';
  }
  requestAnimationFrame(place);
  window.addEventListener('resize', place);
  return api;
}
