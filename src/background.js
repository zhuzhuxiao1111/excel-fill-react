﻿// 点击插件图标自动在右侧展开侧边栏
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => console.error(error));

let dataset = [];
let currentIndex = 0;
let controlState = '就绪'; // '就绪' | '执行中' | '暂停'
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

  const diag = { frameworks: {} };

  // ---- 工具 ----
  const qS = (scope, sel) => { try { return scope.querySelector(sel); } catch (e) { return null; } };
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '').replace(/[~～－—–―]/g, '-');
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
    let comp = vm2, hops2 = 0;
    // 向上找目标控件（Select/Download/DatePicker 等）
    if (valueType === 'select') {
      while (comp && hops2 < 20) {
        if (/select/i.test(nameOf2(comp)) && !/option/i.test(nameOf2(comp))) break;
        comp = comp.$parent; hops2++;
      }
    } else if (valueType === 'file') {
      while (comp && hops2 < 20) {
        if (/upload/i.test(nameOf2(comp))) break;
        comp = comp.$parent; hops2++;
      }
    } else if (valueType === 'date' || valueType === 'time') {
      while (comp && hops2 < 20) {
        if (/date|time/i.test(nameOf2(comp)) && !/option/i.test(nameOf2(comp))) break;
        comp = comp.$parent; hops2++;
      }
    }
    if (!comp) comp = vm2;
    diag.frameworks.vue2 = { compName: nameOf2(comp), hops: hops2 };

    // 解除 disabled
    try {
      if (comp._props && 'disabled' in comp._props) comp._props.disabled = false;
      if (comp.disabled) comp.disabled = false;
    } catch (e) {}

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
        if (!match) { diag.vue2Select = '未找到选项: ' + rawValue; }
        else {
          const optVal = (match.value !== undefined && match.value !== null) ? match.value : labelOf(match);
          let via = '';
          if (typeof match.select === 'function') { try { match.select(); via = 'option.select'; } catch (e) {} }
          if (!via) { try { comp.$emit('input', optVal); via = 'emit-input'; } catch (e) {} }
          if (!via) { try { comp.$emit('change', optVal); via = 'emit-change'; } catch (e) {} }
          try { if (comp._props && 'value' in comp._props) comp._props.value = optVal; } catch (e) {}
          try { if ('visible' in comp) comp.visible = false; } catch (e) {}
          if (via) return { ok: true, via: 'vue2-select-' + via, diag };
        }
      } else if (valueType === 'file') {
        // Vue2 iView Upload: fileList + on-success + on-change
        const kind = /ivu/i.test(el.className || comp.$options.name || '') ? 'ivu' : 'el';
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
      // Vue3 select：直接 emit update:modelValue + change，组件会自动从 props.options 匹配 label→value
      const modelInst = findInner(i => 'modelValue' in propsOf(i) && typeof i.emit === 'function');
      if (modelInst) {
        modelInst.emit('update:modelValue', rawValue);
        try { modelInst.emit('change', rawValue); } catch (e2) {}
        if (isIview) {
          // iView Select 额外发 on-change 回调（参数为选中的 value）
          try { modelInst.emit('on-change', rawValue); } catch (e2) {}
          // iView 用 showHide() 关闭下拉面板（避免残留）
          try { if (modelInst.proxy && typeof modelInst.proxy.showHide === 'function') modelInst.proxy.showHide(false); } catch (e2) {}
        }
        Object.assign(diag, syncFormState(rawValue, false));
        return { ok: true, via: 'vue3-select', diag };
      }
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
  chrome.storage.local.set({ dataset, currentIndex, controlState, failedLogs, fieldMapping, valueMapping });
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
    saveState();
    broadcastUI();
  }

  if (request.action === "CONTROL_EXECUTION") {
    if (request.intervalMs) executionInterval = request.intervalMs;

    if (request.command === 'start') {
      if (dataset.length === 0) return;
      controlState = '执行中';
      broadcastUI();
      broadcastLog('Sys', '开始批量自动化执行填表...');
      processNextTask();
    } else if (request.command === 'pause') {
      controlState = '暂停';
      broadcastUI();
      broadcastLog('Sys', '已暂停执行。');
    } else if (request.command === 'reset') {
      controlState = '就绪';
      currentIndex = 0;
      dataset.forEach(d => { d._status = 'pending'; d._reason = ''; });
      failedLogs = [];
      saveState();
      broadcastUI();
      broadcastLog('Sys', '进度已重置。');
    }
  }

  if (request.action === "TASK_RESULT") {
    if (currentIndex < dataset.length) {
      if (request.success) {
        dataset[currentIndex]._status = 'success';
        broadcastLog('Success', `第 ${currentIndex + 1} 条录入提交成功`);
      } else {
        dataset[currentIndex]._status = 'fail';
        dataset[currentIndex]._reason = request.reason;
        failedLogs.push({ ...dataset[currentIndex], "失败原因": request.reason });
        broadcastLog('Error', `第 ${currentIndex + 1} 条录入失败: ${request.reason}`);
      }
      currentIndex++;
      saveState();
      broadcastUI();

      if (controlState === '执行中' && currentIndex < dataset.length) {
        setTimeout(processNextTask, 500);
      } else if (currentIndex >= dataset.length) {
        controlState = '就绪';
        saveState();
        broadcastUI();
        broadcastLog('Sys', '所有数据录入任务执行完毕！');
      }
    }
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
});

async function processNextTask() {
  if (controlState !== '执行中' || currentIndex >= dataset.length) return;
  executeCurrentRow();
}

async function executeCurrentRow() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) return;

  broadcastLog('Fill', `正在填入并提交第 ${currentIndex + 1} 条数据...`);
  chrome.tabs.sendMessage(tabs[0].id, {
    action: "FILL_SINGLE_RECORD",
    row: dataset[currentIndex],
    interval: executionInterval,
    fieldMapping,
    valueMapping
  });
}
