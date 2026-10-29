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
    
    // 💡 修复：直接修改 element.value 并通过原生 descriptor 赋值，彻底规避 Illegal invocation
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

// 获取 DOM 元素上的 React Fiber 键（React 用 defineProperty 挂载且 enumerable:false）
// 必须用 Object.getOwnPropertyNames，不能用 Object.keys —— 后者在隔离世界里返回空
function getFiberKey(el) {
  if (!el) return null;
  try {
    const names = Object.getOwnPropertyNames(el);
    return names.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) || null;
  } catch (e) { return null; }
}

// 获取 Vue 实例（Vue 2 把实例存在 DOM 元素的 __vue__ 属性上，不可枚举）
function getVueInstance(el) {
  if (!el) return null;
  try {
    let node = el;
    while (node) {
      const names = Object.getOwnPropertyNames(node);
      const vueKey = names.find(k => k === '__vue__');
      if (vueKey && node[vueKey]) return node[vueKey];
      node = node.parentElement;
    }
  } catch (e) { /* ignore */ }
  return null;
}

// 从 Vue 实例向上找 iView Form 实例（有 setFieldsValue 方法）
function findVueForm(vm) {
  if (!vm) return null;
  let cur = vm;
  let hops = 0;
  while (cur && hops < 30) {
    if (cur.setFieldsValue && typeof cur.setFieldsValue === 'function') {
      return cur;
    }
    cur = cur.$parent;
    hops++;
  }
  return null;
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
  '.ivu-select-dropdown', '.ivu-cascader-menu', '.ivu-picker-panel', '.ivu-date-picker', '.ivu-time-picker'
];
const PANEL_EXCLUDE = '.ant-select-dropdown, .ant-cascader-dropdown, .ant-picker-dropdown, .el-select-dropdown, .el-cascader-panel, .el-picker-panel, .el-date-picker, .el-time-panel, .ivu-select-dropdown, .ivu-cascader-menu, .ivu-picker-panel';

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
  return qS(document, '.ant-modal-content, .el-message-box, .el-dialog__body, .ant-drawer-content, [role="dialog"], .ivu-modal-content, .ivu-drawer-content');
}

// ================= 控件识别引擎 =================
function classifyWrapped(el) {
  let w;
  if ((w = el.closest('.ant-select, .el-select, .ivu-select'))) return { type: 'select', element: w };
  if ((w = el.closest('.ant-cascader, .ant-cascader-picker, .el-cascader, .ivu-cascader'))) return { type: 'cascader', element: w };
  if ((w = el.closest('.ant-picker-range, .el-date-editor--daterange, .el-date-editor--datetimerange, .ivu-date-picker-range'))) return { type: 'date-range', element: w };
  if ((w = el.closest('.ant-picker, .el-date-editor, .ivu-date-picker, .ivu-time-picker'))) return { type: 'date', element: w };
  if ((w = el.closest('.ant-input-number, .el-input-number, .ivu-input-number'))) return { type: 'number', element: w };
  return null;
}

function scanContainer(container) {
  let el;
  if ((el = qS(container, '.ant-cascader, .ant-cascader-picker, .el-cascader, .ivu-cascader'))) return { type: 'cascader', element: el };
  if ((el = qS(container, '.ant-picker-range, .el-date-editor--daterange, .el-date-editor--datetimerange, .ivu-date-picker-range'))) return { type: 'date-range', element: el };
  if ((el = qS(container, '.el-date-editor--time, .el-time-picker, .ivu-time-picker'))) return { type: 'time', element: el };
  if ((el = qS(container, 'input[type="time"]'))) return { type: 'time', element: el };
  if ((el = qS(container, '.ant-picker, .el-date-editor, .ivu-date-picker, input[type="date"]'))) return { type: 'date', element: el };
  if ((el = qS(container, '.ant-select, .el-select, .ivu-select'))) return { type: 'select', element: el };
  const nativeSel = qSA(container, 'select').find(isVisible);
  if (nativeSel) return { type: 'native-select', element: nativeSel };
  if ((el = qS(container, '.ant-radio-group, .el-radio-group, .ivu-radio-group'))) return { type: 'radio', element: el };
  if (qSA(container, 'input[type="radio"]').length >= 2) return { type: 'radio', element: container };
  if ((el = qS(container, '.ant-checkbox-group, .el-checkbox-group, .ivu-checkbox-group'))) return { type: 'checkbox', element: el };
  if (qSA(container, 'input[type="checkbox"]').length >= 2) return { type: 'checkbox', element: container };
  if ((el = qS(container, '.ant-input-number, .el-input-number, .ivu-input-number'))) return { type: 'number', element: el };
  if ((el = qS(container, '.ant-slider, .el-slider, .ivu-slider'))) return { type: 'slider', element: el };
  if ((el = qS(container, '.ant-switch, .el-switch, .ivu-switch'))) return { type: 'switch', element: el };
  if ((el = qS(container, '.ant-rate, .el-rate, .ivu-rate'))) return { type: 'rate', element: el };
  if ((el = qS(container, 'input[type="file"]'))) return { type: 'file', element: el };
  if ((el = qS(container, 'textarea'))) return { type: 'input', element: el };
  if ((el = qS(container, 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])'))) {
    return classifyWrapped(el) || { type: 'input', element: el };
  }
  return null;
}

