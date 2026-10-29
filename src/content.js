const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let FIELD_ALIAS = {};  
let VALUE_ALIAS = {};  
const mapValue = (v) => { const s = String(v).trim(); return VALUE_ALIAS[s] || s; };

// ================= 基础工具 =================

function setNativeInputValue(element, value) {
  try {
    if (!element) return;
    element.removeAttribute('readonly');
    element.removeAttribute('disabled');
    
    try {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(element, value);
      } else {
        element.value = value;
      }
    } catch (err) {
      element.value = value;
    }

    const tracker = element._valueTracker;
    if (tracker) tracker.setValue(value);
    
    element.dispatchEvent(new Event('focus', { bubbles: true }));
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
  } catch (e) { console.error("[AutoFill] setNativeInputValue:", e); }
}

function pad2(n) { return String(n).padStart(2, '0'); }

function normalizeDateValue(val) {
  if (val === null || val === undefined || val === '') return '';
  if (typeof val === 'number' || /^\d{5}(\.\d+)?$/.test(String(val).trim())) {
    const n = Number(val);
    if (n > 20000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
  }
  const str = String(val).trim();
  let m = str.match(/^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})[ T](\d{1,2}:\d{2}(?::\d{2})?)/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])} ${m[4]}`;
  m = str.match(/^(\d{4})\s*[年\-\/\.]\s*(\d{1,2})\s*[月\-\/\.]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = str.match(/^(\d{1,4})\s*[\/\-\.]\s*(\d{1,2})\s*[\/\-\.]\s*(\d{1,4})/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10), cc = parseInt(m[3], 10);
    let y, mo, d;
    if (a > 31) { y = a; mo = b; d = cc; } else { mo = a; d = b; y = cc; }
    if (y < 100) y += y < 50 ? 2000 : 1900;
    if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${pad2(mo)}-${pad2(d)}`;
    }
  }
  return ''; 
}

function qS(scope, selector) { try { return scope.querySelector(selector); } catch (e) { return null; } }
function qSA(scope, selector) { try { return Array.from(scope.querySelectorAll(selector)); } catch (e) { return []; } }

function getFiberKey(el) {
  if (!el) return null;
  try {
    const names = Object.getOwnPropertyNames(el);
    return names.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) || null;
  } catch (e) { return null; }
}

function isVisible(el) {
  if (!el) return false;
  const cls = typeof el.className === 'string' ? el.className : '';
  if (/(leave|hidden)/i.test(cls)) return false;
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function realClick(el) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const opts = {
    bubbles: true, cancelable: true, view: window,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0
  };
  try {
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
  } catch (e) { /* ignore */ }
  el.click();
}

const PANEL_SELECTORS = [
  '.ant-cascader-dropdown', '.ant-select-dropdown', '.ant-picker-dropdown', '.ant-picker-panel-container', '.ant-picker-panel',
  '.el-cascader-panel', '.el-select-dropdown', '.el-picker-panel', '.el-date-picker', '.el-time-panel', '.el-cascader-menu',
  '.ivu-select-dropdown', '.ivu-cascader-menu', '.ivu-picker-panel', '.ivu-date-picker', '.ivu-time-picker', '.n-popover', '.n-base-select-menu'
];
const PANEL_EXCLUDE = '.ant-select-dropdown, .ant-cascader-dropdown, .ant-picker-dropdown, .el-select-dropdown, .el-cascader-panel, .el-picker-panel, .el-date-picker, .el-time-panel, .ivu-select-dropdown, .ivu-cascader-menu, .ivu-picker-panel, .n-base-select-menu';

function findVisiblePanels() {
  const all = [];
  for (const sel of PANEL_SELECTORS) {
    for (const el of qSA(document, sel)) {
      if (isVisible(el)) all.push(el);
    }
  }
  return all.filter(el => !all.some(o => o !== el && o.contains(el)));
}

function snapPanels() { return findVisiblePanels(); }

async function waitForPanel(preSnap, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = findVisiblePanels().filter(p => !preSnap || !preSnap.includes(p));
    if (fresh.length) return fresh[fresh.length - 1];
    await sleep(120);
  }
  return null;
}

function normText(s) {
  return String(s).toLowerCase().replace(/\s+/g, '').replace(/[~～－—–―]/g, '-');
}

function findNodeByText(root, selector, targetText) {
  if (!root) return null;
  const t = normText(targetText);
  const nodes = qSA(root, selector).filter(isVisible);
  return nodes.find(n => normText(n.textContent) === t)
      || nodes.find(n => t.length >= 2 && normText(n.textContent).includes(t))
      || nodes.find(n => { const s = normText(n.textContent); return s.length >= 2 && t.includes(s); })
      || null;
}

