﻿﻿﻿﻿﻿﻿﻿﻿﻿// 点击插件图标自动在右侧展开侧边栏
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => console.error(error));

let dataset = [];
let currentIndex = 0;
let controlState = '就绪'; // '就绪' | '执行中' | '暂停' | '等待保存'
let paused = false;        // 用户点了「暂停」：当前这条允许填完/等保存，但确认后不再自动进入下一条
let failedLogs = [];
let executionInterval = 300;
let fieldMapping = {};  // Excel表头 -> 页面label
const MIME_BG = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  zip: 'application/zip', rar: 'application/vnd.rar', txt: 'text/plain',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};
let valueMapping = {};  // Excel值 -> 页面选项值
let savePendingTab = null;   // 正在等待用户手动保存的那条记录所在的 tab
let fillTabId = null;        // 正在执行填充的 tab（暂停时向它发中断指令）
let ignoreNextResult = false; // 重置时取消等待，content 随后回报的结果要丢弃

// ---- 状态恢复：MV3 的 service worker 空闲会被回收，切换页面/离开一会儿后
// 内存里的 dataset/currentIndex/controlState/savePendingTab 都会丢，
// 表现为「已保存，下一条」点了没反应。这里启动时从 storage 恢复现场。
// 注意：只有「正在执行/正在等待保存」的批次才恢复，否则打开侧边栏会莫名出现上次残留的 Excel 数据。
const PERSIST_KEYS = ['dataset', 'currentIndex', 'controlState', 'failedLogs', 'fieldMapping', 'valueMapping', 'savePendingTab', 'stateUpdatedAt', 'paused'];
const STATE_STORAGE_KEYS = ['dataset', 'currentIndex', 'controlState', 'failedLogs', 'savePendingTab', 'stateUpdatedAt', 'paused'];
let stateLoaded = false;
const stateReady = (async () => {
  const s = await chrome.storage.local.get(PERSIST_KEYS);
  const clearState = () => chrome.storage.local.remove(STATE_STORAGE_KEYS);
  if (!s || typeof s !== 'object') return;
  const fresh = typeof s.stateUpdatedAt === 'number' && (Date.now() - s.stateUpdatedAt) < 30 * 60 * 1000;
  const waiting = s.controlState === '等待保存' && typeof s.savePendingTab === 'number';
  if (!fresh || !waiting || !Array.isArray(s.dataset) || s.dataset.length === 0) {
    // 上一轮已经结束 / 数据过期：清掉残留，保持打开时是干净的（不默认带 Excel）
    clearState();
    return;
  }
  // 只有页面里的 content 确实还在等这条保存，才认定是"后台被回收"；
  // 扩展重载/页面刷新后 content 是全新的，这里不会恢复上次残留的 Excel 数据
  const alive = await new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(s.savePendingTab, { action: 'IS_WAITING_SAVE' }, (res) => {
        resolve(!chrome.runtime.lastError && !!(res && res.waiting));
      });
    } catch (e) { resolve(false); }
  });
  if (!alive) { clearState(); return; }
  dataset = s.dataset;
  if (typeof s.currentIndex === 'number') currentIndex = s.currentIndex;
  controlState = '等待保存';
  if (Array.isArray(s.failedLogs)) failedLogs = s.failedLogs;
  if (s.fieldMapping && typeof s.fieldMapping === 'object') fieldMapping = s.fieldMapping;
  if (s.valueMapping && typeof s.valueMapping === 'object') valueMapping = s.valueMapping;
  if (typeof s.savePendingTab === 'number') savePendingTab = s.savePendingTab;
  paused = !!s.paused;
  try { broadcastUI(); } catch (e) { /* ignore */ }
})().catch(() => {}).then(() => { stateLoaded = true; });