function findControlByLabel(scope, cleanKey) {
  const allTextNodes = qSA(scope, 'label, span, div, p, th, legend, .el-form-item__label, .ivu-form-item-label');
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
  const input = control.element.tagName === 'INPUT' && control.element.type === 'file'
    ? control.element 
    : qS(control.element, 'input[type="file"]') || qS(document, 'input[type="file"]');

  if (!input) return false;

  const paths = val.split(/[,[,[,,;；、]/).map(p => p.trim()).filter(Boolean);
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
// React 显示文本验证
function reactDisplayText(el) {
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return (el.value || '').trim();
  return (qS(el, '.ant-select-selection-item')?.textContent
    || qS(el, '.ivu-select-selected-value')?.textContent
    || qS(el, '.ant-select-selection-search-input')?.value
    || qS(el, 'input')?.value
    || '').trim();
}

// 沿 Fiber 树向上找 antd Form 实例（useForm 的 store，带 setFieldsValue）
function findFormStore(el) {
  try {
    if (!el) { console.warn('[AutoFill] findFormStore: el is null!'); return null; }
    const fk = getFiberKey(el);
    if (!fk) {
      console.warn(`[AutoFill] findFormStore: el=${el.tagName}.${(el.className||'').toString().substring(0,40)} 无 React Fiber 键! ownKeys=[${Object.getOwnPropertyNames(el).join(',')}]`);
      return null;
    }
    let fiber = el[fk], hops = 0;
    let foundCount = 0;
    while (fiber && hops < 80) {
      const p = fiber.memoizedProps;
      if (p && p.form && typeof p.form.setFieldsValue === 'function') {
        if (foundCount === 0) {
          console.log(`[AutoFill] findFormStore: ✅ 在 hop ${hops} 找到 Form Store, store.getFieldsValue=${typeof p.form.getFieldsValue}`);
        }
        return p.form;
      }
      fiber = fiber.return; hops++;
    }
    console.warn(`[AutoFill] findFormStore: ❌ 遍历 ${hops} 层未找到 Form Store (fk=${fk})`);
  } catch (e) { console.warn('[AutoFill] findFormStore 异常:', e.message); }
  return null;
}

// 沿 Fiber 树向上找 Form.Item 的 name 属性（最可靠的字段名来源）
// 返回 string 或 string[]（嵌套路径，如 ["personInfo", "city"]）
function findFormFieldName(el, fallbackKey) {
  try {
    if (!el) return fallbackKey;
    const fk = getFiberKey(el);
    if (fk) {
      let fiber = el[fk], hops = 0;
      while (fiber && hops < 80) {
        const p = fiber.memoizedProps;
        if (p && p.name) {
          if (typeof p.name === 'string' && p.name.length > 0) {
            console.log(`[AutoFill] findFormFieldName: ✅ Fiber hop ${hops} name="${p.name}"`);
            return p.name;
          }
          // 嵌套路径：返回完整数组，不要只取第一个元素
          if (Array.isArray(p.name) && p.name.length > 0 && p.name.every(x => typeof x === 'string')) {
            console.log(`[AutoFill] findFormFieldName: ✅ Fiber hop ${hops} name=[${p.name.join(',')}]`);
            return p.name;
          }
        }
        fiber = fiber.return; hops++;
      }
      console.log(`[AutoFill] findFormFieldName: Fiber 遍历 ${hops} 层未找到 name`);
    } else {
      console.log('[AutoFill] findFormFieldName: 无 Fiber 键');
    }
  } catch (e) { console.warn('[AutoFill] findFormFieldName 异常:', e.message); }
  const inputInEl = el.tagName === 'INPUT' ? el : (qS(el, 'input[id], input[name]') || null);
  if (inputInEl) {
    if (inputInEl.id) { console.log(`[AutoFill] findFormFieldName: 兜底用 input.id="${inputInEl.id}"`); return inputInEl.id; }
    if (inputInEl.name) { console.log(`[AutoFill] findFormFieldName: 兜底用 input.name="${inputInEl.name}"`); return inputInEl.name; }
  }
  console.log(`[AutoFill] findFormFieldName: 最终兜底用 key="${fallbackKey}"`);
  return fallbackKey;
}

// 将字段名（string 或 string[]）转换为 setFieldsValue 可用的嵌套对象
function buildFieldObject(fieldName, value) {
  if (typeof fieldName === 'string') {
    return { [fieldName]: value };
  }
  if (Array.isArray(fieldName)) {
    const obj = {};
    let cur = obj;
    for (let i = 0; i < fieldName.length - 1; i++) {
      cur[fieldName[i]] = {};
      cur = cur[fieldName[i]];
    }
    cur[fieldName[fieldName.length - 1]] = value;
    return obj;
  }
  return { [String(fieldName)]: value };
}

// 从 getFieldsValue() 结果中按路径取值
function getValueByPath(fieldsValue, fieldName) {
  if (typeof fieldName === 'string') return fieldsValue[fieldName];
  if (Array.isArray(fieldName)) {
    let cur = fieldsValue;
    for (const seg of fieldName) {
      if (cur == null) return undefined;
      cur = cur[seg];
    }
    return cur;
  }
  return undefined;
}

// 强制 Form Store 变化同步到 DOM（Form.Item 受控组件需要事件触发重渲染）
function forceFormSync(el) {
  try {
    // 对所有内部 input 派发事件让 React 同步
    const inputs = qSA(el, 'input');
    for (const inp of inputs) {
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  } catch (e) { /* ignore */ }
}

// 强制 Form.Item / Select 组件重渲染：找 stateNode 调 forceUpdate
function forceReactRerender(el) {
  try {
    const fk = getFiberKey(el);
    if (!fk) return 0;
    let fiber = el[fk];
    let count = 0;
    while (fiber && count < 60) {
      if (fiber.stateNode && typeof fiber.stateNode.forceUpdate === 'function' 
          && fiber.type && (fiber.type.displayName === 'InternalFormItem' 
                          || fiber.type.displayName === 'FormItemInput'
                          || fiber.type.displayName === 'Select'
                          || fiber.type.displayName === 'Cascader')) {
        try { fiber.stateNode.forceUpdate(); count++; } catch(e) {}
      }
      fiber = fiber.return;
    }
    return count;
  } catch (e) { return 0; }
}

// 手动清除 AntD/iView Form.Item 的校验错误 UI
function clearValidationErrors(formItemEl) {
  if (!formItemEl) return;
  try {
    formItemEl.classList.remove('ant-form-item-has-error', 'ant-form-item-with-help', 
                                 'ant-form-item-has-success', 'ant-form-item-has-warning',
                                 'ivu-form-item-error');
    qSA(formItemEl, '.ant-form-item-explain, .ant-form-item-explain-error, .ant-form-item-extra, .ant-form-item-feedback-icon, .ivu-form-item-error-tip').forEach(n => n.remove());
  } catch (e) { /* ignore */ }
}

// 手动同步 DOM 显示（AntD Select 等组件 React 不重渲染时的兜底）
function manualDomSync(el, parts) {
  const displayVal = parts.join(' / ');
  try {
    // AntD Select: 更新 .ant-select-selection-item 或创建它
    const selectionItem = qS(el, '.ant-select-selection-item');
    const selectionPlaceholder = qS(el, '.ant-select-selection-placeholder');
    const selectionSearch = qS(el, '.ant-select-selection-search');
    
    if (selectionPlaceholder) {
      selectionPlaceholder.style.display = 'none';
      selectionPlaceholder.textContent = '';
    }
    
    if (selectionItem) {
      selectionItem.textContent = displayVal;
    } else if (selectionSearch) {
      // 创建 selection-item
      const item = document.createElement('span');
      item.className = 'ant-select-selection-item';
      item.textContent = displayVal;
      selectionSearch.insertBefore(item, selectionSearch.firstChild);
    }
    
    // 更新内部 input（搜索框 / 隐藏值）
    const inputs = qSA(el, 'input');
    for (const inp of inputs) {
      if (inp.value === '' || !inp.value) {
        try {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(inp, displayVal);
          else inp.value = displayVal;
        } catch(e) { inp.value = displayVal; }
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    
    // AntD Cascader: 更新 .ant-cascader-picker-label
    const cascaderLabel = qS(el, '.ant-cascader-picker-label');
    if (cascaderLabel) {
      cascaderLabel.textContent = displayVal;
    }
    
    // AntD DatePicker: 更新 picker input
    const pickerInput = qS(el, '.ant-picker input');
    if (pickerInput && !pickerInput.value) {
      try {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(pickerInput, displayVal);
        else pickerInput.value = displayVal;
      } catch(e) { pickerInput.value = displayVal; }
    }
    
    // iView Select: 更新 .ivu-select-selected-value 和隐藏 input
    const ivuSelectedValue = qS(el, '.ivu-select-selected-value');
    const ivuHiddenInput = qS(el, '.ivu-select-selection input[type="hidden"]');
    if (ivuSelectedValue) {
      ivuSelectedValue.textContent = displayVal;
    }
    if (ivuHiddenInput && parts[0]) {
      ivuHiddenInput.value = parts[0];
      ivuHiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    console.log(`[AutoFill] DOM 手动同步: ${displayVal}`);
  } catch (e) { /* ignore */ }
}

// Vue/iView 直写：通过 Vue 实例更新 Form 或组件 v-model
async function vueDirectSet(el, key, val) {
  try {
    const vm = getVueInstance(el);
    if (!vm) return false;
    
    console.log(`[AutoFill] vueDirectSet: 找到 Vue 实例, key=${key}, val=${val}`);
    
    // 尝试找 Form 实例
    const form = findVueForm(vm);
    
    // 从 Vue 实例的 $attrs / props 里找字段名（prop）
    let fieldName = key;
    try {
      const comp = vm.$vnode?.componentOptions?.propsData || vm._props || vm.$options.propsData;
      if (comp && comp.prop) fieldName = comp.prop;
    } catch (e) { /* ignore */ }
    
    const parts = String(val).split(/[,，;；、]/).map(s => s.trim()).filter(Boolean);
    const cv = parts[0];
    
    let storeOk = false;
    
    // 方案 A：通过 Form.setFieldsValue
    if (form) {
      try {
        form.setFieldsValue({ [fieldName]: cv });
        storeOk = true;
        console.log(`[AutoFill] Vue Form.setFieldsValue: ${fieldName} = ${cv}`);
      } catch (e) {
        console.warn(`[AutoFill] Vue Form.setFieldsValue 失败: ${e.message}`);
      }
    }
    
    // 方案 B：直接操作组件 v-model（$emit('input')）
    if (!storeOk) {
      try {
        // iView Select: vm.value 是当前值，$emit('input', newVal) 更新
        if (typeof vm.$emit === 'function') {
          vm.$emit('input', cv);
          console.log(`[AutoFill] Vue $emit('input', ${cv})`);
        }
        // 兜底：直接设置内部 value
        if ('value' in vm) {
          vm.value = cv;
        }
        // iView Select 内部还有 selectedSingleValue / currentValue
        if ('currentValue' in vm) vm.currentValue = cv;
        storeOk = true;
      } catch (e) {
        console.warn(`[AutoFill] Vue $emit 失败: ${e.message}`);
      }
    }
    
    // 验证
    if (storeOk) {
      await sleep(150);
      // 同步 DOM 显示
      manualDomSync(el, parts);
      console.log(`[AutoFill] ✅ Vue 直写成功: ${fieldName} = ${cv}`);
      return true;
    }
    
    return false;
  } catch (e) {
    console.warn(`[AutoFill] vueDirectSet 异常: ${e.message}`);
    return false;
  }
}

// React 直写：完整链路 — setFieldValue → touched → forceUpdate → 清校验 → 手动 DOM 同步
async function reactDirectSet(el, key, val) {
  const parts = String(val).split(/[,，;；、]/).map(s => s.trim()).filter(Boolean);
  const nv = normText(parts[0]);
  
  // 获取可靠字段名
  const fieldName = findFormFieldName(el, key);
  console.log(`[AutoFill] reactDirectSet: fieldName=${fieldName}, targetValue=${val}`);
  
  const formItemEl = el.closest('.ant-form-item, .el-form-item, .ivu-form-item');
  
  const verifyStore = (form) => {
    try {
      if (!form.getFieldsValue) return false;
      const got = getValueByPath(form.getFieldsValue(), fieldName);
      if (got === undefined || got === null) return false;
      return true;
    } catch (e) { return false; }
  };

  const form = findFormStore(el);
  if (!form) {
    console.warn(`[AutoFill] reactDirectSet: 未找到 Form Store`);
    return false;
  }

  // 尝试多种值形态
  const candidateVals = [];
  if (parts.length > 1) {
    candidateVals.push(parts);
    candidateVals.push(parts.map(v => ({ value: v, label: v })));
  } else {
    candidateVals.push(parts[0]);
    candidateVals.push({ value: parts[0], label: parts[0] });
  }
  
  let storeOk = false;
  
  for (const cv of candidateVals) {
    // 方案 A：setFieldValue（优先，触发 Form.Item 内部更新流程）
    try {
      if (typeof form.setFieldValue === 'function') {
        form.setFieldValue(fieldName, cv);
        storeOk = true;
      }
    } catch (e) { /* ignore */ }
    
    // 方案 B：setFieldsValue（兜底，用 buildFieldObject 支持嵌套路径）
    if (!storeOk) {
      try {
        form.setFieldsValue(buildFieldObject(fieldName, cv));
        storeOk = true;
      } catch (e) { /* ignore */ }
    }
    
    if (storeOk) break;
  }
  
  if (!storeOk) {
    console.warn(`[AutoFill] Form Store 所有写入方式都失败`);
    return false;
  }
  
  // 标记 touched + 清除校验错误
  try {
    if (typeof form.setFieldTouched === 'function') {
      form.setFieldTouched(fieldName, true);
    }
  } catch (e) { /* ignore */ }
  
  // 清除 DOM 上的校验错误
  clearValidationErrors(formItemEl);
  
  // 等待 React 消化
  await sleep(300);
  
  // 验证 Store
  if (!verifyStore(form)) {
    console.warn(`[AutoFill] Store 验证失败: ${fieldName}`);
    return false;
  }
  console.log(`[AutoFill] ✅ Store 写入成功: ${fieldName} = ${val}`);
  
  // 手动同步 DOM（让用户也能看到）
  manualDomSync(el, parts);
  
  // 再等一下验证 DOM 是否被 React 接管了
  await sleep(200);
  
  console.log(`[AutoFill] 禁用字段处理完成: ${fieldName} = ${val}`);
  return true;
}

async function fillControl(control, key, value, interval) {
  const val = String(value).trim();
  const el = control.element;

  const isDisabled = el.hasAttribute('disabled') || el.hasAttribute('readonly') || 
                     !!el.closest('.ant-select-disabled, .el-select--disabled, .is-disabled, .ant-picker-disabled, .ivu-select-disabled, .ivu-date-picker-disabled');

  // 💡 禁用字段：深度解封 + Form Store 直写 + 强制重渲染 + 清校验错误
  if (isDisabled) {
    console.log(`[AutoFill] 处理禁用控件: ${key} = ${val}`);

    // ---- 深度解封 DOM：移除所有层级的 disabled / readonly / 禁用 class ----
    const DISABLED_CLASSES = ['ant-select-disabled', 'ant-picker-disabled', 'ant-cascader-disabled', 
                              'el-select--disabled', 'is-disabled', 'ant-input-disabled', 'ant-input-number-disabled',
                              'ivu-select-disabled', 'ivu-date-picker-disabled', 'ivu-cascader-disabled', 'ivu-input-disabled'];
    const stripDisabled = (node) => {
      if (!node) return;
      node.removeAttribute('disabled');
      node.removeAttribute('readonly');
      try { node.classList.remove(...DISABLED_CLASSES); } catch(e) {}
    };
    stripDisabled(el);
    let up = el;
    for (let i = 0; i < 8 && up; i++) { stripDisabled(up); up = up.parentElement; }
    qSA(el, 'input, textarea, select, button').forEach(stripDisabled);
    await sleep(50);

    // ---- Patch Fiber 内部：disabled + readOnly（React 真正读取的 props）----
    let patchedTotal = 0;
    try {
      const fk = getFiberKey(el);
      if (fk) {
        let fiber = el[fk];
        let hops = 0;
        while (fiber && hops < 80) {
          const p = fiber.memoizedProps;
          if (p) {
            if (p.disabled === true) { p.disabled = false; patchedTotal++; }
            if (p.readOnly === true) { p.readOnly = false; patchedTotal++; }
            if (p.readonly === true) { p.readonly = false; patchedTotal++; }
          }
          fiber = fiber.return;
          hops++;
        }
        console.log(`[AutoFill] Fiber patch: 解除 ${patchedTotal} 个 disabled/readOnly 属性 (遍历 ${hops} 层)`);
      }
    } catch (e) { /* ignore */ }

    await sleep(100);

    // ---- 原生 <select> ----
    const nativeSel = el.tagName === 'SELECT' ? el : qS(el, 'select');
    if (nativeSel) {
      const opt = qSA(nativeSel, 'option').find(o => normText(o.textContent) === normText(val) || o.value === val);
      nativeSel.value = opt ? opt.value : val;
      nativeSel.dispatchEvent(new Event('change', { bubbles: true }));
      console.log(`[AutoFill] 原生 select 直写: ${key} = ${val}`);
      await sleep(interval);
      return true;
    }

    // ---- Vue/iView：通过 Vue 实例直写 Form 或组件 v-model ----
    if (await vueDirectSet(el, key, val)) {
      await sleep(interval);
      return true;
    }

    // ---- React/AntD：完整链路直写（含 forceUpdate + 清校验）----
    if (await reactDirectSet(el, key, val)) {
      await sleep(interval);
      return true;
    }

    // ---- Vue/兜底 ----
    const innerInput = qS(el, 'input');
    if (innerInput) {
      setNativeInputValue(innerInput, val);
    }

    await sleep(interval);
    return true;
  }

  // ================= 方案 B：【正常非禁用状态】控件 =================
  if (control.type === 'radio') {
    const radios = qSA(el, 'input[type="radio"]');
    let matched = false;
    for (const r of radios) {
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
    const targets = val.split(/[,[,[,,;；、]/).map(v => mapValue(v.trim())).filter(Boolean);
    const boxes = qSA(el, 'input[type="checkbox"]');
    let any = false;
    for (const cb of boxes) {
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
    const input = qS(el, 'input') || el;
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    setNativeInputValue(input, val);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await sleep(interval);
    return true;
  }

  if (control.type === 'cascader') {
    const trigger = qS(el, 'input, .ant-select-selector, .el-input__inner') || el;
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

    const input = qS(el, 'input') || el;
    if (input) {
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
    const values = val.split(/[,[,[,,;；、]/).map(v => mapValue(v.trim())).filter(Boolean);
    const trigger = qS(el, 'input, .ant-select-selector, .el-select__caret, .el-input__inner') || el;
    let selectedAny = false;

    for (const v of values) {
      realClick(trigger);
      await sleep(300);

      const searchInput = qS(el, 'input[role="combobox"], .ant-select-selection-search-input') 
                       || qS(document, '.ant-select-dropdown input[type="search"]');

      if (searchInput) {
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
    const input = qS(el, 'input, textarea') || el;
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
    const btns = qSA(scope, 'button, a, div[role="button"], .ant-btn, .el-button, .ivu-btn').filter(isVisible);
    const byType = btns.find(b => b.getAttribute && b.getAttribute('type') === 'submit');
    if (byType) return byType;
    const hit = btns.find(b => {
      const t = norm(b);
      return t && !NEG.some(k => t.includes(k)) && POS.some(k => t.includes(k));
    });
    if (hit) return hit;
    const primary = btns.filter(b => /ant-btn-primary|el-button--primary|ivu-btn-primary/.test(b.className || ''));
    if (primary.length) return primary[primary.length - 1];
  }
  return null;
}

// ================= 页面字段扫描引擎 =================
function scanPageLabels() {
  const dialog = getActiveDialog();
  const scope = dialog || document;
  const labels = new Set();

  const formItems = qSA(scope, '.ant-form-item, .el-form-item, .ivu-form-item, form div, .form-group');
  for (const item of formItems) {
    if (!isVisible(item)) continue;
    const labelNode = qS(item, 'label, .ant-form-item-label, .el-form-item__label, .ivu-form-item-label, span');
    if (labelNode && !labelNode.closest(PANEL_EXCLUDE)) {
      const txt = (labelNode.textContent || '').replace(/[*：:\r\n]/g, '').trim();
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

  if (row["职位类别"] && !row["positionCategory"]) row["positionCategory"] = row["职位类别"];
  if (row["职位名称"] && !row["positionName"]) row["positionName"] = row["职位名称"];
  if (row["positionCategory"] && !row["职位类别"]) row["职位类别"] = row["positionCategory"];
  if (row["positionName"] && !row["职位名称"]) row["职位名称"] = row["positionName"];

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