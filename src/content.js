const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let FIELD_ALIAS = {};  
let VALUE_ALIAS = {};  
const mapValue = (v) => { const s = String(v).trim(); return VALUE_ALIAS[s] || s; };

// ================= 基础工具 =================

function setNativeInputValue(element, value) {
  try {
    if (!element) return;
    if (element.hasAttribute('readonly')) element.removeAttribute('readonly');
    if (element.hasAttribute('disabled')) element.removeAttribute('disabled');
    const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) { setter.call(element, value); } else { element.value = value; }
    const tracker = element._valueTracker;
    if (tracker) tracker.setValue(value);
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
  '.el-cascader-panel', '.el-select-dropdown', '.el-picker-panel', '.el-date-picker', '.el-time-panel', '.el-cascader-menu'
];
const PANEL_EXCLUDE = '.ant-select-dropdown, .ant-cascader-dropdown, .ant-picker-dropdown, .el-select-dropdown, .el-cascader-panel, .el-picker-panel, .el-date-picker, .el-time-panel';

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
  return qS(document, '.ant-modal-content, .el-message-box, .el-dialog__body, .ant-drawer-content, [role="dialog"]');
}

// ================= 控件识别引擎 =================
function classifyWrapped(el) {
  let w;
  if ((w = el.closest('.ant-select, .el-select'))) return { type: 'select', element: w };
  if ((w = el.closest('.ant-cascader, .ant-cascader-picker, .el-cascader'))) return { type: 'cascader', element: w };
  if ((w = el.closest('.ant-picker-range, .el-date-editor--daterange, .el-date-editor--datetimerange'))) return { type: 'date-range', element: w };
  if ((w = el.closest('.ant-picker, .el-date-editor'))) return { type: 'date', element: w };
  if ((w = el.closest('.ant-input-number, .el-input-number'))) return { type: 'number', element: w };
  return null;
}

function scanContainer(container) {
  let el;
  if ((el = qS(container, '.ant-cascader, .ant-cascader-picker, .el-cascader'))) return { type: 'cascader', element: el };
  if ((el = qS(container, '.ant-picker-range, .el-date-editor--daterange, .el-date-editor--datetimerange'))) return { type: 'date-range', element: el };
  if ((el = qS(container, '.el-date-editor--time, .el-time-picker'))) return { type: 'time', element: el };
  if ((el = qS(container, 'input[type="time"]'))) return { type: 'time', element: el };
  if ((el = qS(container, '.ant-picker, .el-date-editor, input[type="date"]'))) return { type: 'date', element: el };
  if ((el = qS(container, '.ant-select, .el-select'))) return { type: 'select', element: el };
  const nativeSel = qSA(container, 'select').find(isVisible);
  if (nativeSel) return { type: 'native-select', element: nativeSel };
  if ((el = qS(container, '.ant-radio-group, .el-radio-group'))) return { type: 'radio', element: el };
  if (qSA(container, 'input[type="radio"]').length >= 2) return { type: 'radio', element: container };
  if ((el = qS(container, '.ant-checkbox-group, .el-checkbox-group'))) return { type: 'checkbox', element: el };
  if (qSA(container, 'input[type="checkbox"]').length >= 2) return { type: 'checkbox', element: container };
  if ((el = qS(container, '.ant-input-number, .el-input-number'))) return { type: 'number', element: el };
  if ((el = qS(container, '.ant-slider, .el-slider'))) return { type: 'slider', element: el };
  if ((el = qS(container, '.ant-switch, .el-switch'))) return { type: 'switch', element: el };
  if ((el = qS(container, '.ant-rate, .el-rate'))) return { type: 'rate', element: el };
  if ((el = qS(container, 'input[type="file"]'))) return { type: 'file', element: el };
  if ((el = qS(container, 'textarea'))) return { type: 'input', element: el };
  if ((el = qS(container, 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])'))) {
    return classifyWrapped(el) || { type: 'input', element: el };
  }
  return null;
}