// ================================================================
// 统一多框架主世界写入函数（注入页面 MAIN world 执行）
// 框架检测顺序：React Fiber → Vue2 __vue__ → Vue3 (dev __vueParentComponent / prod __vue_app__ 树遍历) → 原生 DOM
// 每种控件类型在每个框架下都有完整写入链路，最后兜底原生 DOM
// ================================================================
function mainWorldWrite(payload) {
  const marker = payload && payload.marker;
  const valueType = (payload && payload.valueType) || 'text';
  const rawValue = payload && payload.value == null ? '' : payload.value;
  const el = document.querySelector('[data-autofill-marker="' + marker + '"]');
  if (!el) return { ok: false, error: '未找到目标元素' };

  // ========= 专用动作（早返回，不影响现有写入链路） =========
  if (payload.action === 'scan-options') {
    // 扫下拉组件已有的 options（label + value），返回给外层做匹配判断
    // 关键：先 trigger 下拉展开，否则 Vue 递归 $children 拿不到 dropdown 的 DOM
    const openIt = (comp) => {
      try {
        if (comp && typeof comp.click === 'function') comp.click();
      } catch (e) {}
      if (el && typeof el.click === 'function') { try { el.click(); } catch (e) {} }
      // iView 内部 visible/expand
      if (comp) {
        try { comp.visible = true; } catch (e) {}
        try { comp.expand = true; } catch (e) {}
        try { comp.$emit('visible-change', true); } catch (e) {}
        try { comp.$emit('update:visible', true); } catch (e) {}
      }
    };
    const findSelectComp = (root, targetEl) => {
      let c = root;
      while (c) {
        const isComp = c.$options && /select/i.test(c.$options.name || '');
        const elMatch = c.$el === targetEl;
        // 必须精确匹配到当前 DOM 元素对应的 Select 组件，不能碰页面上第一个
        if (isComp && elMatch) return c;
        c = c.$parent; if (!c) break;
      }
      // 找不到精确匹配的，放宽：$el 是 targetEl 子节点也行（有时 __vue__ 挂在内部节点）
      c = root;
      while (c) {
        const isComp = c.$options && /select/i.test(c.$options.name || '');
        if (isComp && targetEl.contains && targetEl.contains(c.$el)) return c;
        c = c.$parent; if (!c) break;
      }
      if (!c && el.__vue_app__) {
        const inst = el.__vue_app__._instance;
        const walk3 = (v, depth) => {
          if (!v || depth > 20) return null;
          if (v.proxy) {
            if (v.proxy.$el === targetEl) return v.proxy;
          }
          const r = v.subTree && walk3(v.subTree, depth + 1); if (r) return r;
          const r2 = v.component && walk3(v.component.subTree, depth + 1); if (r2) return r2;
          return null;
        };
        c = walk3(inst && inst.subTree, 0);
      }
      return c;
    };
    const comp = findSelectComp(el.__vue__, el) || el.__vue__;
    // 先展开下拉（Vue comp）
    openIt(comp);
    // 原生 DOM click（React/AntD 兜底）
    try {
      const trigger = el.querySelector('.ivu-select-selection, .el-select__wrapper, .ant-select-selector, .ant-select-selection-search') || el;
      trigger.click();
    } catch (e) {}

    const walk = (v, depth, out) => {
      if (!v || depth > 15) return;
      (v.$children || []).forEach(c => {
        const n = (c.$options && c.$options.name) || '';
        const cls = (c.$el && typeof c.$el.className === 'string') ? c.$el.className : '';
        if (/option/i.test(n) || /ivu-select-item|el-select-dropdown__item/.test(cls)) {
          const l = c.label;
          const label = (l !== undefined && l !== null) ? String(l) : (c.$el ? String(c.$el.textContent || '').trim() : '');
          if (label) out.push({ label, value: c.value !== undefined ? c.value : label });
        }
        walk(c, depth + 1, out);
      });
    };
    const out = [];
    // 最优先：直接从 props.options 读 —— 组件原始数据源就是 [{label, value}] 键值对
    // iView/Element Plus/AntD Vue 都用这个 prop 传 options
    const _tryExtractOptionsFromProps = (inst) => {
      if (!inst) return false;
      const tryArrays = [
        inst.props && inst.props.options,
        inst.props && inst.props.optionsList,
        inst.props && inst.props.data,
        inst.options,
        inst.optionsList,
        inst.$props && inst.$props.options,
      ];
      for (const arr of tryArrays) {
        if (Array.isArray(arr) && arr.length) {
          arr.forEach(item => {
            if (item == null) return;
            if (typeof item === 'string') {
              out.push({ label: item, value: item });
            } else if (typeof item === 'object') {
              // iView / AntDVue / Element Plus / AntDVue Select 的标准键
              const lbl = item.label ?? item.name ?? item.text ?? item.dictLabel ?? item.displayName;
              const val = item.value ?? item.key ?? item.id ?? item.dictValue;
              if (lbl !== undefined && lbl !== null) {
                out.push({ label: String(lbl), value: val !== undefined ? val : lbl });
              }
            }
          });
          if (out.length) return true;
        }
      }
      return false;
    };
    // 找 Select 组件实例来读 props.options
    const findComp = (root) => {
      let c = root;
      while (c && !(c.$options && /select/i.test(c.$options.name || '')) && !/ivu-select(?!-item)|el-select(?!-)/.test((c.$el && c.$el.className) || '')) {
        c = c.$parent; if (!c) break;
      }
      if (!c && el.__vue_app__) {
        const inst = el.__vue_app__._instance;
        const walk3 = (v, depth) => {
          if (!v || depth > 20) return null;
          if (v.proxy) {
            const cls = v.proxy.$el && v.proxy.$el.className || '';
            if (/ivu-select(?!-item)|el-select(?!-)/.test(cls)) return v.proxy;
          }
          const r = v.subTree && walk3(v.subTree, depth + 1); if (r) return r;
          const r2 = v.component && walk3(v.component.subTree, depth + 1); if (r2) return r2;
          return null;
        };
        c = walk3(inst && inst.subTree, 0);
      }
      return c;
    };
    const compForOptions = findComp(el.__vue__);
    _tryExtractOptionsFromProps(compForOptions);
    if (!out.length && compForOptions) walk(compForOptions, 0, out);
    if (!out.length && compForOptions && compForOptions.$parent) walk(compForOptions.$parent, 0, out);
    // React/AntD 兜底：直接读 DOM dropdown（已经展开）
    document.querySelectorAll('.ant-select-item, .ivu-select-item, .el-select-dropdown__item, .ant-select-item-option-content').forEach(n => {
      if (n.textContent && n.getAttribute('aria-disabled') !== 'true') {
        const txt = n.textContent.trim();
        // 避免重复：同一下拉里可能同时有 wrapper 和 inner
        if (out.length === 0 || !out.some(o => o.label === txt)) {
          out.push({ label: txt, value: txt });
        }
      }
    });
    // 没展开成功？最后尝试一下 focus + arrowDown 触发
    if (!out.length) {
      const input = el.querySelector('input');
      if (input) {
        try { input.focus(); } catch (e) {}
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', code: 'ArrowDown' }));
        document.querySelectorAll('.ant-select-item, .ivu-select-item, .el-select-dropdown__item').forEach(n => {
          if (n.textContent && n.getAttribute('aria-disabled') !== 'true') out.push({ label: n.textContent.trim(), value: n.textContent.trim() });
        });
      }
    }
    return { ok: true, action: 'scan-options', options: out };
  }

  if (payload.action === 'select-or-create') {
    // 匹配或新增下拉选项：先尝试从现有 options 找匹配，找不到则触发搜索新增
    const target = String(payload.value || '').trim();
    const scanRes = mainWorldWrite(Object.assign({}, payload, { action: 'scan-options', value: '' }));
    const options = (scanRes && scanRes.options) || [];
    const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '');
    const t = norm(target);
    const hit = options.find(o => norm(o.label) === t)
      || options.find(o => t.length >= 2 && norm(o.label).indexOf(t) >= 0)
      || options.find(o => norm(o.label).length >= 2 && t.indexOf(norm(o.label)) >= 0);
    if (hit) {
      // 已有匹配项：按现有 select 写入逻辑走一遍
      const r = mainWorldWrite(Object.assign({}, payload, { action: null, valueType: 'select', value: hit.value }));
      return Object.assign({}, r, { action: 'select-or-create', matched: true, option: hit });
    }
    // 没匹配到：触发搜索新增（filterable + allowCreate 模式）
    // 方式：展开下拉 → 往内部 input 打字 → 等面板 → 找"点击创建"选项 → 点击
    const openSelect = () => {
      const trigger = el.querySelector('.ivu-select-selection, .el-select, .ant-select-selector') || el;
      try { trigger.click(); } catch (e) { /* ignore */ }
      if (el.__vue__) { try { el.__vue__.$emit('visible-change', true); } catch (e) { /* ignore */ } }
    };
    openSelect();
    // 主世界同步打字：找内部 input
    const input = el.querySelector('input');
    if (input) {
      try { input.focus(); } catch (e) {}
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, target); else input.value = target;
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: target }));
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
    }
    // 找"点击创建/新建"类选项
    const creatable = document.querySelector('.ivu-select-item-notfound, .el-select-dropdown__item[title*="创建"], .ant-select-item-option[title*="创建"], .ant-select-dropdown-empty');
    if (creatable) { try { creatable.click(); } catch (e) {} }
    // 再 trigger 一次 change
    if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, action: 'select-or-create', matched: false, created: true, tried: target };
  }

  const diag = { frameworks: {} };

  // ---- 工具 ----
  const qS = (scope, sel) => { try { return scope.querySelector(sel); } catch (e) { return null; } };
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '').replace(/[~～－—–―]/g, '-');
  // 下拉选项文本 → 数值区间（统一换算到"年"）：3~5年→[3,5]、1年以下→[-∞,1)、10年以上→[10,+∞)、6~12月→[0.5,1]
  const parseOptionRange = (lbl) => {
    const t = String(lbl == null ? '' : lbl).replace(/\s+/g, '');
    const unit = /月|month/i.test(t) ? 1 / 12 : (/天|日|day/i.test(t) ? 1 / 365 : 1);
    const mRange = t.match(/(\d+(?:\.\d+)?)[~～\-—–―至到、](\d+(?:\.\d+)?)/);
    if (mRange) return { low: parseFloat(mRange[1]) * unit, high: parseFloat(mRange[2]) * unit };
    const mAbove = t.match(/(\d+(?:\.\d+)?)(?:年|岁|天|月)(?:以上|及以上|或以上|\+)/);
    if (mAbove) return { low: parseFloat(mAbove[1]) * unit, high: Infinity };
    const mBelow = t.match(/(\d+(?:\.\d+)?)(?:年|岁|天|月)(?:以下|及以下)/);
    if (mBelow) return { low: -Infinity, high: parseFloat(mBelow[1]) * unit };
    const mUnder = t.match(/^(?:小于|少于|<|≤|≦)(\d+(?:\.\d+)?)/);
    if (mUnder) return { low: -Infinity, high: parseFloat(mUnder[1]) * unit };
    return null;
  };
  // 用户值 → 年数：4年→4、6个月→0.5、18个月→1.5、1年6个月→1.5、90天→0.25、10month→0.83
  const parseValueYears = (v) => {
    const t = String(v == null ? '' : v).replace(/\s+/g, '');
    const mCompound = t.match(/(\d+(?:\.\d+)?)(?:年|岁|years?)(?:(\d+(?:\.\d+)?)(?:个月|月|months?))?/i);
    if (mCompound) return parseFloat(mCompound[1]) + (mCompound[2] ? parseFloat(mCompound[2]) / 12 : 0);
    const mMonths = t.match(/(\d+(?:\.\d+)?)(?:个月|月|months?)/i);
    if (mMonths) return parseFloat(mMonths[1]) / 12;
    const mDays = t.match(/(\d+(?:\.\d+)?)(?:天|日|days?)/i);
    if (mDays) return parseFloat(mDays[1]) / 365;
    const m = t.match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };
  const buildObj = (name, val) => {
    if (!Array.isArray(name)) return { [name]: val };
    const root = {}; let cur = root;
    for (let i = 0; i < name.length - 1; i++) { cur[name[i]] = {}; cur = cur[name[i]]; }
    cur[name[name.length - 1]] = val;
    return root;
  };
  const buildFileList = (payload, kind) => (payload.files || []).map((f, i) => {
    if (kind === 'ivu') return { name: f.name, size: f.size || 0, status: 'finished', percentage: 100, uid: Date.now() + i, showProgress: false, response: {} };
    if (kind === 'el') return { name: f.name, uid: Date.now() + i, status: 'success', size: f.size || 0, type: f.type || '', url: f.url || '' };
    return { uid: 'rc-upload-' + Date.now() + '-' + i, name: f.name, status: 'done', url: f.url || '', percent: 100, size: f.size || 1024, type: f.type || '' };
  });
  // React(AntD) 日期必须写 dayjs/moment 对象，不能直接发 Date
  const makeReactDate = (gen) => {
    const m = String(rawValue).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m || !gen || typeof gen.getNow !== 'function' || typeof gen.set !== 'function') return null;
    try {
      let d = gen.getNow();
      d = gen.set(d, 'year', Number(m[1]));
      d = gen.set(d, 'month', Number(m[2]) - 1);
      d = gen.set(d, 'date', Number(m[3]));
      try { d = gen.set(d, 'hour', 0); d = gen.set(d, 'minute', 0); d = gen.set(d, 'second', 0); } catch (e) {}
      if (typeof gen.isValidate === 'function' && !gen.isValidate(d)) return null;
      return d;
    } catch (e) { return null; }
  };

  // =============== 框架 1: React (AntD) — 全控件覆盖 ===============
  const fk = Object.getOwnPropertyNames(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  if (fk) {
    let fiber = el[fk], hops = 0, fieldName = null, form = null, onChangeFn = null, gen = null, fileList = null;
    while (fiber && hops < 120) {
      const p = fiber.memoizedProps || {};
      if (!fieldName && p.name != null) {
        if (typeof p.name === 'string' && p.name) fieldName = p.name;
        else if (Array.isArray(p.name) && p.name.length && p.name.every(x => typeof x === 'string')) fieldName = p.name;
      }
      if (!form && p.form && typeof p.form.setFieldsValue === 'function') form = p.form;
      if (!onChangeFn && typeof p.onChange === 'function') onChangeFn = p.onChange;
      if (!gen && p.generateConfig && typeof p.generateConfig.getNow === 'function') gen = p.generateConfig;
      if (!fileList && Array.isArray(p.fileList)) fileList = p.fileList;
      fiber = fiber.return; hops++;
    }
    diag.frameworks.react = { hops, fieldName, hasForm: !!form };

    let v = rawValue;
    if (valueType === 'date') v = makeReactDate(gen);
    else if (valueType === 'file') v = buildFileList(payload, 'rc');
    else if (valueType === 'select' && typeof rawValue === 'string' && rawValue.includes(',')) v = rawValue.split(',').map(s => s.trim()).filter(Boolean);

    if (v != null && v !== '') {
      // 1a. Form Store 直写（最可靠）
      if (form && fieldName) {
        try {
          if (typeof form.setFieldValue === 'function') form.setFieldValue(fieldName, v);
          else form.setFieldsValue(buildObj(fieldName, v));
          try { form.validateFields([fieldName]).catch(() => {}); } catch (e2) {}
          return { ok: true, via: 'react-form', fieldName: JSON.stringify(fieldName), diag };
        } catch (e) { diag.reactFormError = e.message; }
      }
      // 1b. 直接调组件 onChange
      if (onChangeFn) {
        try { onChangeFn(v); return { ok: true, via: 'react-onChange', diag }; }
        catch (e) { diag.reactOnChangeError = e.message; }
      }
    }
  } else {
    diag.frameworks.react = 'no fiber';
  }

  // =============== 框架 2: Vue2 (iView / Element UI) — 全控件覆盖 ===============
  let vm2 = null;
  try {
    let node = el;
    while (node) { if (node.__vue__) { vm2 = node.__vue__; break; } node = node.parentElement; }
  } catch (e) { /* ignore */ }

  if (vm2) {
    const nameOf2 = (c) => String((c && c.$options && (c.$options.name || c.$options._componentTag)) || '');
    const clsOf2 = (c) => (c && c.$el && typeof c.$el.className === 'string') ? c.$el.className : '';
    // 生产构建组件 name 被 minify 成空串，name 匹配失效时必须靠 DOM class + 组件特征兜底
    const isUpload2 = (c) => /upload/i.test(nameOf2(c))
      || /ivu-upload|el-upload/.test(clsOf2(c))
      || (c && Array.isArray(c.fileList))
      || (c && c.$props && ('action' in c.$props || 'accept' in c.$props || 'beforeUpload' in c.$props));
    const isSelect2 = (c) => (/select/i.test(nameOf2(c)) && !/option/i.test(nameOf2(c)))
      || /ivu-select(?!-item)|el-select(?!-)/.test(clsOf2(c));
    const isDate2 = (c) => (/date|time/i.test(nameOf2(c)) && !/option/i.test(nameOf2(c)))
      || /ivu-date|ivu-time|el-date|el-time/.test(clsOf2(c));
    let comp = vm2, hops2 = 0;
    // 向上找目标控件（Select/Upload/DatePicker 等）
    if (valueType === 'select') {
      while (comp && hops2 < 20) {
        if (isSelect2(comp)) break;
        comp = comp.$parent; hops2++;
      }
    } else if (valueType === 'file') {
      while (comp && hops2 < 20) {
        if (isUpload2(comp)) break;
        comp = comp.$parent; hops2++;
      }
    } else if (valueType === 'date' || valueType === 'time') {
      while (comp && hops2 < 20) {
        if (isDate2(comp)) break;
        comp = comp.$parent; hops2++;
      }
    }
    if (!comp) comp = vm2;
    diag.frameworks.vue2 = { compName: nameOf2(comp), hops: hops2, elClass: clsOf2(comp).slice(0, 80) };

    // 注意：不要改 comp._props.disabled / comp.disabled。
    // 禁用只是"用户不能点"，v-model 写入并不受它限制；
    // 直接改 prop 反而会让页面上的禁用控件「自动解开」，引起框架重新渲染。
    try { if (comp._props && 'disabled' in comp._props) diag.vue2Disabled = true; } catch (e) {}

    try {
      if (valueType === 'select') {
        // 递归遍历子组件找 option
        const options = [];
        const walk = (v, depth) => {
          if (!v || depth > 15) return;
          (v.$children || []).forEach(c => {
            const n = nameOf2(c);
            const cls = (c.$el && typeof c.$el.className === 'string') ? c.$el.className : '';
            if (/option/i.test(n) || cls.indexOf('ivu-select-item') >= 0 || cls.indexOf('el-select-dropdown__item') >= 0) options.push(c);
            walk(c, depth + 1);
          });
        };
        walk(comp, 0);
        if (!options.length) {
          let root = comp; while (root.$parent) root = root.$parent;
          walk(root, 0);
        }
        const labelOf = (c) => {
          let l = c.label;
          if (l === undefined || l === null) l = c.$el ? c.$el.textContent : '';
          return String(l || '').trim();
        };
        const t = norm(rawValue);
        let match = options.find(c => norm(labelOf(c)) === t)
          || options.find(c => { const l = norm(labelOf(c)); return t.length >= 2 && l.indexOf(t) >= 0; })
          || options.find(c => { const l = norm(labelOf(c)); return l.length >= 2 && t.indexOf(l) >= 0; });
        // 生产环境 Vue2 的「工作年限」选项是区间型（1年以下 / 1-3年 / 3-5年 / 5-10年 / 10年以上），
        // 粘贴值「4年」永远不可能与文本相等或包含，必须做数值 → 区间命中
        if (!match) {
          const years = parseValueYears(rawValue);
          if (years !== null) {
            const hit = options.find(c => {
              const iv = parseOptionRange(labelOf(c));
              return iv && years >= iv.low - 1e-6 && years <= iv.high + 1e-6;
            });
            if (hit) {
              match = hit;
              diag.vue2SelectByNumber = { value: rawValue, years, label: labelOf(hit) };
            }
          }
        }
        if (!match) { diag.vue2Select = '未找到选项: ' + rawValue; }
        else {
          const optVal = (match.value !== undefined && match.value !== null) ? match.value : labelOf(match);
          const curVal = comp.value !== undefined ? comp.value : (comp._props ? comp._props.value : undefined);
          const already = norm(curVal) !== '' && norm(curVal) === norm(optVal);
          let via = '';
          if (already) {
            // 已经是这个值：不要再 emit 任何事件。
            // 页面通常会在证件类型等下拉的 change 里联动其它字段（清理/回写/校验），
            // 重复粘贴时再触发一次，就会出现"身份证号被写了两三遍"这类副作用。
            via = 'already-selected';
          } else {
            // 关键：Vue2 表单校验看的是父级 model，而不是 Select 的内部显示值。
            // option.select() 走的是 iView 内部 on-select，遇到「:value + @on-change」或包装组件的用法时
            // 只更新显示、不更新 model，于是界面上有值、校验仍报「请选择」。
            // 所以这里主动 emit input/on-change（v-model 和 @on-change 两种绑定都能更新）。
            // 不再额外调 option.select()，避免和 emit 一起把页面的联动逻辑触发两遍。
            try { comp.$emit('input', optVal); via = 'emit-input'; } catch (e) {}
            try { comp.$emit('on-change', optVal); } catch (e) {}
            try { if (comp._props && 'value' in comp._props) comp._props.value = optVal; } catch (e) {}
            try { if ('visible' in comp) comp.visible = false; } catch (e) {}
          }
          if (via) return { ok: true, via: 'vue2-select-' + via, diag };
        }
      } else if (valueType === 'file') {
        // Vue2 iView Upload: fileList + on-success + on-change
        // 只有确认 comp 真的是 Upload 组件才写入，否则落到后续兜底，避免"假成功"
        const kind = /ivu/i.test(el.className || clsOf2(comp) || '') ? 'ivu' : 'el';
        const realUpload = Array.isArray(comp.fileList)
          || (comp.$props && ('action' in comp.$props || 'accept' in comp.$props || 'beforeUpload' in comp.$props))
          || /ivu-upload|el-upload/.test(clsOf2(comp));
        diag.vue2UploadReal = realUpload;
        if (!realUpload) {
          diag.frameworks.vue2 = Object.assign(diag.frameworks.vue2 || {}, {
            uploadFail: '未定位到 Upload 组件',
            compName: nameOf2(comp), hops: hops2, elClass: clsOf2(comp).slice(0, 80)
          });
        } else {
          const ours = buildFileList(payload, kind);
          const cur = Array.isArray(comp.fileList) ? comp.fileList : [];
          const missing = ours.filter(o => !cur.some(c => c && c.name === o.name));
          const merged = cur.concat(missing);
          try { comp.fileList = merged; } catch (e3) { diag.vue2FileListWrite = e3.message; }
          const last = ours[ours.length - 1] || merged[merged.length - 1] || null;
          try { comp.$emit('on-success', {}, last, merged); } catch (e) {}
          try { comp.$emit('on-change', last, merged); } catch (e) {}
          try { comp.$emit('change', last, merged); } catch (e) {}
          return { ok: true, via: 'vue2-' + kind + '-upload', count: ours.length, diag };
        }
      } else if (valueType === 'date' || valueType === 'time') {
        // Vue2 DatePicker v-model 用字符串
        comp.$emit('input', rawValue);
        comp.$emit('change', rawValue);
        try { if (comp._props && 'value' in comp._props) comp._props.value = rawValue; } catch (e) {}
        return { ok: true, via: 'vue2-date', diag };
      } else {
        // text / number / radio / checkbox 等：v-model 直写
        comp.$emit('input', rawValue);
        try { comp.$emit('change', rawValue); } catch (e) {}
        try { comp.$emit('update:modelValue', rawValue); } catch (e) {}
        try { if (comp._props && 'value' in comp._props) comp._props.value = rawValue; } catch (e) {}
        return { ok: true, via: 'vue2-input', diag };
      }
    } catch (e) { diag.vue2Error = e.message; }
  } else {
    diag.frameworks.vue2 = 'no __vue__';
  }

  // =============== 框架 3: Vue3 (Element Plus / ViewUIPlus) — 全控件覆盖 ===============
  const propsOf = (i) => i.props || {};
  const nameOf3 = (i) => String((i.type && (i.type.name || i.type.__name)) || '');
  const pad2 = (n) => String(n).padStart(2, '0');

  // ---- 3a. 构建 Vue3 组件链（dev: __vueParentComponent ； prod: __vue_app__ 树遍历）----
  const chain3 = [];
  let inst = el.__vueParentComponent;
  while (inst && chain3.length < 30) { chain3.push(inst); inst = inst.parent; }

  if (!chain3.length) {
    // 生产构建：__vue_app__ 仍暴露（挂载容器 DOM 元素上），但 __vueParentComponent 不可用
    let app3 = null, node3 = el;
    while (node3) { if (node3.__vue_app__) { app3 = node3.__vue_app__; break; } node3 = node3.parentElement; }
    if (!app3 && document.body) {
      const q = [document.body];
      while (q.length && !app3) {
        const n = q.shift();
        if (n.__vue_app__) { app3 = n.__vue_app__; break; }
        for (const c of (n.children || [])) q.push(c);
      }
    }
    const root = app3 && app3._instance;
    if (root) {
      // 组件 { proxy, depth }，proxy.$el 包含 el 即为命中
      const hits = [];
      const walk = (vnode, depth) => {
        if (!vnode || depth > 80 || hits.length > 60) return;
        const c = vnode.component;
        if (c && c.proxy) {
          const ce = c.proxy.$el;
          if (ce && ce.nodeType === 1 && (ce === el || (ce.contains && ce.contains(el)))) {
            hits.push({ comp: c, depth });
          }
          walk(c.subTree, depth + 1);
          return;
        }
        const kids = vnode.children;
        if (Array.isArray(kids)) kids.forEach(k => walk(k, depth + 1));
      };
      // Vue3 根实例的 vnode 可能在多处，依次尝试直到有 hit
      for (const entry of [root.subTree, root.vnode, root.proxy && root.proxy.$.vnode]) {
        if (entry) walk(entry, 0);
        if (hits.length) break;
      }
      // 浅（外层）→深（内层）排序，与 __vueParentComponent 链顺序一致
      hits.sort((a, b) => a.depth - b.depth);
      hits.forEach(h => chain3.push(h.comp));
      diag.frameworks.vue3 = { treeWalk: hits.length, rootHasSubTree: !!root.subTree, rootHasVnode: !!root.vnode };
    } else {
      diag.frameworks.vue3 = 'no __vue_app__';
    }
  } else {
    diag.frameworks.vue3 = { dev: true, chainLen: chain3.length };
  }

  if (chain3.length) {
    // 内层优先查找（chain3 是外层→内层排序，反向遍历就是内层优先）
    const findInner = (pred) => { for (let i = chain3.length - 1; i >= 0; i--) if (pred(chain3[i])) return chain3[i]; return null; };
    const findOuter = (pred) => chain3.find(pred); // 外层优先（FormItem/Form）
    const isIview = !!(el.closest && el.closest('.ivu-upload, .ivu-date-picker, .ivu-time-picker, .ivu-select, .ivu-form-item'));

    // 通过 FormItem 实例重置校验状态（替代 content script 删 DOM 节点，避免 Vue patch 崩溃）
    const syncFormState = (modelValue, writeModel) => {
      const out = {};
      const fi = findOuter(i => propsOf(i).prop && /form.?item/i.test(nameOf3(i)));
      if (fi && fi.proxy) {
        try { fi.proxy.validateState = 'success'; } catch (e) {}
        try { fi.proxy.validateMessage = ''; } catch (e) {}
        out.formItem = String(propsOf(fi).prop || '');
      }
      if (writeModel && fi && propsOf(fi).prop) {
        const form = findOuter(i => propsOf(i).model && typeof propsOf(i).model === 'object');
        if (form) {
          try { propsOf(form).model[propsOf(fi).prop] = modelValue; out.modelWrite = true; }
          catch (e) { out.modelWrite = e.message; }
        }
      }
      return out;
    };

    // ---- 控件类型分支 ----
    if (valueType === 'file') {
      // 生产构建组件 name 被 minify 成空串，不能依赖 nameOf3；改用 props 特征 + proxy 内部状态识别
      const isUploadComp = (i) => {
        const pr = propsOf(i);
        // 1. iView/ViewUIPlus Upload: proxy.fileList 内部数组 / props.action / props.accept / props.beforeUpload
        // 2. Element Plus el-upload: props.fileList / props.action / props.before-upload
        return (i.proxy && Array.isArray(i.proxy.fileList))
          || 'fileList' in pr
          || 'action' in pr
          || 'accept' in pr
          || 'beforeUpload' in pr
          || 'before-upload' in pr;
      };
      let up = findInner(isUploadComp);
      if (!up) {
        // 终极兜底：找 proxy.$el 包含 input[type=file] 的最内层组件
        const hasFileInput = (i) => i.proxy && i.proxy.$el && i.proxy.$el.nodeType === 1
          && (i.proxy.$el.tagName === 'INPUT' || qS(i.proxy.$el, 'input[type="file"]'));
        up = findInner(hasFileInput);
      }
      if (up) {
        diag.vue3UploadFound = { inst: nameOf3(up), props: Object.keys(propsOf(up)).slice(0, 8), hasProxyFileList: !!(up.proxy && Array.isArray(up.proxy.fileList)) };
        const ours = buildFileList(payload, isIview ? 'ivu' : 'el');
        let merged;
        if (isIview && up.proxy) {
          const cur = Array.isArray(up.proxy.fileList) ? up.proxy.fileList : [];
          const missing = ours.filter(o => !cur.some(c => c && c.name === o.name));
          merged = cur.concat(missing);
          try { up.proxy.fileList = merged; } catch (e3) { diag.vue3FileList = e3.message; }
          const last = ours[ours.length - 1] || merged[merged.length - 1] || null;
          // emit + 直接调 prop 回调双保险（ViewUIPlus Upload 的 on-success/on-change 是 prop 函数，
          // 部分场景下 emit('on-success') 不会触发外部 :on-success 绑定）
          try { up.emit('on-success', {}, last, merged); } catch (e) {}
          try { up.emit('on-change', last, merged); } catch (e) {}
          const pr = propsOf(up);
          if (typeof pr.onSuccess === 'function') try { pr.onSuccess({}, last, merged); } catch (e) { diag.vue3PropOnSuccess = e.message; }
          if (typeof pr.onChange === 'function') try { pr.onChange(last, merged); } catch (e) { diag.vue3PropOnChange = e.message; }
        } else {
          const cur = Array.isArray(propsOf(up).fileList) ? propsOf(up).fileList : [];
          const missing = ours.filter(o => !cur.some(c => c && c.name === o.name));
          merged = cur.concat(missing);
          try { up.emit('update:file-list', merged); } catch (e) { diag.vue3EmitFileList = e.message; }
          try { up.emit('change', ours[ours.length - 1] || merged[merged.length - 1] || null, merged); } catch (e) {}
          const pr = propsOf(up);
          if (typeof pr['on-success'] === 'function') try { pr['on-success'](ours[ours.length - 1], merged); } catch (e) {}
          if (typeof pr['on-change'] === 'function') try { pr['on-change'](ours[ours.length - 1], merged); } catch (e) {}
        }
        Object.assign(diag, syncFormState(merged, true));
        return { ok: true, via: 'vue3-' + (isIview ? 'ivu' : 'el') + '-upload', count: ours.length, diag };
      }
      diag.vue3Upload = '未找到 Upload 实例（chain3.len=' + chain3.length + ' isIview=' + isIview + '）';
      diag.vue3UploadChain = chain3.map(i => ({ name: nameOf3(i), hasProxyFileList: !!(i.proxy && Array.isArray(i.proxy.fileList)), keys: Object.keys(propsOf(i)).slice(0, 5) }));
    } else if (valueType === 'date' || valueType === 'time') {
      // 生产构建组件 name 被 minify，改用 DOM class + props 特征确定库类型与值格式
      const isEl = !!(el.closest && el.closest('.el-date-editor, .el-date-picker, .el-time-picker'));
      const pd = String(rawValue).match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
      const pt = String(rawValue).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      // 找最内层带 modelValue 的日期/时间组件（同样不依赖 name，用 props 特征）
      const picker = findInner(i => {
        const pr = propsOf(i);
        // 典型日期/时间组件 props：valueFormat / placeholder / type
        return ('valueFormat' in pr) || ('placeholder' in pr && 'format' in pr)
          || ('type' in pr && 'placeholder' in pr && 'clearable' in pr)
          || (i.proxy && i.proxy.$el && qS(i.proxy.$el, 'input'));
      });
      const vf = picker && typeof propsOf(picker).valueFormat === 'string' ? propsOf(picker).valueFormat : '';
      const fmtBy = (y, mo, d, h, mi, s) => {
        if (vf === 'x' || vf === 'X') { const t = new Date(y, mo - 1, d, h, mi, s).getTime(); return vf === 'x' ? t : Math.floor(t / 1000); }
        return vf.replace(/YYYY/g, String(y)).replace(/YY/g, String(y).slice(-2))
          .replace(/MM/g, pad2(mo)).replace(/DD/g, pad2(d))
          .replace(/HH/g, pad2(h)).replace(/mm/g, pad2(mi)).replace(/ss/g, pad2(s));
      };
      let v = rawValue;
      if (pd && valueType === 'date') {
        const y = +pd[1], mo = +pd[2], d = +pd[3], h = +(pd[4] || 0), mi = +(pd[5] || 0), s = +(pd[6] || 0);
        if (isIview) v = rawValue; // iView DatePicker 原生接受字符串
        else if (vf) v = fmtBy(y, mo, d, h, mi, s); // 有 value-format，按它来
        else if (isEl) v = new Date(y, mo - 1, d, h, mi, s); // ElDatePicker 无 value-format 必须发 Date
        else v = rawValue;
      } else if (pt && valueType === 'time') {
        const h = +pt[1], mi = +pt[2], s = +(pt[3] || 0);
        if (isIview) v = rawValue;
        else if (vf) { const n = new Date(); v = fmtBy(n.getFullYear(), n.getMonth() + 1, n.getDate(), h, mi, s); }
        else if (isEl) v = new Date(new Date().setHours(h, mi, s, 0));
        else v = rawValue;
      }
      const modelInst = findInner(i => 'modelValue' in propsOf(i) && typeof i.emit === 'function');
      if (modelInst) {
        modelInst.emit('update:modelValue', v);
        try { modelInst.emit('change', v); } catch (e2) {}
        if (isIview) try { modelInst.emit('on-change', rawValue); } catch (e2) {}
        diag.vue3Date = { isIview, isEl, hasValueFormat: !!vf };
        Object.assign(diag, syncFormState(v, false));
        return { ok: true, via: 'vue3-modelValue', diag };
      }
      diag.vue3 = '未找到带 modelValue 的日期组件';
    } else if (valueType === 'select') {
      const modelInst = findInner(i => 'modelValue' in propsOf(i) && typeof i.emit === 'function');
      const compForEmit = modelInst ? modelInst.proxy : null;
      console.log('[AutoFill-DBG] MAIN_WORLD_SET select 入口', { rawValue, hasModelInst: !!modelInst });

      // 关键改进：不调 scan-options（它会打开面板干扰状态），自己找正确的组件读 props.options
      // 从 modelInst 的 $el 往上找（modelInst.$el 就是当前 select 的 DOM）
      let writeValue = rawValue;
      try {
        // 找 props.options：modelInst.proxy 就是组件实例，往上爬找带 options prop 的
        let scanComp = modelInst ? modelInst : null;
        if (!scanComp && el.__vue__) scanComp = el.__vue__;
        while (scanComp && scanComp.$parent &&
               !(scanComp.props && (scanComp.props.options || scanComp.props.optionsList)) &&
               !(scanComp.options || scanComp.optionsList)) {
          scanComp = scanComp.$parent;
        }
        // 收集 options
        const _extractOpts = (inst) => {
          if (!inst) return [];
          const arr = (inst.props && (inst.props.options || inst.props.optionsList || inst.props.data)) ||
                      inst.options || inst.optionsList ||
                      (inst.$props && inst.$props.options) || [];
          if (!Array.isArray(arr)) return [];
          return arr.map(item => {
            if (typeof item === 'string') return { label: item, value: item };
            if (!item || typeof item !== 'object') return null;
            const lbl = item.label ?? item.name ?? item.text ?? item.dictLabel ?? item.displayName;
            const val = item.value ?? item.key ?? item.id ?? item.dictValue;
            if (lbl === undefined || lbl === null) return null;
            return { label: String(lbl), value: val !== undefined && val !== null ? val : lbl };
          }).filter(Boolean);
        };
        let options = _extractOpts(scanComp);
        // 如果 scanComp 不对，从 compForEmit 再找一遍
        if (!options.length && compForEmit) options = _extractOpts(compForEmit);
        console.log('[AutoFill-DBG] props.options 提取', { count: options.length, sample: options.slice(0, 3), compName: scanComp && scanComp.$options && scanComp.$options.name });

        // 关键决策：如果 props.options 提取不到（view-ui-plus 等组件的 options 经常不在 Vue prop 链上），
        // 那我们根本不知道正确的 option.value 是什么，emit label 过去会变成「modelValue != option.value → 显示空白」。
        // 这种情况下直接返回 ok=false，让 content.js 走 openPanel + realClick DOM 兜底 —— DOM 点击是 100% 可靠的。
        if (!options.length) {
          console.log('[AutoFill-DBG] options 提取不到，跳过 emit 直接走 DOM 兜底');
          diag.vue3Select = 'options-not-found';
          return { ok: false, via: 'vue3-select-no-options', diag };
        }

        if (options.length) {
          // ===== 中文数字 → 阿拉伯（让「一个月」「半年」「三年零两个月」也能走数值匹配）=====
          const _cnToArabic = (val) => {
            let s = String(val == null ? '' : val).replace(/\s+/g, '');
            const CN = '零〇一壹二贰两俩三叁四肆五伍六陆七柒八捌九玖';
            const dMap = {'一':'1','壹':'1','二':'2','贰':'2','两':'2','俩':'2','三':'3','叁':'3','四':'4','肆':'4','五':'5','伍':'5','六':'6','陆':'6','七':'7','柒':'7','八':'8','捌':'8','九':'9','玖':'9'};
            // 组合式 X十Y / 十Y / X十
            s = s.replace(new RegExp(`([${CN}]+)[十拾]([${CN}])`, 'g'), (m, a, b) => {
              const aa = dMap[a] || a; const bb = dMap[b] || b;
              return String((parseInt(aa,10)||0)*10 + (parseInt(bb,10)||0));
            });
            s = s.replace(new RegExp(`[十拾]([${CN}])`, 'g'), (m, b) => String(10 + (parseInt(dMap[b]||b,10)||0)));
            s = s.replace(new RegExp(`([${CN}])[十拾]`, 'g'), (m, a) => String((parseInt(dMap[a]||a,10)||0)*10));
            s = s.replace(/[十拾]/g, '10');
            for (const [k, v] of Object.entries(dMap)) s = s.split(k).join(v);
            // 连接词「零」处理（必须在数字替换之后）
            s = s.replace(/(\d)年零(\d)/g, '$1年$2');
            s = s.replace(/(\d)个月?零(\d)/g, '$1个月$2');
            s = s.replace(/[零〇]/g, '');
            // 「半」处理
            s = s.replace(/(\d+(?:\.\d+)?)年半/g, '$1.5年');
            s = s.replace(/(\d+(?:\.\d+)?)个月?半/g, '$1.5个月');
            s = s.replace(/^半(?=(年|岁|个月?|天))/, '0.5');
            // 单位清理
            s = s.replace(/([0-9.])个(?=[月年天岁])/g, '$1');
            s = s.replace(/[个]+/g, '');
            s = s.replace(/[多多余约约将近大概大约至少以上左右来]/g, '');
            return s;
          };
          const rawNorm = _cnToArabic(rawValue); // 归一化后的值（阿拉伯数字）

          const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '');
          const t = norm(rawNorm); // 用归一化后的值做 label 匹配
          let hit = options.find(o => norm(o.label) === t);
          if (!hit) hit = options.find(o => t.length >= 2 && norm(o.label).indexOf(t) >= 0);
          if (!hit) hit = options.find(o => norm(o.label).length >= 2 && t.indexOf(norm(o.label)) >= 0);
          if (!hit) {
            // 数值匹配：先试归一化后的 rawNorm（含阿拉伯数字），再试原始 rawValue（阿拉伯数字直接匹配）
            const numMatch = rawNorm.match(/-?\d+(\.\d+)?/) || String(rawValue).match(/-?\d+(\.\d+)?/);
            if (numMatch) {
              const num = parseFloat(numMatch[0]);
              // 用归一化后的值判断单位
              const hasMonth = /月/.test(rawNorm) || /月/.test(rawValue);
              const valYears = hasMonth ? num / 12 : num;
              const _parseInterval = (lbl) => {
                const n = lbl.replace(/[^\d.~至\-年以上下]/g, '');
                const m = n.match(/(\d+\.?\d*)(?:\s*[~至\-]\s*(\d+\.?\d*))?/);
                if (!m) return null;
                let low = parseFloat(m[1]), high = m[2] != null ? parseFloat(m[2]) : null;
                if (/以上/.test(lbl)) return { low, high: Infinity };
                if (/以下/.test(lbl)) return { low: -Infinity, high: low };
                if (high == null) high = low;
                return { low, high };
              };
              hit = options.find(o => {
                const iv = _parseInterval(o.label);
                return iv != null && valYears >= iv.low && valYears <= iv.high;
              });
            }
          }
          console.log('[AutoFill-DBG] 匹配结果', { rawValue, hitLabel: hit && hit.label, hitValue: hit && hit.value });
          if (hit) writeValue = hit.value !== undefined && hit.value !== null ? hit.value : hit.label;
        }
      } catch (e) { console.log('[AutoFill-DBG] extract 异常', e.message); }

      // emit 前先关面板（三重保险）
      try { if (compForEmit && typeof compForEmit.showHide === 'function') compForEmit.showHide(false); } catch (e) {}
      try { if (compForEmit && typeof compForEmit.blur === 'function') compForEmit.blur(); } catch (e) {}
      try { if (compForEmit) { compForEmit.visible = false; compForEmit.expand = false; } } catch (e) {}

      if (modelInst) {
        console.log('[AutoFill-DBG] 准备 emit', { writeValue });
        // 注意：emit 后绝对不要碰原生 input.value 或派发原生 input/change 事件！
        // Vue 有自己的双向绑定机制，乱发原生事件会让组件内部 handler 用旧状态回写 DOM → 出现"填了又清"
        try { modelInst.emit('update:modelValue', writeValue); } catch (e) {}
        try { modelInst.emit('change', writeValue); } catch (e) {}
        if (isIview) try { modelInst.emit('on-change', writeValue); } catch (e) {}
        // 直接改 prop 作为最后一道保险（只改 prop，不动 DOM）
        try { modelInst.modelValue = writeValue; } catch (e) {}
        const afterMV = modelInst.modelValue;
        // displayed 要从多个候选位置取（view-ui-plus 的显示值不一定在 el.innerText 里）
        let displayed = '';
        try {
          const selInput = el.querySelector && el.querySelector('input');
          if (selInput && selInput.value) displayed = selInput.value;
          if (!displayed && el.innerText) displayed = el.innerText;
          if (!displayed) {
            const sel = el.querySelector && el.querySelector('.ivu-select-selection-selected, .el-select__selected-item, .ant-select-selection-item');
            if (sel) displayed = sel.textContent || '';
          }
        } catch(e) { /* ignore */ }
        displayed = (displayed || '').trim().slice(0, 40);
        // 关键判定：Vue 内部状态变了 ≠ 页面显示了
        // view-ui-plus 这类组件内部有独立状态管理，emit 只改 modelValue prop 不够
        const stillPlaceholder = /请选择|select|placeholder|^\s*$|请输入/.test(displayed);
        // 更宽松的 ok：emit 后 modelValue 变了就算 ok=true 走 DOM 兜底前先判定一次
        // 但 displayed 还是 placeholder 的话，强制 ok=false 让 content.js 走 DOM 点击（DOM 点击才是最可靠的）
        const ok = !stillPlaceholder && (afterMV === writeValue || String(afterMV) === String(writeValue));
        console.log('[AutoFill-DBG] emit 后状态', { writeValue, afterMV, displayed, stillPlaceholder, ok });

        Object.assign(diag, syncFormState(writeValue, false));
        // ok=false 让 content.js 走 openPanel + realClick 兜底（DOM 点击是最可靠的）
        return { ok, via: 'vue3-select', diag };
      }
      console.log('[AutoFill-DBG] 未找到 modelInst');
      diag.vue3Select = '未找到 select modelValue';
    } else {
      // text / number / radio / checkbox：emit update:modelValue
      const modelInst = findInner(i => 'modelValue' in propsOf(i) && typeof i.emit === 'function');
      if (modelInst) {
        modelInst.emit('update:modelValue', rawValue);
        try { modelInst.emit('change', rawValue); } catch (e2) {}
        if (isIview) try { modelInst.emit('on-change', rawValue); } catch (e2) {}
        Object.assign(diag, syncFormState(rawValue, false));
        return { ok: true, via: 'vue3-modelValue', diag };
      }
      diag.vue3 = '未找到 modelValue 组件实例';
    }
  } else {
    diag.frameworks.vue3 = diag.frameworks.vue3 || 'no chain3';
  }

  // =============== 框架 4: 原生 DOM 兜底 ===============
  diag.frameworks.dom = 'fallback';
  try {
    if (valueType === 'select') {
      const nativeSel = el.tagName === 'SELECT' ? el : el.querySelector && el.querySelector('select');
      if (nativeSel) {
        const opt = Array.from(nativeSel.options).find(o => norm(o.textContent) === norm(rawValue) || o.value === rawValue);
        nativeSel.value = opt ? opt.value : rawValue;
        nativeSel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, via: 'dom-native-select', diag };
      }
      // 非原生 <select>：往组件内部 input 写文字只是"看起来选中了"，Vue2/iView 的 model 不会更新，
      // 还会让 content.js 误判成功、跳过"打开面板点真实选项"的兜底。
      // 所以这里必须上报失败，由外层走 DOM 点击。
      if (el.closest && el.closest('.ivu-select, .el-select, .ant-select, .n-select')) {
        diag.domSelect = 'no-native-select';
        return { ok: false, via: 'dom-no-native-select', diag };
      }
    }
    if (valueType === 'file') {
      const fileInput = el.tagName === 'INPUT' ? el : (el.querySelector && el.querySelector('input[type="file"]'));
      if (fileInput && window.DataTransfer) {
        const dt = new DataTransfer();
        (payload.files || []).forEach(f => {
          try { dt.items.add(new File([new Uint8Array(0)], f.name, { type: f.type || '' })); } catch (e) {}
        });
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, via: 'dom-native-file', diag };
      }
    }
    const textInput = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el : (el.querySelector && el.querySelector('input, textarea'));
    if (textInput) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      try { setter ? setter.call(textInput, rawValue) : (textInput.value = rawValue); } catch (e) { textInput.value = rawValue; }
      textInput.dispatchEvent(new Event('input', { bubbles: true }));
      textInput.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, via: 'dom-input', diag };
    }
  } catch (e) { diag.domError = e.message; }

  return { ok: false, error: '主世界未找到可写入的组件状态', diag };
}