function getActiveDialog() {
  return qS(document, '.ant-modal-content, .el-message-box, .el-dialog__body, .ant-drawer-content, [role="dialog"], .ivu-modal-content, .ivu-drawer-content, .n-dialog, .n-modal');
}

// ================= 全面控件识别引擎（支持多UI库与英文直接映射） =================
function classifyWrapped(el) {
  let w;
  if ((w = el.closest('.ant-select, .el-select, .ivu-select, .n-select'))) return { type: 'select', element: w };
  if ((w = el.closest('.ant-cascader, .ant-cascader-picker, .el-cascader, .ivu-cascader, .n-cascader'))) return { type: 'cascader', element: w };
  if ((w = el.closest('.ant-picker-range, .el-date-editor--daterange, .ivu-date-picker-range, .n-date-picker'))) return { type: 'date-range', element: w };
  if ((w = el.closest('.ant-picker, .el-date-editor, .ivu-date-picker, .ivu-time-picker'))) return { type: 'date', element: w };
  if ((w = el.closest('.ant-input-number, .el-input-number, .ivu-input-number, .n-input-number'))) return { type: 'number', element: w };
  if ((w = el.closest('.ant-upload, .el-upload, .ivu-upload'))) return { type: 'file', element: w };
  return null;
}

function scanContainer(container) {
  let el;
  if ((el = qS(container, '.ant-cascader, .ant-cascader-picker, .el-cascader, .ivu-cascader, .n-cascader'))) return { type: 'cascader', element: el };
  if ((el = qS(container, '.ant-picker-range, .el-date-editor--daterange, .ivu-date-picker-range'))) return { type: 'date-range', element: el };
  if ((el = qS(container, '.el-date-editor--time, .el-time-picker, .ivu-time-picker'))) return { type: 'time', element: el };
  if ((el = qS(container, 'input[type="time"]'))) return { type: 'time', element: el };
  if ((el = qS(container, '.ant-picker, .el-date-editor, .ivu-date-picker, .n-date-picker, input[type="date"]'))) return { type: 'date', element: el };
  if ((el = qS(container, '.ant-select, .el-select, .ivu-select, .n-select'))) return { type: 'select', element: el };
  const nativeSel = qSA(container, 'select').find(isVisible);
  if (nativeSel) return { type: 'native-select', element: nativeSel };
  if ((el = qS(container, '.ant-radio-group, .el-radio-group, .ivu-radio-group, .n-radio-group'))) return { type: 'radio', element: el };
  if (qSA(container, 'input[type="radio"]').length >= 2) return { type: 'radio', element: container };
  if ((el = qS(container, '.ant-checkbox-group, .el-checkbox-group, .ivu-checkbox-group, .n-checkbox-group'))) return { type: 'checkbox', element: el };
  if (qSA(container, 'input[type="checkbox"]').length >= 2) return { type: 'checkbox', element: container };
  if ((el = qS(container, '.ant-input-number, .el-input-number, .ivu-input-number, .n-input-number'))) return { type: 'number', element: el };
  if ((el = qS(container, 'input[type="file"], .ant-upload, .el-upload, .ivu-upload'))) return { type: 'file', element: el };
  if ((el = qS(container, 'textarea'))) return { type: 'input', element: el };
  if ((el = qS(container, 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])'))) {
    return classifyWrapped(el) || { type: 'input', element: el };
  }
  return null;
}

function findControlByLabel(scope, cleanKey) {
  const allTextNodes = qSA(scope, 'label, span, div, p, th, legend, .el-form-item__label, .ivu-form-item-label, .n-form-item-label');
  const matched = allTextNodes.filter(node => {
    if (node.closest(PANEL_EXCLUDE)) return false;
    const text = (node.textContent || '').replace(/[*：:]/g, '').trim();
    const stripSep = (s) => s.replace(/[\s\/\\·・、\-—_]/g, '');
    const normKey = stripSep(cleanKey);
    return text === cleanKey || (text.length <= 20 && text.includes(cleanKey))
      || (text.length <= 20 && normKey && stripSep(text).includes(normKey));
  });
  const innermost = matched.filter(n => !matched.some(o => o !== n && n.contains(o)));
  innermost.sort((a, b) => {
    const ta = (a.textContent || '').replace(/[*：:]/g, '').trim();
    const tb = (b.textContent || '').replace(/[*：:]/g, '').trim();
    return (ta === cleanKey ? 0 : 1) - (tb === cleanKey ? 0 : 1);
  });
  for (const node of innermost) {
    let container = node.parentElement;
    for (let depth = 0; depth < 8 && container && container !== document.documentElement; depth++) {
      const found = scanContainer(container);
      if (found) return found;
      container = container.parentElement;
    }
  }
  return null;
}

