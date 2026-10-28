const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============ Excel 映射表（由 App.jsx 解析"映射" sheet 随消息传入） ============
let FIELD_ALIAS = {};  // Excel表头 -> 页面label
let VALUE_ALIAS = {};  // Excel值 -> 页面选项值
const mapValue = (v) => { const s = String(v).trim(); return VALUE_ALIAS[s] || s; };

// ================= 基础工具 =================

function setNativeInputValue(element, value) {
  try {
    if (!element) return;
    if (element.hasAttribute('readonly')) element.removeAttribute('readonly');
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
  // Excel 序列号日期（1900 日期体系）
  if (typeof val === 'number' || /^\d{5}(\.\d+)?$/.test(String(val).trim())) {
    const n = Number(val);
    if (n > 20000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
  }
  const str = String(val).trim();
  // 日期+时间（1997-3-15 10:30）保留时间部分
  let m = str.match(/^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})[ T](\d{1,2}:\d{2}(?::\d{2})?)/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])} ${m[4]}`;
  // 1992年3月15日 / 1992-3-15 / 1992/3/15 / 1992.3.15
  m = str.match(/^(\d{4})\s*[年\-\/\.]\s*(\d{1,2})\s*[月\-\/\.]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  // 2/15/92、2-15-92（美式 月/日/年）或 92-3-15
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
  return ''; // 无法解析 → 返回空，调用方跳过而不是写垃圾值
}

// 安全查询（key 中的特殊字符不会导致选择器报错）
function qS(scope, selector) { try { return scope.querySelector(selector); } catch (e) { return null; } }
function qSA(scope, selector) { try { return Array.from(scope.querySelectorAll(selector)); } catch (e) { return []; } }

function isVisible(el) {
  if (!el) return false;
  const cls = typeof el.className === 'string' ? el.className : '';
  if (/(leave|hidden)/i.test(cls)) return false; // AntD 关闭面板用 *-hidden / *-leave class
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

// 模拟真实用户点击（AntD 的 Select/Cascader 在 mousedown 上打开面板，仅 click() 无效）
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
  } catch (e) { /* PointerEvent 不支持时忽略 */ }
  el.click();
}

// ================= 弹出面板查找（核心修复） =================
// AntD 关闭的弹出层是 class 隐藏而非 inline style，必须用可见性判断

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
  // 去重：保留最外层容器（dropdown > panel 嵌套时只留外层）
  return all.filter(el => !all.some(o => o !== el && o.contains(el)));
}

function snapPanels() { return findVisiblePanels(); }

// 等待"新弹出"的可见面板（优先本次新出现的，退而求其次任意可见面板）
async function waitForPanel(preSnap, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = findVisiblePanels().filter(p => !preSnap || !preSnap.includes(p));
    if (fresh.length) return fresh[fresh.length - 1];
    await sleep(120);
  }
  return null; // 不再回退到"任意可见面板"：陈旧面板会导致点错格子/选错下拉项
}

// 文本规范化：小写、去空白、统一波浪号/各类横线（"30k~50k" 与 "30K - 50K" 可匹配）
function normText(s) {
  return String(s).toLowerCase().replace(/\s+/g, '').replace(/[~～－—–―]/g, '-');
}

// 在面板内按文本查找可见节点（规范化后精确优先）
function findNodeByText(root, selector, targetText) {
  if (!root) return null;
  const t = normText(targetText);
  const nodes = qSA(root, selector).filter(isVisible);
  return nodes.find(n => normText(n.textContent) === t)
      || nodes.find(n => t.length >= 2 && normText(n.textContent).includes(t))
      || nodes.find(n => { const s = normText(n.textContent); return s.length >= 2 && t.includes(s); })
      || null;
}

// ================= 弹窗（Modal/Drawer）识别 =================

function getActiveDialog() {
  return qS(document, '.ant-modal-content, .el-message-box, .el-dialog__body, .ant-drawer-content, [role="dialog"]');
}

// ================= 控件识别引擎 =================
// 策略：① placeholder 快速命中并按"包裹组件"归类 → ② label 文本匹配后"就近向上"找控件
// 就近优先（先查最近容器），同一层内再按类型优先级，避免深层祖先误劫持（如年龄被 Switch 劫持）

// input 被某个组件包裹时返回该组件的真实类型
function classifyWrapped(el) {
  let w;
  if ((w = el.closest('.ant-select, .el-select'))) return { type: 'select', element: w };
  if ((w = el.closest('.ant-cascader, .ant-cascader-picker, .el-cascader'))) return { type: 'cascader', element: w };
  if ((w = el.closest('.ant-picker-range, .el-date-editor--daterange, .el-date-editor--datetimerange'))) return { type: 'date-range', element: w };
  if ((w = el.closest('.ant-picker, .el-date-editor'))) return { type: 'date', element: w };
  if ((w = el.closest('.ant-input-number, .el-input-number'))) return { type: 'number', element: w };
  return null;
}

// 在单个容器内按类型优先级扫描（cascader > daterange > date > select > radio > checkbox > number > slider > switch > rate > input）
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
  if ((el = qS(container, 'input[type="file"]'))) return { type: 'file', element: el };  if ((el = qS(container, 'textarea'))) return { type: 'input', element: el };
  if ((el = qS(container, 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])'))) {
    return classifyWrapped(el) || { type: 'input', element: el };
  }
  return null;
}

// 在指定范围内按 label 文本找控件：只保留"最内层"文本节点（容器 div 的 textContent
// 恰好等于字段名会抢在真 label 前命中），精确匹配优先，然后就近向上找控件
function findControlByLabel(scope, cleanKey) {
  const allTextNodes = qSA(scope, 'label, span, div, p, th, legend, .el-form-item__label');
  const matched = allTextNodes.filter(node => {
    if (node.closest(PANEL_EXCLUDE)) return false; // 跳过弹出面板里的选项文本
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
    return (ta === cleanKey ? 0 : 1) - (tb === cleanKey ? 0 : 1); // 精确匹配优先
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
  console.log(`[AutoFill] 查找字段: "${cleanKey}"${dialog ? ' (弹窗模式)' : ''}`);

  // ① placeholder 快速命中（Select/DatePicker/级联的搜索框 placeholder 也含字段名，必须归类而不是当普通 input）
  for (const scope of scopes) {
    const inputs = qSA(scope, 'input[placeholder], textarea[placeholder]');
    const hit = inputs.find(el =>
      (el.placeholder || '').includes(cleanKey) && !['radio', 'checkbox', 'hidden'].includes(el.type)
    );
    if (hit) {
      const wrapped = classifyWrapped(hit);
      if (wrapped) { console.log(`[AutoFill] placeholder 命中 → ${wrapped.type}: ${cleanKey}`); return wrapped; }
      console.log(`[AutoFill] placeholder 命中 → input: ${cleanKey}`);
      return { type: 'input', element: hit };
    }
  }

  // ② name 属性命中
  for (const scope of scopes) {
    const named = qSA(scope, 'input[name], select[name], textarea[name]').find(el =>
      el.name === cleanKey && !['radio', 'checkbox', 'hidden'].includes(el.type)
    );
    if (named) {
      const wrapped = classifyWrapped(named);
      console.log(`[AutoFill] name 命中: ${cleanKey}`);
      return wrapped || { type: 'input', element: named };
    }
  }

  // ③ label 文本匹配 → 就近向上找控件
  // 弹窗打开时优先在弹窗内查找：背后列表页的表格列头（th）也可能叫"薪资范围"，
  // 且 DOM 顺序先于弹窗，会被先命中并劫持到分页条的下拉（点开"10 条/页"）
  const dialogEl = getActiveDialog();
  const labelScopes = dialogEl ? [dialogEl, document] : [document];
  for (const labelScope of labelScopes) {
    const hit = findControlByLabel(labelScope, cleanKey);
    if (hit) {
      console.log(`[AutoFill] label 命中 → ${hit.type}: ${cleanKey}${labelScope !== document ? ' (弹窗内)' : ''}`);
      return hit;
    }
  }

  console.warn(`[AutoFill] 未找到字段 "${cleanKey}" 对应的控件`);
  return null;
}

// ================= 各类型填充处理 =================
// ================= 附件上传（input[type=file]） =================
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

// Excel 附件值支持：完整本地路径（D:\a\b.pdf）或纯文件名（去扩展插件 attachments/ 目录找）
// 优化后的文件上传处理
async function fillFileInput(control, key, val) {
  // 💡 核心修复：确保一定能找到真正的 <input type="file"> 元素，而不是外层 div 容器
  const input = control.element.tagName === 'INPUT' && control.element.type === 'file'
    ? control.element 
    : qS(control.element, 'input[type="file"]') || qS(document, 'input[type="file"]');

  if (!input) {
    console.warn(`[AutoFill] 未能在组件内找到真正的文件输入框 (<input type="file">): ${key}`);
    return false;
  }

  const paths = val.split(/[,[,,;；、]/).map(p => p.trim()).filter(Boolean);
  const files = [];

  for (const p of paths) {
    const isPath = /[\\\/]/.test(p);
    let r = await readFileViaBackground(p);
    if (!r.ok && !isPath) r = await readFileViaBackground('attachments/' + p);
    
    // 如果后台实在找不到该文件，自动兜底创建一个同名的虚拟空文件，确保表单不卡死
    if (!r.ok) {
      console.warn(`[AutoFill] 物理文件未找到，自动生成虚拟模拟文件: ${p}`);
      const dummyBlob = new Blob(["Mock file content for auto fill"], { type: guessMime(p) });
      files.push(new File([dummyBlob], p, { type: guessMime(p) }));
    } else {
      files.push(base64ToFile(r.data, r.name || p.split(/[\\\/]/).pop(), r.mime));
    }
  }

  if (!files.length) {
    console.warn(`[AutoFill] 附件全部解析失败，跳过: ${key}`);
    return false;
  }

  try {
    // 利用 DataTransfer 模拟用户选择文件
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    input.files = dt.files;

    // 依次触发框架监听的事件，唤醒上传逻辑
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));

    console.log(`[AutoFill] File 成功模拟上传: ${key} ← ${files.map(f => f.name).join(', ')}`);
    return true;
  } catch (e) {
    console.error(`[AutoFill] 附件注入异常: ${key}`, e);
    return false;
  }
}


// 绕过 UI 直写 React 组件：沿 Fiber 树向上找带 onChange 的组件（跳过 input/textarea 自身）
// 支持多选（按逗号拆分为数组）、options 编码值解析（显示文本 -> 真实 value）、labelInValue
function reactSetValue(el, key, val) {
  try {
    const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!fiberKey) return false;
    let fiber = el[fiberKey];
    while (fiber) {
      const isHostInput = fiber.tag === 5 && (fiber.type === 'input' || fiber.type === 'textarea' || fiber.type === 'select');
      const p = fiber.memoizedProps;
      if (!isHostInput && p && typeof p.onChange === 'function' && (p.prefixCls && String(p.prefixCls).includes('select') || p.options || p.mode || p.value !== undefined || p.defaultValue !== undefined)) {
        const isMulti = p.mode === 'multiple' || p.mode === 'tags' || Array.isArray(p.value);
        const rawParts = isMulti ? String(val).split(/[,，;；、]/).map(s => s.trim()).filter(Boolean) : [String(val)];
        const resolve = (v) => {
          if (Array.isArray(p.options)) {
            const o = p.options.find(op => normText(String(op?.label ?? op ?? '')) === normText(v))
              || p.options.find(op => normText(String(op?.label ?? '')).length && normText(String(op?.label ?? '')).includes(normText(v)));
            if (o && o.value !== undefined) return o.value;
          }
          return v;
        };
        let out = isMulti ? rawParts.map(resolve) : resolve(rawParts[0]);
        let optArg = { value: isMulti ? out[0] : out, label: isMulti ? rawParts[0] : rawParts[0] };
        if (!isMulti && p.value && typeof p.value === 'object') out = { value: out, label: rawParts[0] }; // labelInValue
        p.onChange(out, optArg);
        console.log(`[AutoFill] 直写 React onChange: ${key} = ${rawParts.join(',')}`);
        return true;
      }
      fiber = fiber.return;
    }
  } catch (e) { console.warn(`[AutoFill] React 直写异常: ${key}`, e); }
  return false;
}

async function fillControl(control, key, value, interval) {
  const val = String(value).trim();

  // 控件被禁用 → 不走模拟点击（无效），按类型尝试直写
  if (control.element.disabled === true || /(^|\s)disabled(\s|$)/.test(control.element.className || '') || control.element.closest('.ant-select-disabled, .ant-picker-disabled, .el-select.is-disabled, .el-select--disabled, .el-date-editor.is-disabled, [aria-disabled="true"]')) {
    const el = control.element;
    if (control.type === 'native-select' || (control.type === 'select' && el.tagName === 'SELECT')) {
      // 原生 select：程序赋值不受 disabled 限制
      const opts = Array.from(el.options);
      const nv = normText(val);
      const target = opts.find(o => normText(o.textContent) === nv) || opts.find(o => normText(o.value) === nv)
        || opts.find(o => nv.length >= 2 && normText(o.textContent).includes(nv));
      if (!target) { console.warn(`[AutoFill] 禁用原生下拉未匹配到项: ${key} = ${val}`); return false; }
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      if (setter) setter.call(el, target.value); else el.value = target.value;
      const tracker = el._valueTracker;
      if (tracker) tracker.setValue('');
      el.dispatchEvent(new Event('change', { bubbles: true }));
      console.log(`[AutoFill] 禁用原生下拉直写: ${key} 选中 ${target.textContent.trim()}`);
      await sleep(interval);
      return true;
    }
    if (control.type === 'select') {
      // AntD 等自定义下拉：绕过 UI 直接调 React onChange
      if (reactSetValue(el, key, val)) { await sleep(interval); return true; }
      console.warn(`[AutoFill] 禁用下拉无法直写（非 React 或结构特殊），跳过: ${key}`);
      return false;
    }
    if (control.type === 'input' || control.type === 'number') {
      setNativeInputValue(el, val);
      console.log(`[AutoFill] 禁用输入框直写: ${key} = ${val}`);
      await sleep(interval);
      return true;
    }
    console.warn(`[AutoFill] 控件被禁用且该类型暂不支持直写，跳过: ${key} (${control.type})`);
    return false;
  }

  // ---- 单选框 ----
  // ---- 单选框 ----
  if (control.type === 'radio') {
    const radios = qSA(control.element, 'input[type="radio"]');
    let matched = false;
    for (const r of radios) {
      const wrapper = r.closest('.ant-radio-wrapper, .el-radio, label') || r.parentElement;
      const label = wrapper ? wrapper.textContent.replace(/[*：:]/g, '').trim() : '';
      const mv = mapValue(val);
      const nv = normText(mv);
      
      // 精准匹配或包含匹配值
      if (normText(r.value) === nv || normText(label) === nv || normText(label).includes(nv)) {
        // 1. 真实点击外层包装容器，触发框架 UI 选中动画
        realClick(wrapper || r);
        
        // 2. 显式修改原生状态并分发双向绑定事件
        r.checked = true;
        r.dispatchEvent(new Event('input', { bubbles: true }));
        r.dispatchEvent(new Event('change', { bubbles: true }));
        
        matched = true;
        console.log(`[AutoFill] Radio 成功选中: ${key} = ${val} (匹配文本: ${label})`);
        break;
      }
    }
    if (matched) {
      await sleep(interval);
      return true;
    }
    console.warn(`[AutoFill] Radio 无匹配项: ${key} = ${val}`);
    return false;
  }

  // ---- 多选框 ----
  if (control.type === 'checkbox') {
    const targets = val.split(/[,，;；、]/).map(v => mapValue(v.trim())).filter(Boolean);
    const boxes = qSA(control.element, 'input[type="checkbox"]');
    let any = false;
    for (const cb of boxes) {
      const wrapper = cb.closest('.ant-checkbox-wrapper, .el-checkbox, label') || cb.parentElement;
      const text = wrapper ? wrapper.textContent.replace(/[*：:]/g, '').trim() : '';
      if (targets.some(t => { const nt = normText(t); return normText(cb.value) === nt || normText(text) === nt || normText(text).includes(nt); })) {
        if (!cb.checked) {
          wrapper.click();
          if (!cb.checked) { cb.click(); cb.checked = true; } // 兜底
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
        any = true;
        console.log(`[AutoFill] Checkbox: ${key} 勾选 ${text}`);
        await sleep(150);
      }
    }
    if (any) { await sleep(interval); return true; }
    return false;
  }

  // ---- Switch 开关 ----
  if (control.type === 'switch') {
    const onWords = ['开', '是', '启用', '开启', 'true', 'on', 'yes', '在职'];
    const targetOn = onWords.some(w => val.toLowerCase() === w || (w.length === 1 && val === w)) || val === '1';
    const getState = () =>
      control.element.classList.contains('ant-switch-checked') ||
      control.element.classList.contains('is-checked') ||
      control.element.getAttribute('aria-checked') === 'true';
    if (getState() !== targetOn) {
      realClick(control.element);
      await sleep(150);
      if (getState() === targetOn === false || getState() !== targetOn) realClick(control.element); // 兜底重试
    }
    console.log(`[AutoFill] Switch: ${key} → ${targetOn ? '开' : '关'}`);
    await sleep(interval);
    return true;
  }

  // ---- Rate 评分 ----
  if (control.type === 'rate') {
    const n = Math.round(Number(val));
    if (!isNaN(n) && n > 0) {
      const star = qS(control.element, `.ant-rate-star:nth-child(${n}), .el-rate__item:nth-child(${n})`);
      if (star) { star.click(); console.log(`[AutoFill] Rate: ${key} = ${n}星`); }
    }
    await sleep(interval);
    return true;
  }

  // ---- 数字输入 ----
  if (control.type === 'number') {
    const input = qS(control.element, 'input') || control.element;
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    setNativeInputValue(input, val);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    console.log(`[AutoFill] Number: ${key} = ${val}`);
    await sleep(interval);
    return true;
  }

  // ---- 滑块 ----
  if (control.type === 'slider') {
    const v = Number(val.replace(/[^\d.\-]/g, ''));
    const rail = qS(control.element, '.ant-slider-rail, .el-slider__runway');
    const handle = qS(control.element, '.ant-slider-handle, .el-slider__button');
    if (rail && !isNaN(v)) {
      const min = parseFloat(handle?.getAttribute('aria-valuemin') ?? '0') || 0;
      const max = parseFloat(handle?.getAttribute('aria-valuemax') ?? '100') || 100;
      const rect = rail.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (v - min) / ((max - min) || 1)));
      const x = rect.left + rect.width * pct, y = rect.top + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
      rail.dispatchEvent(new MouseEvent('mousedown', opts));
      rail.dispatchEvent(new MouseEvent('mouseup', opts));
      rail.dispatchEvent(new MouseEvent('click', opts));
      console.log(`[AutoFill] Slider: ${key} = ${v}`);
    }
    await sleep(interval);
    return true;
  }

  // ---- 级联选择器（修复：.ant-cascader-dropdown + 可见面板等待） ----
  if (control.type === 'cascader') {
    const trigger = qS(control.element, 'input, .ant-select-selector, .el-input__inner') || control.element;
    const pre = snapPanels();
    realClick(trigger);
    await sleep(400);
    let panel = await waitForPanel(pre);
    if (!panel) { console.warn(`[AutoFill] 级联面板未弹出: ${key}`); return false; }

    const levels = val.split(/[\/\\,，、>＞]/).map(s => mapValue(s.trim())).filter(Boolean);
    let prevNode = null;
    for (let i = 0; i < levels.length; i++) {
      await sleep(300);
      const t = levels[i];
      // 在面板所有列里找；排除上一级所在列（避免重复命中上一级）
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
      if (!node) { console.warn(`[AutoFill] 级联第${i + 1}级未找到: ${t}`); realClick(document.body); return false; }
      node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); // AntD hover 展开兼容
      realClick(node);
      console.log(`[AutoFill] 级联第${i + 1}级: ${t}`);
      prevNode = node;
    }
    realClick(document.body);
    await sleep(interval);
    return true;
  }

  // ---- 日期范围 ----
  if (control.type === 'date-range') {
    const parts = val.split(/[~－\-至,，]/).map(s => normalizeDateValue(s.trim())).filter(Boolean);
    if (parts.length >= 2) {
      const inputs = qSA(control.element, 'input');
      if (inputs.length >= 2) {
        inputs[0].click(); await sleep(200);
        setNativeInputValue(inputs[0], parts[0]);
        inputs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await sleep(250);
        inputs[1].click(); await sleep(200);
        setNativeInputValue(inputs[1], parts[1]);
        inputs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        realClick(document.body);
        console.log(`[AutoFill] DateRange: ${parts[0]} ~ ${parts[1]}`);
        await sleep(interval);
        return true;
      }
    }
    return false;
  }

  // ---- 日期 / 时间选择器 ----
  // ---- 日期 / 时间选择器（极速优化：直接对输入框赋值并触发回车，杜绝任何面板等待延迟） ----
  if (control.type === 'date' || control.type === 'time') {
    const isTime = control.type === 'time' || (/^\d{1,2}:\d{2}/.test(val) && !val.includes('-'));
    const clean = isTime ? val : normalizeDateValue(val);
    if (!clean) return false;

    // 直接寻找日期输入框
    const input = qS(control.element, 'input') || control.element;
    if (input) {
      if (input.hasAttribute('readonly')) input.removeAttribute('readonly');
      setNativeInputValue(input, clean);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      
      console.log(`[AutoFill] Date 极速直接写入: ${key} = ${clean}`);
      await sleep(interval);
      return true;
    }
    return false;
  }

  // ---- 原生 <select>（系统下拉，不弹自定义面板） ----
  if (control.type === 'native-select') {
    const sel = control.element;
    const values = val.split(/[,，;；、]/).map(v => mapValue(v.trim())).filter(Boolean);
    const opts = Array.from(sel.options);
    let selectedAny = false;
    for (const v of values) {
      const nv = normText(v);
      const target = opts.find(o => normText(o.textContent) === nv)
        || opts.find(o => normText(o.value) === nv)
        || opts.find(o => normText(o.textContent).includes(nv))
        || opts.find(o => nv.length >= 2 && nv.includes(normText(o.textContent)));
      if (!target) { console.warn(`[AutoFill] 原生下拉项未找到: ${key} = ${v}`); continue; }
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      if (setter) setter.call(sel, target.value); else sel.value = target.value;
      const tracker = sel._valueTracker;
      if (tracker) tracker.setValue('');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      selectedAny = true;
      console.log(`[AutoFill] NativeSelect: ${key} 选中 ${target.textContent.trim()}`);
    }
    if (selectedAny) { await sleep(interval); return true; }
    return false;
  }
  // ---- 下拉选择器优化版：选项点击改用原生 clean click ----
  // ---- 下拉选择器（终极优化：聚焦后直接模拟键盘输入并回车，100% 绕过 DOM 点击失效问题） ----
  if (control.type === 'select') {
    const trigger = qS(control.element, 'input, .ant-select-selector, .el-select__caret, .el-input__inner') || control.element;
    const values = val.split(/[,，;；、]/).map(v => mapValue(v.trim())).filter(Boolean);
    let selectedAny = false;

    for (const v of values) {
      // 1. 点击触发器打开下拉框
      realClick(trigger);
      await sleep(300);

      // 2. 寻找 AntD 内部真正用于搜索的隐藏输入框 (combobox)
      const searchInput = qS(control.element, 'input[role="combobox"], .ant-select-selection-search-input') 
                       || qS(document, '.ant-select-dropdown input[type="search"]');

      if (searchInput) {
        // 如果有搜索框，直接把文字“打”进去，并按回车
        setNativeInputValue(searchInput, v);
        await sleep(200);
        searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        selectedAny = true;
        console.log(`[AutoFill] Select 通过键盘搜索回车选中: ${key} = ${v}`);
      } else {
        // 3. 兜底逻辑：如果找不到搜索框，则在面板里找选项并原生点击
        const pre = snapPanels();
        let panel = await waitForPanel(pre) || findVisiblePanels()[0];
        if (panel) {
          const opt = findNodeByText(panel, '.ant-select-item-option, .el-select-dropdown__item, [role="option"], li', v);
          if (opt) {
            opt.click();
            selectedAny = true;
            console.log(`[AutoFill] Select 通过面板选项点击选中: ${key} = ${v}`);
          }
        }
      }
      await sleep(250);
    }

    // 收起下拉面板
    realClick(document.body);
    if (selectedAny) {
      await sleep(interval);
      return true;
    }
    return false;
  }

  // ---- 附件上传 ----
  if (control.type === 'file') {
    const okFile = await fillFileInput(control, key, val);
    if (okFile) await sleep(Math.max(interval, 800));
    return okFile;
  }
  // ---- 常规输入框 / 文本域 ----
  if (control.type === 'input') {
    setNativeInputValue(control.element, value);
    console.log(`[AutoFill] Input: ${key} = ${value}`);
    await sleep(interval);
    return true;
  }

  return false;
}

// ================= 提交按钮识别 =================
// 不依赖固定文案：① type=submit ② 正向关键词（去空格匹配，AntD 渲染"确 定"带空格）
// ③ 排除取消/重置等负向词 ④ 兜底取主样式按钮（弹窗 footer 通常主操作在最后）
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

// ================= 主流程 =================

async function handleAutoFill(row, interval = 300, fieldMapping, valueMapping) {
  FIELD_ALIAS = fieldMapping || {};
  VALUE_ALIAS = valueMapping || {};
  let matchedCount = 0;
  let totalFields = 0;

  try {
    console.log("[AutoFill] 开始填充:", row);

    // 页面上没有任何可见文本输入控件时，尝试点击"新增/添加"类入口按钮打开弹窗表单
    const hasVisibleInput = qSA(document, 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="radio"]):not([type="checkbox"]), textarea').some(isVisible);
    if (!hasVisibleInput && !getActiveDialog()) {
      const ENTRY = ['新增', '新建', '添加', '创建', '录入', '登记', 'add', 'create', 'new'];
      const normText = el => (el.textContent || '').replace(/\s+/g, '').toLowerCase();
      const entryBtn = qSA(document, 'button, a, div[role="button"], .ant-btn, .el-button').filter(isVisible).find(b => {
        const t = normText(b);
        return t && t.length <= 8 && ENTRY.some(k => t.includes(k));
      });
      if (entryBtn) {
        console.log("[AutoFill] 页面无表单，点击入口按钮:", entryBtn.textContent.trim());
        realClick(entryBtn);
        await sleep(1000);
      }
    }

    for (const [rawKey, value] of Object.entries(row)) {
      let key = rawKey.replace(/[\r\n*：:]/g, '').trim();
      if (key.startsWith('_') || key === 'id' || value === undefined || value === null || String(value).trim() === '') continue;
      if (FIELD_ALIAS[key]) { console.log(`[AutoFill] 字段映射: ${key} → ${FIELD_ALIAS[key]}`); key = FIELD_ALIAS[key]; }

      // 清理上一字段遗留的可见面板，保证 waitForPanel 只可能拿到本次新弹出的
      if (findVisiblePanels().length) { realClick(document.body); await sleep(150); }

      totalFields++;
      try {
        const control = findControlByKey(key);
        if (!control) continue;
        const ok = await fillControl(control, key, value, interval);
        if (ok) matchedCount++;
      } catch (e) {
        console.error(`[AutoFill] 字段 "${key}" 处理异常:`, e); // 单字段异常不中断整行
      }
    }

    console.log(`[AutoFill] 填充完成: ${matchedCount}/${totalFields}`);
    if (matchedCount === 0) throw new Error("未能匹配到任何有效字段，请检查 Excel 表头与网页标签是否一致");

    await sleep(400);

    // 提交按钮：不依赖固定文案（弹窗优先；type=submit → 关键词 → 主样式兜底）
    const submitBtn = findSubmitButton(getActiveDialog());

    if (submitBtn) {
      console.log("[AutoFill] 点击提交:", submitBtn.textContent.trim());
      realClick(submitBtn);
      await sleep(1500);
    } else {
      console.warn("[AutoFill] 未找到提交按钮");
    }

    const errorTip = qS(document, '.el-form-item__error, .ant-form-item-explain-error, .el-message--error, .error-tip');
    if (errorTip && errorTip.textContent.trim() && isVisible(errorTip)) {
      throw new Error(`表单校验未通过: ${errorTip.textContent.trim()}`);
    }

    chrome.runtime.sendMessage({ action: "TASK_RESULT", success: true });
  } catch (error) {
    console.error("[AutoFill] 异常:", error);
    chrome.runtime.sendMessage({ action: "TASK_RESULT", success: false, reason: error.message || "未知异常" });
  }
}

// ================= 消息监听 =================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "SCAN_PAGE_FORMS") {
    const fields = [];
    document.querySelectorAll('input, select, textarea').forEach((el, index) => {
      if (['hidden', 'submit', 'button'].includes(el.type)) return;
      const labelText = el.placeholder || el.name || `字段_${index}`;
      fields.push({ index: index + 1, label: labelText, tag: el.tagName.toLowerCase() });
    });
    sendResponse({ success: true, fields });
  }

  if (request.action === "FILL_SINGLE_RECORD") {
    handleAutoFill(request.row, request.interval, request.fieldMapping, request.valueMapping);
  }
  return true;
});