function saveState() {
  // savePendingTab 必须一起存：否则后台被回收后，「已保存，下一条」会以为没有等待中的记录
  chrome.storage.local.set({ dataset, currentIndex, controlState, failedLogs, fieldMapping, valueMapping, savePendingTab, paused, stateUpdatedAt: Date.now() });
}

function broadcastUI() {
  const hasFailed = dataset.some(d => d._status === 'fail');
  chrome.runtime.sendMessage({
    action: "UPDATE_UI_STATE",
    dataset,
    controlState,
    hasFailed
  }).catch(() => {});
}

function broadcastLog(type, text) {
  const now = new Date().toTimeString().split(' ')[0];
  chrome.runtime.sendMessage({
    action: "APPEND_LOG",
    log: { time: now, type, text }
  }).catch(() => {});
}

function handleMessage(request, sender, sendResponse) {
  // 确保目标标签页里有存活的 content script（扩展重新加载后，旧标签页的脚本会失联）
  if (request.action === "ENSURE_CONTENT") {
    const tabId = request.tabId;
    if (!tabId) { sendResponse({ ok: false, error: '无有效标签页' }); return true; }
    chrome.tabs.sendMessage(tabId, { action: 'PING' }, () => {
      if (!chrome.runtime.lastError) { sendResponse({ ok: true, injected: false }); return; }
      // ping 失败 → 主动注入一次（只在脚本缺失时注入，避免重复注册监听）
      // 注意：构建后文件名带 hash，必须从 manifest 里取真实路径
      const cs = chrome.runtime.getManifest().content_scripts || [];
      const files = (cs[0] && cs[0].js) || [];
      if (!files.length) { sendResponse({ ok: false, error: 'manifest 未声明 content_scripts' }); return true; }
      chrome.scripting.executeScript({ target: { tabId }, files }, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        setTimeout(() => sendResponse({ ok: true, injected: true }), 150);
      });
    });
    return true;
  }

  if (request.action === "GET_STATUS") {
    const hasFailed = dataset.some(d => d._status === 'fail');
    sendResponse({ dataset, controlState, hasFailed, fieldMapping, valueMapping });
  }

  if (request.action === "SET_DATASET") {
    dataset = request.dataset;
    fieldMapping = request.fieldMapping || {};
    valueMapping = request.valueMapping || {};
    currentIndex = 0;
    controlState = '就绪';
    failedLogs = [];
    savePendingTab = null;
    ignoreNextResult = false;
    saveState();
    broadcastUI();
  }

  if (request.action === "CONTROL_EXECUTION") {
    if (request.intervalMs) executionInterval = request.intervalMs;

    if (request.command === 'start') {
      if (dataset.length === 0) return;
      if (savePendingTab) {
        broadcastLog('Warn', '当前正在等待你确认上一条的保存结果，请点「已保存，下一条」或「跳过本条」');
        return;
      }
      paused = false;
      controlState = '执行中';
      saveState();
      broadcastUI();
      broadcastLog('Sys', '开始批量自动化执行填表...');
      processNextTask();
    } else if (request.command === 'pause') {
      paused = true;
      // 中断正在进行的逐字段填充，而不是只阻止下一条
      if (fillTabId) {
        try { chrome.tabs.sendMessage(fillTabId, { action: 'CANCEL_FILL' }); } catch (e) { /* ignore */ }
      }
      // 正在等用户确认保存时保留「等待保存」界面，否则确认按钮会消失
      if (!savePendingTab) controlState = '暂停';
      saveState();
      broadcastUI();
      broadcastLog('Sys', savePendingTab ? '已暂停：当前这条确认保存后不再自动继续' : '已暂停执行。');
    } else if (request.command === 'reset') {
      paused = false;
      fillTabId = null;
      controlState = '就绪';
      currentIndex = 0;
      dataset.forEach(d => { d._status = 'pending'; d._reason = ''; });
      failedLogs = [];
      if (savePendingTab) {
        try { chrome.tabs.sendMessage(savePendingTab, { action: 'MANUAL_SAVE_RESOLVE', ok: false, reason: '已重置' }); } catch (e) { /* ignore */ }
        savePendingTab = null;
        ignoreNextResult = true;
      }
      saveState();
      broadcastUI();
      broadcastLog('Sys', '进度已重置。');
    }
  }

  // content 已填入某条，正在等用户手动点页面保存
  if (request.action === "AWAIT_MANUAL_SAVE") {
    savePendingTab = sender.tab ? sender.tab.id : null;
    fillTabId = null;
    controlState = '等待保存';
    saveState();
    broadcastUI();
  }

  // 用户点「暂停」后，content 中止了本条剩余的字段填充：保持暂停，不结算这条
  if (request.action === "FILL_ABORTED") {
    fillTabId = null;
    controlState = '暂停';
    saveState();
    broadcastUI();
    broadcastLog('Sys', '已暂停：当前条目已停止填充（已填内容保留在页面），剩余记录未执行');
  }

  // 侧边栏「已保存，继续」/「跳过本条」：转发给 content 结束本条等待
  if (request.action === "MANUAL_SAVE_CONTINUE" || request.action === "MANUAL_SAVE_SKIP") {
    const skip = request.action === "MANUAL_SAVE_SKIP";
    const msg = skip ? '已跳过当前这条的保存等待' : '已手动标记保存成功，继续下一条';
    const settle = () => settleCurrentRow(!skip, skip ? '已跳过本条（未手动保存）' : '已手动标记保存成功');

    if (!savePendingTab) {
      // 后台被回收过 / 页面已刷新：状态虽然恢复了，但 content 那边的等待器可能已经没了。
      // 这里不再"点了没反应"，直接按用户的选择结算本条。
      broadcastLog(skip ? 'Warn' : 'Sys', msg);
      settle();
      return true;
    }

    chrome.tabs.sendMessage(savePendingTab, {
      action: 'MANUAL_SAVE_RESOLVE',
      ok: !skip,
      reason: skip ? '已跳过本条（未手动保存）' : '已手动标记保存成功'
    }, (res) => {
      if (chrome.runtime.lastError || !res || res.ok === false) {
        // content 已经不认识这次等待（切页/刷新导致 content script 重建）→ 后台自己结算
        broadcastLog('Warn', '页面已切换或刷新，等待状态丢失，按你的选择继续');
        settle();
        return;
      }
      broadcastLog(skip ? 'Warn' : 'Sys', msg);
    });
    savePendingTab = null;
    saveState();
  }

  if (request.action === "TASK_RESULT") {
    if (ignoreNextResult) { ignoreNextResult = false; return; }
    if (request.success) broadcastLog('Success', `第 ${currentIndex + 1} 条保存成功`);
    else broadcastLog('Error', `第 ${currentIndex + 1} 条录入失败: ${request.reason}`);
    settleCurrentRow(!!request.success, request.reason);
  }

  // 读取本地附件（file:// 需用户在 chrome://extensions 开启"允许访问文件网址"）或扩展 attachments/ 目录
  if (request.action === "READ_FILE") {
    (async () => {
      try {
        const raw = request.path || '';
        let resp, name;
        if (/^file:\/\//i.test(raw) || /[\\\/]/.test(raw)) {
          const parts = raw.replace(/^file:\/\//i, '').replace(/\\/g, '/').split('/').filter(Boolean);
          name = decodeURIComponent(parts[parts.length - 1] || raw);
          resp = await fetch('file:///' + parts.map(encodeURIComponent).join('/'));
        } else {
          name = raw;
          resp = await fetch(chrome.runtime.getURL('attachments/' + raw.split('/').map(encodeURIComponent).join('/')));
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const buf = new Uint8Array(await resp.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        const mime = resp.headers.get('content-type');
        sendResponse({ ok: true, name, mime: mime && mime !== 'application/octet-stream' ? mime : (MIME_BG[name.split('.').pop()?.toLowerCase()] || ''), data: btoa(bin) });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (request.action === "GET_FAILED_LOGS") {
    sendResponse({ failedLogs });
  }

  // 主世界直写组件状态：content script 在隔离世界读不到 __vue__ / __reactFiber，必须注入主世界执行
  if (request.action === "MAIN_WORLD_SET") {
    (async () => {
      try {
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) return sendResponse({ ok: false, error: '缺少 tabId' });
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: mainWorldWrite,
          args: [{
            marker: request.marker,
            value: String(request.value == null ? '' : request.value),
            valueType: request.valueType || 'text',
            files: request.files || []
          }]
        });
        sendResponse((results && results[0] && results[0].result) || { ok: false, error: '主世界无返回' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  return true;
}

// 等状态恢复后再处理消息，避免后台被回收重启后的第一条消息读到空 dataset/空 savePendingTab
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (stateLoaded) return handleMessage(request, sender, sendResponse);
  stateReady.then(() => handleMessage(request, sender, sendResponse)).catch(() => {});
  return true;
});

// 结算当前这一条（成功 / 失败 / 跳过），再按控制状态推进到下一条
function settleCurrentRow(success, reason) {
  if (currentIndex >= dataset.length) return;
  if (success) {
    dataset[currentIndex]._status = 'success';
  } else {
    dataset[currentIndex]._status = 'fail';
    dataset[currentIndex]._reason = reason || '未保存';
    failedLogs.push({ ...dataset[currentIndex], "失败原因": reason || '未保存' });
  }
  currentIndex++;
  savePendingTab = null;
  fillTabId = null;
  saveState();
  if (currentIndex >= dataset.length) {
    paused = false;
    controlState = '就绪';
    saveState();
    broadcastUI();
    broadcastLog('Sys', '所有数据录入任务执行完毕！');
  } else if (paused) {
    controlState = '暂停';
    saveState();
    broadcastUI();
    broadcastLog('Sys', '已暂停，剩余记录未执行');
  } else {
    controlState = '执行中';
    saveState();
    broadcastUI();
    setTimeout(processNextTask, 800);
  }
}

async function processNextTask() {
  if (paused || controlState !== '执行中' || currentIndex >= dataset.length) return;
  executeCurrentRow();
}

async function executeCurrentRow() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) return;

  broadcastLog('Fill', `正在填入第 ${currentIndex + 1} 条数据…（填完后请手动点页面「保存」，再在侧边栏点「已保存，下一条」）`);
  fillTabId = tabs[0].id;
  chrome.tabs.sendMessage(tabs[0].id, {
    action: "FILL_SINGLE_RECORD",
    row: dataset[currentIndex],
    index: currentIndex,
    interval: executionInterval,
    fieldMapping,
    valueMapping
  });
}