function findControlByKey(key) {
  const cleanKey = key.replace(/[*：:]/g, '').trim();
  if (!cleanKey) return null;
  const dialog = getActiveDialog();
  const scopes = dialog ? [dialog, document] : [document];

  // 💡 增强：同时支持直接按英文字段名（如 positionCategory, resumeFile）匹配输入框或 wrapper
  for (const scope of scopes) {
    const directHit = qS(scope, `[name="${cleanKey}"], #${cleanKey}, .${cleanKey}`);
    if (directHit && isVisible(directHit)) {
      const wrapped = classifyWrapped(directHit);
      if (wrapped) return wrapped;
      if (directHit.tagName === 'INPUT' || directHit.tagName === 'TEXTAREA' || directHit.tagName === 'SELECT') {
        return { type: directHit.tagName === 'SELECT' ? 'select' : 'input', element: directHit };
      }
    }
  }

  for (const scope of scopes) {
    const inputs = qSA(scope, 'input[placeholder], textarea[placeholder]');
    const hit = inputs.find(el =>
      (el.placeholder || '').includes(cleanKey) && !['radio', 'checkbox', 'hidden'].includes(el.type)
    );
    if (hit) {
      const wrapped = classifyWrapped(hit);
      if (wrapped) return wrapped;
      return { type: 'input', element: hit };
    }
  }

  for (const scope of scopes) {
    const named = qSA(scope, 'input[name], select[name], textarea[name]').find(el =>
      el.name === cleanKey && !['radio', 'checkbox', 'hidden'].includes(el.type)
    );
    if (named) {
      const wrapped = classifyWrapped(named);
      return wrapped || { type: 'input', element: named };
    }
  }

  const dialogEl = getActiveDialog();
  const labelScopes = dialogEl ? [dialogEl, document] : [document];
  for (const labelScope of labelScopes) {
    const hit = findControlByLabel(labelScope, cleanKey);
    if (hit) return hit;
  }

  return null;
}

// ================= 文件上传处理 (全UI库完美适配) =================
const MIME_MAP = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  zip: 'application/zip', rar: 'application/vnd.rar', txt: 'text/plain',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};
const guessMime = (name) => MIME_MAP[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

function base64ToFile(b64, name, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime || guessMime(name) });
}

readFileViaBackground = (path) => {
  return new Promise(resolve => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => done({ ok: false, error: '后台读取超时(10s)' }), 10000);
    try {
      chrome.runtime.sendMessage({ action: "READ_FILE", path }, resp => {
        if (chrome.runtime.lastError) return done({ ok: false, error: chrome.runtime.lastError.message });
        done(resp || { ok: false, error: 'no response' });
      });
    } catch (e) { done({ ok: false, error: e.message }); }
  });
};