function findControlByLabel(scope, cleanKey) {
  const allTextNodes = qSA(scope, 'label, span, div, p, th, legend, .el-form-item__label');
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

// React Fiber 直写
function reactSetValue(el, key, val) {
  try {
    const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!fiberKey) return false;
    let fiber = el[fiberKey];
    while (fiber) {
      const isHostInput = fiber.tag === 5 && (fiber.type === 'input' || fiber.type === 'textarea' || fiber.type === 'select');
      const p = fiber.memoizedProps;
      if (!isHostInput && p && typeof p.onChange === 'function') {
        const rawParts = String(val).split(/[,[,，;；、]/).map(s => s.trim()).filter(Boolean);
        let out = rawParts[0];
        if (Array.isArray(p.options)) {
          const o = p.options.find(op => normText(String(op?.label ?? op ?? '')) === normText(out));
          if (o && o.value !== undefined) out = o.value;
        }
        p.onChange(out, { value: out, label: rawParts[0] });
        console.log(`[AutoFill] React Fiber 直写成功: ${key} = ${val}`);
        return true;
      }
      fiber = fiber.return;
    }
  } catch (e) { console.warn(`[AutoFill] React 直写异常: ${key}`, e); }
  return false;
}

function unbindDisabled(el) {
  if (!el) return;
  el.removeAttribute('disabled');
  el.removeAttribute('readonly');
  el.classList.remove('disabled', 'is-disabled');
  
  const wrapper = el.closest('.ant-select, .el-select, .ant-picker, .ant-form-item-control, .ant-cascader, .ant-input-number');
  if (wrapper) {
    wrapper.classList.remove('ant-select-disabled', 'el-select--disabled', 'ant-picker-disabled', 'ant-cascader-disabled', 'ant-input-number-disabled');
    wrapper.removeAttribute('aria-disabled');
  }
}

// ================= 文件上传处理 =================
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

function readFileViaBackground(path) {
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
}

async function fillFileInput(control, key, val) {
  const input = control.element.tagName === 'INPUT' && control.element.type === 'file'
    ? control.element 
    : qS(control.element, 'input[type="file"]') || qS(document, 'input[type="file"]');

  if (!input) return false;

  const paths = val.split(/[,，;；、]/).map(p => p.trim()).filter(Boolean);
  const files = [];

  for (const p of paths) {
    const isPath = /[\\\/]/.test(p);
    let r = await readFileViaBackground(p);
    if (!r.ok && !isPath) r = await readFileViaBackground('attachments/' + p);
    
    if (!r.ok) {
      const dummyBlob = new Blob(["Mock file content for auto fill"], { type: guessMime(p) });
      files.push(new File([dummyBlob], p, { type: guessMime(p) }));
    } else {
      files.push(base64ToFile(r.data, r.name || p.split(/[\\\/]/).pop(), r.mime));
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
    return true;
  } catch (e) {
    return false;
  }
}

// ================= 主填充逻辑 =================
async function fillControl(control, key, value, interval) {
  const val = String(value).trim();
  unbindDisabled(control.element);

  if (control.type === 'radio') {
    const radios = qSA(control.element, 'input[type="radio"]');
    let matched = false;
    for (const r of radios) {
      unbindDisabled(r);
      const wrapper = r.closest('.ant-radio-wrapper, .el-radio, label') || r.parentElement;
      const label = wrapper ? wrapper.textContent.replace(/[*：:]/g, '').trim() : '';
      const mv = mapValue(val);
      const nv = normText(mv);
      
      if (normText(r.value) === nv || normText(label) === nv || normText(label).includes(nv)) {
        (wrapper || r).click();
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
        matched = true;
        break;
      }
    }
    if (matched) { await sleep(interval); return true; }
    return false;
  }

  if (control.type === 'checkbox') {
    const targets = val.split(/[,，;；、]/).map(v => mapValue(v.trim())).filter(Boolean);
    const boxes = qSA(control.element, 'input[type="checkbox"]');
    let any = false;
    for (const cb of boxes) {
      unbindDisabled(cb);
      const wrapper = cb.closest('.ant-checkbox-wrapper, .el-checkbox, label') || cb.parentElement;
      const text = wrapper ? wrapper.textContent.replace(/[*：:]/g, '').trim() : '';
      if (targets.some(t => { const nt = normText(t); return normText(cb.value) === nt || normText(text) === nt || normText(text).includes(nt); })) {
        if (!cb.checked) {
          wrapper.click();
          if (!cb.checked) { cb.click(); cb.checked = true; }
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
        any = true;
        await sleep(150);
      }
    }
    if (any) { await sleep(interval); return true; }
    return false;
  }

  if (control.type === 'number') {
    const input = qS(control.element, 'input') || control.element;
    unbindDisabled(input);
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    setNativeInputValue(input, val);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await sleep(interval);
    return true;
  }

  if (control.type === 'cascader') {
    const trigger = qS(control.element, 'input, .ant-select-selector, .el-input__inner') || control.element;
    unbindDisabled(trigger);
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
      const nodes = qSA(panel, '.ant-cascader-menu-item, .el-cascader-node, [role="menuitem"], li').filter(isVisible);
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
    const isTime = control.type === 'time' || (/^\d{1,2}:\d{2}/.test(val) && !val.includes('-'));
    const clean = isTime ? val : normalizeDateValue(val);
    if (!clean) return false;

    const input = qS(control.element, 'input') || control.element;
    if (input) {
      unbindDisabled(input);
      setNativeInputValue(input, clean);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      await sleep(interval);
      return true;
    }
    return false;
  }

  if (control.type === 'select') {
    const el = control.element;
    const values = val.split(/[,[,，;；、]/).map(v => mapValue(v.trim())).filter(Boolean);

    if (reactSetValue(el, key, values[0])) {
      await sleep(interval);
      return true;
    }

    const trigger = qS(el, 'input, .ant-select-selector, .el-select__caret, .el-input__inner') || el;
    unbindDisabled(trigger);
    let selectedAny = false;

    for (const v of values) {
      realClick(trigger);
      await sleep(300);

      const searchInput = qS(el, 'input[role="combobox"], .ant-select-selection-search-input') 
                       || qS(document, '.ant-select-dropdown input[type="search"]');

      if (searchInput) {
        unbindDisabled(searchInput);
        setNativeInputValue(searchInput, v);
        await sleep(200);
        searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        selectedAny = true;
      } else {
        const pre = snapPanels();
        let panel = await waitForPanel(pre) || findVisiblePanels()[0];
        if (panel) {
          const opt = findNodeByText(panel, '.ant-select-item-option, .el-select-dropdown__item, [role="option"], li', v);
          if (opt) {
            opt.click();
            selectedAny = true;
          }
        }
      }
      await sleep(250);
    }

    realClick(document.body);
    if (selectedAny) {
      await sleep(interval);
      return true;
    }
    return false;
  }

  if (control.type === 'file') {
    const okFile = await fillFileInput(control, key, val);
    if (okFile) await sleep(Math.max(interval, 800));
    return okFile;
  }

  if (control.type === 'input') {
    const input = qS(control.element, 'input, textarea') || control.element;
    unbindDisabled(input);
    
    if (reactSetValue(input, key, val)) {
      await sleep(interval);
      return true;
    }

    setNativeInputValue(input, val);
    await sleep(interval);
    return true;
  }

  return false;
}

// ================= 提交按钮识别 =================
function findSubmitButton(dialog) {
  const NEG = ['取消', '重置', '清空', '搜索', '查询', '重填', '返回', '关闭', '上一步', 'cancel', 'reset', 'search', 'close', 'back'];
  const POS = ['保存', '提交', '确定', '确认', '立即创建', '立即添加', '保存并', '创建', '添加', '录入', '下一步', 'confirm', 'ok', 'save', 'submit', 'create', 'add', 'next'];
  const norm = el => (el.textContent || '').replace(/\s+/g, '').toLowerCase();
  const scopes = dialog ? [dialog, document] : [document];
  for (const scope of scopes) {
    const btns = qSA(scope, 'button, a, div[role="button"], .ant-btn, .el-button').filter(isVisible);
    const byType = btns.find(b => b.getAttribute && b.getAttribute('type') === 'submit');
    if (byType) return byType;
    const hit = btns.find(b => {
      const t = norm(b);
      return t && !NEG.some(k => t.includes(k)) && POS.some(k => t.includes(k));
    });
    if (hit) return hit;
    const primary = btns.filter(b => /ant-btn-primary|el-button--primary/.test(b.className || ''));
    if (primary.length) return primary[primary.length - 1];
  }
  return null;
}

// ================= 💡 修正后的精准页面字段扫描引擎 =================
function scanPageLabels() {
  const dialog = getActiveDialog();
  const scope = dialog || document;
  const labels = new Set();

  const formItems = qSA(scope, '.ant-form-item, .el-form-item, form div, .form-group');
  for (const item of formItems) {
    if (!isVisible(item)) continue;
    const labelNode = qS(item, 'label, .ant-form-item-label, .el-form-item__label, span');
    if (labelNode && !labelNode.closest(PANEL_EXCLUDE)) {
      const txt = (labelNode.textContent || '').replace(/[*：:\r\n]/g, '').trim();
      
      // 💡 修正黑名单：允许“简历附件”和“个人作品”，仅过滤区块大标题（如“人员信息”）、单选选项字眼及字数统计
      const isInvalid = !txt || txt.length < 2 || txt.length > 12 
        || /确定|取消|提交|保存|上传|点击|请选择|请输入|操作|人员信息/.test(txt)
        || /^(在职|离职|男|女|是|否)$/.test(txt)
        || /\d+\s*\/\s*\d+/.test(txt);

      if (!isInvalid) {
        if (scanContainer(item)) {
          labels.add(txt);
        }
      }
    }
  }

  // 兜底扫描 placeholder
  if (labels.size === 0) {
    const inputs = qSA(scope, 'input[placeholder], textarea[placeholder]');
    for (const inp of inputs) {
      if (!isVisible(inp)) continue;
      const ph = inp.placeholder.replace(/请选择|请输入|[*：:]/g, '').trim();
      if (ph && ph.length >= 2 && ph.length <= 12 && !/\d+\s*\/\s*\d+/.test(ph)) {
        labels.add(ph);
      }
    }
  }

  return Array.from(labels);
}

// ================= 主流程 =================
async function handleAutoFill(row, interval = 300, fieldMapping, valueMapping) {
  FIELD_ALIAS = fieldMapping || {};
  VALUE_ALIAS = valueMapping || {};
  let matchedCount = 0;
  let totalFields = 0;

  try {
    const hasVisibleInput = qSA(document, 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="radio"]):not([type="checkbox"]), textarea').some(isVisible);
    if (!hasVisibleInput && !getActiveDialog()) {
      const ENTRY = ['新增', '新建', '添加', '创建', '录入', '登记', 'add', 'create', 'new'];
      const normText = el => (el.textContent || '').replace(/\s+/g, '').toLowerCase();
      const entryBtn = qSA(document, 'button, a, div[role="button"], .ant-btn, .el-button').filter(isVisible).find(b => {
        const t = normText(b);
        return t && t.length <= 8 && ENTRY.some(k => t.includes(k));
      });
      if (entryBtn) {
        realClick(entryBtn);
        await sleep(1000);
      }
    }

    for (const [rawKey, value] of Object.entries(row)) {
      let key = rawKey.replace(/[\r\n*：:]/g, '').trim();
      if (key.startsWith('_') || key === 'id' || value === undefined || value === null || String(value).trim() === '') continue;
      if (FIELD_ALIAS[key]) key = FIELD_ALIAS[key];

      if (findVisiblePanels().length) { realClick(document.body); await sleep(150); }

      totalFields++;
      try {
        const control = findControlByKey(key);
        if (!control) continue;
        const ok = await fillControl(control, key, value, interval);
        if (ok) matchedCount++;
      } catch (e) {
        console.error(`[AutoFill] 字段 "${key}" 处理异常:`, e);
      }
    }

    if (matchedCount === 0) throw new Error("未能匹配到任何有效字段，请检查 Excel 表头与网页标签是否一致");

    await sleep(400);

    const submitBtn = findSubmitButton(getActiveDialog());
    if (submitBtn) {
      realClick(submitBtn);
      await sleep(1500);
    }

    const errorTip = qS(document, '.el-form-item__error, .ant-form-item-explain-error, .el-message--error, .error-tip');
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
    const detectedLabels = scanPageLabels();
    sendResponse({ success: true, labels: detectedLabels });
  }

  if (request.action === "FILL_SINGLE_RECORD") {
    handleAutoFill(request.row, request.interval, request.fieldMapping, request.valueMapping);
  }
  return true;
});