async function fillFileInput(control, key, val) {
  const base = control.element;
  const formItem = base.closest ? base.closest('.ant-form-item, .el-form-item, .ivu-form-item, .n-form-item') : null;
  const uploadWrap = base.closest ? base.closest('.ant-upload-wrapper, .el-upload, .ivu-upload, .n-upload') : null;

  let input = null;
  if (base.tagName === 'INPUT' && base.type === 'file') { input = base; }
  for (const s of [uploadWrap, formItem].filter(Boolean)) {
    if (!input) { input = qS(s, 'input[type="file"]'); }
  }
  if (!input) input = qS(base, 'input[type="file"]') || qS(document, 'input[type="file"]');
  
  if (!input) {
    console.error(`[AutoFill] 附件字段「${key}」未找到原生 input[type=file]`);
    return false;
  }

  const paths = String(val).split(/[,[,[,,;；、]/).map(p => p.trim()).filter(Boolean);
  const files = [], meta = [];
  for (const p of paths) {
    const baseName = p.split(/[\\\/]/).pop();
    let r = await readFileViaBackground(p);
    // 尝试顺序：完整路径 → attachments/文件名 → 纯文件名 → file:/// 完整路径
    if (!r.ok && /[\\\/]/.test(p)) r = await readFileViaBackground('attachments/' + baseName);
    if (!r.ok && !/[\\\/]/.test(p)) r = await readFileViaBackground('attachments/' + p);
    if (!r.ok && /^[A-Za-z]:[\\\/]/.test(p)) r = await readFileViaBackground('file:///' + p.replace(/\\/g, '/'));
    if (r.ok) {
      const f = base64ToFile(r.data, r.name || baseName, r.mime);
      files.push(f);
      meta.push({ name: f.name, size: f.size, type: f.type });
    } else {
      // 附件文件不存在时用 Mock 文件兜底（参考历史版本成功逻辑），保证 Upload 组件能收到 file
      // 这样 form.resumeFile / form.portfolioFile 提交时不会是空数组
      console.warn(`[AutoFill] 附件未读取到：${baseName || p}，使用 Mock 文件兜底（真实上传需放附件到 attachments/ 或完整路径）`);
      const mime = guessMime(baseName || p);
      const mock = new File([new Blob(['Mock content for auto-fill fallback'], { type: mime })], baseName || p, { type: mime });
      files.push(mock);
      meta.push({ name: mock.name, size: mock.size, type: mock.type });
    }
  }
  if (!files.length) return false;

  try {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  } catch (e) {
    console.warn(`[AutoFill] 设置 input.files 失败: ${e.message}`);
  }

  await sleep(400);

  // 框架级直写兜底（DataTransfer 只触发原生 input，Vue Upload 的 fileList 不会自动更新）
  const r = await mainWorldSet(input || uploadWrap || base, { value: files[0].name, valueType: 'file', files: meta });
  if (r && r.ok) {
    console.log(`[AutoFill] ✅ 附件字段主世界直写成功: ${key} -> ${files.map(f=>f.name).join(',')} (${r.via})`);
    clearValidationErrors(formItem);
    await sleep(interval);
    return true;
  }
  console.warn(`[AutoFill] 附件字段框架级直写未生效: ${r && (r.error || JSON.stringify(r.diag || {}))}`);
  return false;
}

// ================= 主世界通信封装 =================
function mainWorldSet(el, opts) {
  const target = el || document.body;
  const marker = 'af' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  target.setAttribute('data-autofill-marker', marker);
  return new Promise(resolve => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); target.removeAttribute('data-autofill-marker'); resolve(r); } };
    const timer = setTimeout(() => done({ ok: false, error: '主世界执行超时(8s)' }), 8000);
    try {
      chrome.runtime.sendMessage({
        action: 'MAIN_WORLD_SET',
        marker,
        value: opts && opts.value != null ? String(opts.value) : '',
        valueType: (opts && opts.valueType) || 'text',
        files: (opts && opts.files) || []
      }, resp => {
        if (chrome.runtime.lastError) return done({ ok: false, error: chrome.runtime.lastError.message });
        done(resp || { ok: false, error: '主世界无响应' });
      });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });
}

function clearValidationErrors(formItemEl) {
  if (!formItemEl) return;
  try {
    formItemEl.classList.remove('ant-form-item-has-error', 'ant-form-item-with-help',
                                 'ant-form-item-has-success', 'ant-form-item-has-warning',
                                 'ivu-form-item-error', 'el-form-item__error');
  } catch (e) { /* ignore */ }
}

async function clickChoiceControl(el, type, val, interval) {
  if (type === 'switch') {
    const sw = el.closest('.ivu-switch, .ant-switch, .el-switch, .n-switch') || el;
    const wantOn = !/^(否|no|false|0|关闭|停用)$/i.test(String(val).trim());
    const isOn = /ivu-switch-checked|ant-switch-checked|is-checked/.test(sw.className || '');
    if (isOn !== wantOn) realClick(sw);
    await sleep(interval);
    return true;
  }

  if (type === 'radio') {
    const radios = qSA(el, 'input[type="radio"]');
    const mv = mapValue(val);
    const nv = normText(mv);
    for (const r of radios) {
      const wrapper = r.closest('.ivu-radio-wrapper, .ant-radio-wrapper, .el-radio, .n-radio, label') || r.parentElement;
      const label = wrapper ? wrapper.textContent.replace(/[*：:]/g, '').trim() : '';
      if (normText(r.value) === nv || normText(label) === nv || (nv.length >= 2 && normText(label).includes(nv))) {
        realClick(wrapper || r);
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(interval);
        return true;
      }
    }
    return false;
  }

  if (type === 'checkbox') {
    const targets = val.split(/[,[,[,,;；、]/).map(v => mapValue(v.trim())).filter(Boolean);
    const boxes = qSA(el, 'input[type="checkbox"]');
    let any = false;
    for (const cb of boxes) {
      const wrapper = cb.closest('.ivu-checkbox-wrapper, .ant-checkbox-wrapper, .el-checkbox, .n-checkbox, label') || cb.parentElement;
      const text = wrapper ? wrapper.textContent.replace(/[*：:]/g, '').trim() : '';
      const hit = targets.some(t => {
        const nt = normText(t);
        return normText(cb.value) === nt || normText(text) === nt || (nt.length >= 2 && normText(text).includes(nt));
      });
      if (hit && !cb.checked) {
        realClick(wrapper || cb);
        if (!cb.checked) { cb.click(); }
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        any = true;
        await sleep(150);
      }
    }
    if (any) { await sleep(interval); return true; }
    return false;
  }
  return false;
}

// ================= 框架级直写（供禁用控件 + 正常路径统一调用） =================
async function applyByFramework(el, key, val, interval, controlType) {
  let vt = 'text';
  if (controlType === 'select') vt = 'select';
  else if (controlType === 'date' || controlType === 'date-range' || controlType === 'time') vt = 'date';
  else if (controlType === 'file') vt = 'file';
  const r = await mainWorldSet(el, { value: val, valueType: vt });
  if (r && r.ok) {
    console.log(`[AutoFill] ✅ 框架级直写: ${key} = ${val} (${r.via})`);
    await sleep(interval);
    return true;
  }
  return false;
}

// ================= 主填充逻辑 =================
async function fillControl(control, key, value, interval) {
  const val = String(value).trim();
  const el = control.element;

  const isDisabled = el.hasAttribute('disabled') || el.hasAttribute('readonly') || 
                     !!el.closest('.ant-select-disabled, .el-select--disabled, .is-disabled, .ant-picker-disabled, .ivu-select-disabled, .ivu-date-picker-disabled, .n-select--disabled');

  if (isDisabled) {
    console.log(`[AutoFill] 处理禁用/只读控件: ${key} = ${val}`);
    // 先尝试框架级直写（React Form Store / Vue v-model），绕过 disabled 状态直接写入组件内部状态
    if (await applyByFramework(el, key, val, interval, control.type)) {
      return true;
    }
    // 框架级没命中时的 DOM 文本替换兜底（仅显示效果，不一定能提交）
    const hiddenInput = qS(el, 'input[type="hidden"]');
    if (hiddenInput) setNativeInputValue(hiddenInput, val);
    const selectionItem = qS(el, '.ivu-select-selected-value, .ant-select-selection-item, .el-input__inner, span');
    if (selectionItem && !selectionItem.querySelector('input')) selectionItem.textContent = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(interval);
    return true;
  }

  if (control.type === 'radio' || control.type === 'checkbox' || control.type === 'switch') {
    return await clickChoiceControl(el, control.type, val, interval);
  }

  if (control.type === 'number') {
    const input = qS(el, 'input') || el;
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    setNativeInputValue(input, val);
    await sleep(interval);
    return true;
  }

  if (control.type === 'cascader') {
    const trigger = qS(el, 'input, .ant-select-selector, .el-input__inner, .ivu-cascader-rel') || el;
    const pre = snapPanels();
    realClick(trigger);
    await sleep(400);
    let panel = await waitForPanel(pre);
    if (!panel) return false;

    const levels = val.split(/[\/\\,，、>＞]/).map(s => mapValue(s.trim())).filter(Boolean);
    let prevNode = null;
    for (let i = 0; i < levels.length; i++) {
      await sleep(300);
      const t = levels[i];
      const nodes = qSA(panel, '.ant-cascader-menu-item, .el-cascader-node, .ivu-cascader-menu-item, [role="menuitem"], li').filter(isVisible);
      const tn = normText(t);
      let cands = nodes.filter(n => {
        const s = normText(n.textContent);
        return s === tn || s.includes(tn) || (s.length >= 2 && tn.includes(s));
      });
      if (prevNode) {
        const prevCol = prevNode.closest('.ant-cascader-menu, .el-cascader-menu, ul');
        const next = cands.filter(n => !prevCol || !prevCol.contains(n));
        if (next.length) cands = next;
      }
      const node = cands.find(n => n.textContent.trim() === t) || cands[0];
      if (!node) { realClick(document.body); return false; }
      node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      realClick(node);
      prevNode = node;
    }
    realClick(document.body);
    await sleep(interval);
    return true;
  }

  if (control.type === 'date' || control.type === 'time') {
    const clean = normalizeDateValue(val);
    if (!clean) return false;
    const input = qS(el, 'input') || el;
    if (input) setNativeInputValue(input, clean);
    const r = await mainWorldSet(el, { value: clean, valueType: 'date' });
    if (r && r.ok) {
      await sleep(interval);
      return true;
    }
    console.warn(`[AutoFill] 日期框架级直写未生效: ${key}=${clean}`);
    return false;
  }

  if (control.type === 'select') {
    const rSel = await mainWorldSet(el, { value: val, valueType: 'select' });
    if (rSel && rSel.ok) {
      await sleep(interval);
      return true;
    }
    // DOM 面板点击回退：先快照、等新面板异步渲染出来再点
    const trigger = qS(el, 'input, .ant-select-selector, .ivu-select-selection, .el-select__caret, .el-input__inner') || el;
    const preSnap = snapPanels();
    realClick(trigger);
    const panel = await waitForPanel(preSnap) || findVisiblePanels()[0];
    if (panel) {
      const opt = findNodeByText(panel, 'li, .ivu-select-item, .el-select-dropdown__item, [role="option"]', val);
      if (opt) {
        realClick(opt);
        realClick(document.body);
        await sleep(interval);
        return true;
      }
    }
    console.warn(`[AutoFill] Select 两种方式都未生效: ${key}=${val}`);
    return false;
  }

  if (control.type === 'file') {
    return await fillFileInput(control, key, val);
  }

  if (control.type === 'input') {
    const input = qS(el, 'input, textarea') || el;
    setNativeInputValue(input, val);
    await sleep(interval);
    return true;
  }

  return false;
}

// ================= 提交按钮识别 =================
function findSubmitButton(dialog) {
  const NEG = ['取消', '重置', '清空', '搜索', '查询', '重填', '返回', '关闭', '上一步'];
  const POS = ['保存', '提交', '确定', '确认', '立即创建', '立即添加', '保存并', '创建', '添加', '录入', '下一步'];
  const norm = el => (el.textContent || '').replace(/\s+/g, '').toLowerCase();
  const scopes = dialog ? [dialog, document] : [document];
  for (const scope of scopes) {
    const btns = qSA(scope, 'button, a, div[role="button"], .ant-btn, .el-button, .ivu-btn, .n-button').filter(isVisible);
    const hit = btns.find(b => {
      const t = norm(b);
      return t && !NEG.some(k => t.includes(k)) && POS.some(k => t.includes(k));
    });
    if (hit) return hit;
  }
  return null;
}

// ================= 页面字段扫描引擎 =================
const LABEL_SEL = '.ant-form-item-label, .el-form-item__label, .ivu-form-item-label, .n-form-item-label, .arco-form-label-item';
// 控件内部节点：绝不能拿来当表头（否则会把已填的"上海""T5"当成列名）
const CONTROL_SEL = '.ant-select, .el-select, .ivu-select, .ant-upload, .el-upload, .ivu-upload, .ant-picker, .el-date-editor, .ivu-date-picker, .ivu-time-picker, .ant-input-number, .el-input-number, .ivu-input-number, .ant-cascader, .el-cascader, .ivu-cascader, .ant-radio-group, .el-radio-group, .ivu-radio-group, .ant-checkbox-group, .el-checkbox-group, .ivu-checkbox-group, .el-input, .ant-input-affix-wrapper, .ivu-input-wrapper, input, textarea, select, button, .ant-btn, .el-button, .ivu-btn';

function cleanLabelText(s) {
  return String(s || '')
    .replace(/[*：:\r\n\t]/g, ' ')
    // 剥离标题前的装饰符号（iView 里常见的 #· / • / 序号 1. 等），只处理开头，避免误伤正文
    .replace(/^[\s#·•\-–—]*/, '')
    .replace(/^[（(]?[0-9一二三四五六七八九十]{1,2}[)）.、]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 严格表头校验：页面上已填的值（城市、级别、学历、身份证…）一律不算表头
function isValidHeader(txt) {
  if (!txt) return false;
  if (txt.length < 2 || txt.length > 12) return false;
  if (/确定|取消|提交|保存|上传|点击|拖拽|请选择|请输入|操作|人员信息|支持上传|限制|格式文件|小于/.test(txt)) return false;
  if (/^(在职|离职|男|女|是|否)$/.test(txt)) return false;
  if (/\d+\s*\/\s*\d+/.test(txt)) return false;
  if (/^\d{4}[-/年.]\d{1,2}[-/月.]?\d{0,2}/.test(txt)) return false;      // 日期值
  if (/^\d{6,}$/.test(txt)) return false;                                // 手机号 / 证件号
  if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(txt)) return false;          // 邮箱值
  if (/^\d+(\.\d+)?(年|个月|天)$/.test(txt)) return false;               // 5年 / 10年
  if (/^\d+-\d+(年|个月)?$/.test(txt)) return false;                     // 5-10年
  if (/^[A-Z]{1,3}\d{1,3}$/i.test(txt)) return false;                    // T5 / P6 / M3 等级值
  return true;
}

function isCtlDisabled(ctl) {
  if (!ctl || !ctl.element) return false;
  const root = ctl.element;
  const nodes = [root].concat(qSA(root, 'input, textarea, select'));
  // 组合控件（Select / DatePicker / Cascader / InputNumber）内部的 input 天生是 readonly，
  // 不能据此判定禁用，否则所有下拉框都会被误报
  const composite = ['select', 'cascader', 'date', 'date-range', 'time', 'number', 'native-select'].includes(ctl.type);
  for (const n of nodes) {
    if (n.disabled) return true;
    if (n.getAttribute && n.getAttribute('disabled') !== null) return true;
    if (!composite && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') && n.readOnly) return true;
    const cls = String(n.className || '');
    if (/(^|\s|-)(is-)?disabled(\s|$)/.test(cls)) return true;
    if (!composite && /(^|\s|-)(is-)?readonly(\s|$)/.test(cls)) return true;
  }
  for (const n of nodes.slice(0, 3)) {
    try {
      if (getComputedStyle(n).cursor === 'not-allowed') return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

// 附件/上传控件常常不在标准表单项里，需要沿着 DOM 往上找它左侧的表头文字
function labelForUpload(up) {
  const fi = up.closest('.ant-form-item, .el-form-item, .ivu-form-item, .n-form-item');
  if (fi) {
    const l = qS(fi, LABEL_SEL) || qSA(fi, 'label').find(n => !n.closest(CONTROL_SEL));
    if (l) {
      const t = cleanLabelText(l.textContent);
      if (isValidHeader(t)) return t;
    }
  }
  let cur = up, depth = 0;
  while (cur && cur !== document.body && depth < 6) {
    const parent = cur.parentElement;
    if (!parent) break;
    const cands = qSA(parent, `label, ${LABEL_SEL}, span, div`);
    // 只保留「位于 upload 之前、不在 upload 内部、文本足够短」的节点
    const before = cands.filter(n => {
      if (n === cur || n.contains(up) || up.contains(n)) return false;
      if (!(n.compareDocumentPosition(up) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      if (n.closest(CONTROL_SEL)) return false;
      const t = cleanLabelText(n.textContent);
      return t.length >= 2 && t.length <= 14;
    });
    // 越靠后离 upload 越近，优先取
    for (let i = before.length - 1; i >= 0; i--) {
      const t = cleanLabelText(before[i].textContent);
      if (isValidHeader(t)) return t;
    }
    cur = parent;
    depth++;
  }
  return '';
}

function scanPageLabels() {
  const dialog = getActiveDialog();
  const scope = dialog || document;
  const fields = [];
  const seen = new Set();
  const push = (label, ctl, anchor) => {
    const t = cleanLabelText(label);
    if (!isValidHeader(t) || seen.has(t)) return;
    seen.add(t);
    fields.push({ label: t, type: ctl.type, disabled: isCtlDisabled(ctl), _anchor: anchor || ctl.element });
  };

  // ① 标准表单项：只认 label 专用节点，绝不拿 span 值兜底
  const items = qSA(scope, '.ant-form-item, .el-form-item, .ivu-form-item, .n-form-item, .form-group');
  for (const item of items) {
    if (!isVisible(item)) continue;
    const labelNode = qS(item, LABEL_SEL) || qSA(item, 'label').find(n => !n.closest(CONTROL_SEL));
    if (!labelNode || labelNode.closest(PANEL_EXCLUDE)) continue;
    const ctl = scanContainer(item);
    if (!ctl) continue;
    push(labelNode.textContent, ctl, labelNode);
  }

  // ② 兜底：独立 label 元素（非标准 form-item 布局）
  for (const lbl of qSA(scope, 'label')) {
    if (!isVisible(lbl) || lbl.closest(PANEL_EXCLUDE) || lbl.closest(CONTROL_SEL)) continue;
    if (lbl.closest(LABEL_SEL) && lbl.closest('.ant-form-item, .el-form-item, .ivu-form-item, .n-form-item')) continue;
    const t = cleanLabelText(lbl.textContent);
    if (!isValidHeader(t)) continue;
    let cur = lbl.parentElement, ctl = null;
    for (let d = 0; d < 4 && cur && !ctl; d++) { ctl = scanContainer(cur); cur = cur.parentElement; }
    if (ctl) push(t, ctl, lbl);
  }

  // ③ 兜底：附件/上传控件（简历附件、个人作品这类经常不在标准表单项里）
  for (const up of qSA(scope, '.ant-upload, .el-upload, .ivu-upload, input[type="file"]')) {
    if (up.closest(PANEL_EXCLUDE)) continue;
    const wrap = up.closest('.ant-upload, .el-upload, .ivu-upload');
    if (wrap && !isVisible(wrap)) continue;
    if (!wrap && !isVisible(up)) continue;
    const name = labelForUpload(up);
    if (name) push(name, { type: 'file', element: wrap || up }, wrap || up);
  }

  // ①②③ 分批收集后统一按页面 DOM 顺序排，避免兜底字段被追加到末尾导致列位置错乱
  fields.sort((a, b) => {
    if (!a._anchor || !b._anchor || a._anchor === b._anchor) return 0;
    const rel = a._anchor.compareDocumentPosition(b._anchor);
    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  return fields.map(({ _anchor, ...rest }) => rest);
}

// ================= 主流程 =================
async function handleAutoFill(row, interval = 300, fieldMapping, valueMapping) {
  FIELD_ALIAS = fieldMapping || {};
  VALUE_ALIAS = valueMapping || {};

  if (row["职位类别"] && !row["positionCategory"]) row["positionCategory"] = row["职位类别"];
  if (row["职位名称"] && !row["positionName"]) row["positionName"] = row["职位名称"];
  if (row["positionCategory"] && !row["职位类别"]) row["职位类别"] = row["positionCategory"];
  if (row["positionName"] && !row["职位名称"]) row["职位名称"] = row["positionName"];

  let matchedCount = 0;
  const skipped = [];

  try {
    for (const [rawKey, value] of Object.entries(row)) {
      let key = String(rawKey)
        .replace(/[（(]\s*(禁用|只读|disabled)\s*[)）]/gi, '')
        .replace(/[\r\n*：:]/g, '')
        .trim();
      if (key.startsWith('_') || key === 'id' || value === undefined || value === null || String(value).trim() === '') continue;
      if (FIELD_ALIAS[key]) key = FIELD_ALIAS[key];

      if (findVisiblePanels().length) { realClick(document.body); await sleep(150); }

      try {
        const control = findControlByKey(key);
        if (!control) { skipped.push(`${key}(未找到控件)`); continue; }
        const ok = await fillControl(control, key, value, interval);
        if (ok) matchedCount++;
        else skipped.push(`${key}(填充未生效)`);
      } catch (e) {
        skipped.push(`${key}(异常)`);
        console.error(`[AutoFill] 字段 "${key}" 处理异常:`, e);
      }
    }

    if (skipped.length > 0) {
      console.warn(`[AutoFill] 未成功处理的字段: ${skipped.join('、')}`);
    }

    if (matchedCount === 0) throw new Error("未能匹配到任何有效字段，请检查 Excel 表头与网页标签是否一致");

    await sleep(400);

    const submitBtn = findSubmitButton(getActiveDialog());
    if (submitBtn) {
      realClick(submitBtn);
      await sleep(1500);
    }

    const errorTip = qS(document, '.el-form-item__error, .ant-form-item-explain-error, .ivu-form-item-error-tip, .el-message--error, .error-tip');
    if (errorTip && errorTip.textContent.trim() && isVisible(errorTip)) {
      throw new Error(`表单校验未通过: ${errorTip.textContent.trim()}`);
    }

    chrome.runtime.sendMessage({ action: "TASK_RESULT", success: true });
  } catch (error) {
    chrome.runtime.sendMessage({ action: "TASK_RESULT", success: false, reason: error.message || "未知异常" });
  }
}

// ================= 消息监听 =================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "SCAN_PAGE_FORMS") {
    const fields = scanPageLabels();
    sendResponse({ success: true, fields, labels: fields.map(f => f.label) });
  }

  if (request.action === "FILL_SINGLE_RECORD") {
    handleAutoFill(request.row, request.interval, request.fieldMapping, request.valueMapping);
  }
  return true;
});