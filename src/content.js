const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let FIELD_ALIAS = {};  
let VALUE_ALIAS = {};  
const mapValue = (v) => { const s = String(v).trim(); return VALUE_ALIAS[s] || s; };

// 防止重复注入导致 chrome.runtime.onMessage 收到同一条消息后执行两次
// （用户 reload 扩展但没刷新页面时，新旧 content script 同时存在）
const _recentPastes = new Map(); // hash → timestamp(ms)
function _pasteHash(text) {
  const t = String(text || '').trim();
  let h = 0;
  for (let i = 0; i < t.length; i++) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
  return String(h);
}
function _pasteShouldSkip(text) {
  const now = Date.now();
  const h = _pasteHash(text);
  const last = _recentPastes.get(h);
  if (last && now - last < 5000) { slog('Warn', '检测到重复粘贴请求，已跳过'); return true; }
  _recentPastes.set(h, now);
  // 清理超过 10 秒的旧记录
  for (const [k, v] of _recentPastes) if (now - v > 10000) _recentPastes.delete(k);
  return false;
}

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
    // 注意：这里一定要发"不带 data 的普通 input 事件"。
    // 之前用 InputEvent + data=整串值，页面若有"把 event.data 插入到当前值"的格式化/掩码逻辑，
    // 每粘贴一次就会把整串身份证号再追加一遍（表现为号码重复两三次）。
    element.dispatchEvent(new Event('input', { bubbles: true }));
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

// 把 option 文本解析成数值区间：3~5年→[3,5]、1年以下→[-∞,1)、10年以上→[10,+∞]
// 所有单位统一换算到"年"，所以下拉里写月/天也能被识别：6~12月 → [0.5, 1]
function parseOptionInterval(text) {
  const t = String(text || '').replace(/\s+/g, '');
  const unit = unitFactor(t); // 月=1/12，天≈1/365，年=1
  // 如 "3~5年" "3-5年" "3至5年" "3到5年" "3—5年"
  const mRange = t.match(/(\d+(?:\.\d+)?)[~～\-—–―至到、](\d+(?:\.\d+)?)/);
  if (mRange) return { low: parseFloat(mRange[1]) * unit, high: parseFloat(mRange[2]) * unit };
  // 如 "10年以上" "10年及以上" ">10" "≥10"
  const mAbove = t.match(/([>\s≥≧]*)(\d+(?:\.\d+)?)(?:年|岁|天|月|以上|及以上|\+)/);
  if (mAbove && (/>|≥|≧|以上|及以上|\+|年|岁|月|天/.test(t.split(mAbove[1] + mAbove[2])[1] || ''))) {
    const n = parseFloat(mAbove[2]) * unit;
    if (/>|≥|≧|以上|及以上|\+/.test(t)) return { low: n, high: Infinity };
  }
  // 如 "1年以下" "1岁以下" "<1" "≤1"
  const mBelow = t.match(/([<\s≤≦]*)(\d+(?:\.\d+)?)(?:年|岁|天|月|以下|及以下|-)/);
  if (mBelow && (/<|≤|≦|以下|及以下|-/.test(t.split(mBelow[1] + mBelow[2])[1] || ''))) {
    const n = parseFloat(mBelow[2]) * unit;
    if (/<|≤|≦|以下|及以下/.test(t)) return { low: -Infinity, high: n };
    if (t.endsWith('-')) return { low: n, high: Infinity };
  }
  return null;
}

// 文本里的单位 → 年的换算系数
function unitFactor(text) {
  const t = String(text || '');
  if (/月|个月|month/i.test(t)) return 1 / 12;
  if (/天|日|day/i.test(t)) return 1 / 365;
  if (/岁|year/i.test(t)) return 1;
  // 没有显式单位 → 1（默认年），由调用方决定是否使用
  return 1;
}

// 把用户输入解析成以"年"为单位的单数值：
//   "4年" → 4, "4" → 4, "3.5" → 3.5,
//   "6个月" → 0.5, "18个月" → 1.5,
//   "1年6个月" → 1.5, "2年3月" → 2.25
// 解析不出返回 null
// 中文数字 → 阿拉伯数字 + 单位替换，让 parseNumberLike 能识别「一个月」「半年」「一年半」
function cnToArabic(val) {
  if (!val) return val;
  let s = String(val).replace(/\s+/g, '');
  // 汉字数字字符集（含大小写，用于正则匹配组合式）
  const CN_DIGITS = '零〇一壹二贰两俩三叁四肆五伍六陆七柒八捌九玖';
  // 数字映射（不含十、零 —— 单独处理）
  const digitMap = {
    '一': '1', '壹': '1',
    '二': '2', '贰': '2', '两': '2', '俩': '2',
    '三': '3', '叁': '3',
    '四': '4', '肆': '4',
    '五': '5', '伍': '5',
    '六': '6', '陆': '6',
    '七': '7', '柒': '7',
    '八': '8', '捌': '8',
    '九': '9', '玖': '9',
  };

  // ===== 第 1 步：先处理「零」作为年/月连接词的场景 =====
  // 例：三年零两个月 → 先把「两」换成「2」再处理？不行，正则要匹配汉字
  // 所以先把连接词里的「零」标记成不可再处理，然后替换 digitMap
  // 实际上更简单：先跑组合式正则（十+X/X十/X十Y），再处理连接词「零」，最后替换单字
  // 但「十」也需要在组合式之前存在，所以先单独处理「十」相关组合

  // ===== 第 2 步：组合式 —— X十Y / 十Y / X十（十和拾都支持）=====
  const SHI = '[十拾]';
  // X十Y：二十三 → 23
  s = s.replace(new RegExp(`([${CN_DIGITS}]+)${SHI}([${CN_DIGITS}])`, 'g'), (m, a, b) => {
    const a2 = a.replace(/零|〇/g, '');
    const aa = (CN_DIGITS.includes(a2) ? digitMap[a2] : a2) || a2;
    const bb = (CN_DIGITS.includes(b) ? digitMap[b] : b) || b;
    return String(parseInt(aa, 10) * 10 + parseInt(bb, 10));
  });
  // 十Y：十三 → 13
  s = s.replace(new RegExp(`${SHI}([${CN_DIGITS}])`, 'g'), (m, b) => {
    const bb = digitMap[b] || b;
    return String(10 + (parseInt(bb, 10) || 0));
  });
  // X十：二十 → 20（后面跟不跟单位都处理，"二十年"→"20年"也正确）
  s = s.replace(new RegExp(`([${CN_DIGITS}])${SHI}`, 'g'), (m, a) => {
    const aa = digitMap[a] || a;
    return String((parseInt(aa, 10) || 0) * 10);
  });
  // 单独的「十/拾」变成 10（放在最后，避免误杀已处理的组合）
  s = s.replace(/[十拾]/g, '10');

  // ===== 第 3 步：现在把「零」当连接词处理（此时其他汉字数字可能还没替换）=====
  // 先把汉字数字替换成阿拉伯，这样年零月就能匹配 (\d)年零(\d)
  // 但这样「三年零两个月」里「两」还没被替换…
  // 方案：先跑一遍 digitMap（不含零），然后处理连接词「零」，最后处理剩余的「零」
  for (const [cn, ar] of Object.entries(digitMap)) s = s.split(cn).join(ar);
  // 现在：三年零两个月 → 3年零2个月 ✓
  // 处理连接词里的「零」→ 直接删掉（变成 3年2个月）
  s = s.replace(/(\d)年零(\d)/g, '$1年$2');
  s = s.replace(/(\d)个月?零(\d)/g, '$1个月$2');
  s = s.replace(/(\d)岁零(\d)/g, '$1岁$2');
  // 单独残留的「零/〇」→ 删掉（比如「零个月」「零年」这种边界情况）
  s = s.replace(/[零〇]/g, '');

  // ===== 第 4 步：「半」处理 =====
  // 例：半年 → 0.5年；一年半 → 1.5年；2年半 → 2.5年；3个月半 → 3.5个月
  s = s.replace(/(\d+(?:\.\d+)?)年半/g, '$1.5年');
  s = s.replace(/(\d+(?:\.\d+)?)个月?半/g, '$1.5个月');
  s = s.replace(/(\d+(?:\.\d+)?)岁半/g, '$1.5岁');
  s = s.replace(/^半(?=(年|岁|个月?|天))/, '0.5');

  // ===== 第 5 步：单位清理 =====
  // 「个」字删除：一个月 → 1个月；三个月 → 3月
  s = s.replace(/([0-9.])个(?=[月年天岁])/g, '$1');
  s = s.replace(/[个]+/g, '');

  // ===== 第 6 步：口语模糊词清理 =====
  s = s.replace(/[多多余约约将近大概大约至少以上左右来]/g, '');

  return s;
}

function parseNumberLike(val) {
  if (val === null || val === undefined) return null;
  const t = cnToArabic(String(val)).replace(/\s+/g, '');
  // 复合写法：1年6个月 / 2年3月
  const mCompound = t.match(/(\d+(?:\.\d+)?)(?:年|岁|year)(?:(\d+(?:\.\d+)?)(?:月|个月|month))?/i);
  if (mCompound) {
    let n = parseFloat(mCompound[1]);
    if (mCompound[2]) n += parseFloat(mCompound[2]) / 12;
    return n;
  }
  // 纯月数：18个月 / 6月 / 0.5个月
  const mMonths = t.match(/(\d+(?:\.\d+)?)(?:月|个月|month)/i);
  if (mMonths) return parseFloat(mMonths[1]) / 12;
  // 纯天数：90天
  const mDays = t.match(/(\d+(?:\.\d+)?)(?:天|日|day)/i);
  if (mDays) return parseFloat(mDays[1]) / 365;
  // 纯数字：默认按年处理（Excel 里 4 → 4年 是最常见场景）
  const m = t.match(/(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// 数值 → 下拉区间的精确命中；找不到就返回 null
function findOptionByNumber(root, selector, num) {
  if (!root || num === null || num === undefined) return null;
  const nodes = qSA(root, selector).filter(isVisible);
  for (const n of nodes) {
    const iv = parseOptionInterval(n.textContent);
    if (!iv) continue;
    // 端点包含匹配：3~5 包含 3/4/5；10年以上包含 10
    if ((iv.low === -Infinity || num >= iv.low - 1e-6) &&
        (iv.high === Infinity || num <= iv.high + 1e-6)) {
      return n;
    }
  }
  return null;
}

// 证件类型归一：Excel/粘贴里写的简称 → 下拉真实选项名
// 下拉真实选项名每个项目不一样（有的写"身份证"，有的写"居民身份证"），
// 所以这里只是把常见简称展开，最终仍然靠 findNodeByText 去下拉里精确找
function normalizeIdType(val) {
  const v = String(val || '').trim();
  const map = [
    // 中国大陆
    [/^(居民)?身份证(号|号码)?$/i, '居民身份证'],
    [/^(护照(号|号码)?|passport)$/i, '护照'],
    [/^(港澳居民来往内地通行证(号|号码)?|港澳通行证(号|号码)?|回乡证(号|号码)?)$/i, '港澳居民来往内地通行证'],
    [/^(台湾居民来往大陆通行证(号|号码)?|台湾通行证(号|号码)?|台胞证(号|号码)?|台胞通行证)$/i, '台湾居民来往大陆通行证'],
    [/^(驾驶证(号|号码)?|驾照(号|号码)?|机动车驾驶证)$/i, '驾驶证'],
    [/^(军官证(号|号码)?|军官身份证件)$/i, '军官证'],
    [/^(士兵证(号|号码)?|军人证)$/i, '士兵证'],
    [/^(警官证(号|号码)?|人民警察证)$/i, '警官证'],
    [/^(户口簿(号|号码)?|户口本(号|号码)?|户籍证明)$/i, '户口簿'],
    [/^(出生(医学)?证明(号|号码)?)$/i, '出生证明'],
    [/^(社保卡(号|号码)?|社会保障卡(号|号码)?)$/i, '社会保障卡'],
    [/^(营业执照(号|号码)?|统一社会信用代码)$/i, '统一社会信用代码'],
    [/^(统一社会信用代码|信用代码)$/i, '统一社会信用代码'],
    [/^(签证(号|号码)?|visa)$/i, '签证'],
    [/^(居住证(号|号码)?|暂住证(号|号码)?)$/i, '居住证'],
    [/^(学历证书|学位证书|毕业证|学位证)$/i, '学历证书'],
  ];
  for (const [replacement, target] of map) {
    if (replacement.test(v)) return target;
  }
  return v;
}

// 证件号类粘贴行 → 同时派生出「证件类型」和「证件号码」两条
// 例如：护照号: E12345678 → { 证件类型: '护照', 证件号码: 'E12345678' }
// 命中规则后不再走 PASTE_FIELD_ALIASES，避免别名表里还要枚举所有 "XX号"
const CITIZEN_ID_SPLIT_RULES = [
  { fieldRe: /^(护照(号|号码)?|passport)$/i, typeValue: '护照' },
  { fieldRe: /^(港澳(居民)?(来往)?(内地|大陆)?通行证(号|号码)?|回乡证(号|号码)?|港澳通行证(号|号码)?)$/i, typeValue: '港澳居民来往内地通行证' },
  { fieldRe: /^(台湾(居民)?(来往)?大陆通行证(号|号码)?|台胞证(号|号码)?|台湾通行证(号|号码)?)$/i, typeValue: '台湾居民来往大陆通行证' },
  { fieldRe: /^(驾驶证(号|号码)?|驾照(号|号码)?|机动车驾驶证)$/i, typeValue: '驾驶证' },
  { fieldRe: /^(军官证(号|号码)?)$/i, typeValue: '军官证' },
  { fieldRe: /^(士兵证(号|号码)?|军人证)$/i, typeValue: '士兵证' },
  { fieldRe: /^(警官证(号|号码)?|人民警察证)$/i, typeValue: '警官证' },
  { fieldRe: /^(户口簿(号|号码)?|户口本(号|号码)?|户籍证明)$/i, typeValue: '户口簿' },
  { fieldRe: /^(社保卡(号|号码)?|社会保障卡(号|号码)?)$/i, typeValue: '社会保障卡' },
  { fieldRe: /^(统一社会信用代码(号|号码)?|营业执照(号|号码)?)$/i, typeValue: '统一社会信用代码' },
  { fieldRe: /^(签证(号|号码)?|visa)$/i, typeValue: '签证' },
  { fieldRe: /^(居住证(号|号码)?|暂住证(号|号码)?)$/i, typeValue: '居住证' },
];

// 身份证号格式推导：18位/15位/带X → 居民身份证
function looksLikeIdCardNumber(v) {
  const s = String(v || '').trim();
  return /^\d{17}[\dXx]$/.test(s) || /^\d{15}$/.test(s);
}

// 护照号格式推导：1位字母+7位数字，或 E 开头 8 位
function looksLikePassportNumber(v) {
  const s = String(v || '').trim();
  return /^[A-Za-z]\d{7,8}$/.test(s) || /^E\d{8}$/.test(s) || /^G\d{8}$/.test(s);
}

// 只有证件号码没有证件类型时，根据号码格式推导
function deduceIdTypeFromNumber(num) {
  if (looksLikeIdCardNumber(num)) return '居民身份证';
  if (looksLikePassportNumber(num)) return '护照';
  return null;
}

function normalizeEdu(val) {
  const v = String(val || '').trim();
  const map = [
    [/^(高中|普通高中|职高|中专|技校|技高)$/, '高中'],
    [/^(大专|专科|高职|高专)$/, '大专'],
    [/^(本科|学士|大学本科|全日制本科)$/, '本科'],
    [/^(硕士|研究生|硕)$/, '硕士'],
    [/^(博士|博|研究生博士)$/, '博士'],
    [/^MBA$/i, 'MBA'],
    [/^EMBA$/i, 'EMBA'],
  ];
  for (const [replacement, target] of map) {
    if (replacement.test(v)) return target;
  }
  return v;
}

// 二值/枚举字段归一：是/否、在职/离职、男/女 等口语值 → 真实选项
// key 用"宽松包含"：页面字段叫「是否在职」→ 归一规则 key 写「在职」即可命中
const BOOL_FIELD_NORMALIZERS = [
  { keyRe: /在职|就业状态|工作状态/, rules: [
    [/(在职|在岗|工作中|就业中|受雇|employed|working|^yes$|^y$|^true$|^1$|是|有)/i, '在职'],
    [/(离职|已离职|待业|未就业|失业|在家|自由职业|unemployed|unemployed|^no$|^n$|^false$|^0$|否)/i, '离职'],
    [/(应届|在校|实习生|实习|在校生|学生)/, '在校生'],
    [/(退休|已退休)/, '退休'],
  ]},
  { keyRe: /性别|sex|gender/, rules: [
    [/^(男|男性|男生|man|male|m|^1$)$/i, '男'],
    [/^(女|女性|女生|woman|female|f|^2$)$/i, '女'],
  ]},
  { keyRe: /是否应届|应届|是否毕业|毕业状态/, rules: [
    [/(应届|应届毕业生|即将毕业|未毕业)/, '应届'],
    [/(往届|已毕业|毕业|往届生)/, '往届'],
  ]},
  { keyRe: /是否已婚|婚姻|婚姻状况|婚否/, rules: [
    [/(已婚|结婚|有配偶)/, '已婚'],
    [/(未婚|单身|未结婚|无配偶)/, '未婚'],
    [/(离异|离婚|丧偶)/, '离异'],
  ]},
  { keyRe: /是否党员|政治面貌|党派/, rules: [
    [/(党员|中共党员|中国共产党党员)/, '中共党员'],
    [/(预备党员|中共预备党员)/, '中共预备党员'],
    [/(团员|共青团员)/, '共青团员'],
    [/(民主党派|民盟|民革|民建)/, '民主党派'],
    [/(群众|普通群众|无党派)/, '群众'],
  ]},
  // 通用 yes/no → 是/否（兜底）
  { keyRe: /是否|有无|可否|能否|^is[A-Z_]|has[A-Z_]|can[A-Z_]/, rules: [
    [/(是|有|可以|能够|^yes$|^y$|^true$|^1$|^on$)/i, '是'],
    [/(否|无|不可以|不能|^no$|^n$|^false$|^0$|^off$)/i, '否'],
  ]},
];

function normalizeBooleanLikeValue(key, val) {
  if (!val) return val;
  const k = String(key || '');
  const v = String(val || '').trim();
  for (const { keyRe, rules } of BOOL_FIELD_NORMALIZERS) {
    if (!keyRe.test(k)) continue;
    for (const [replacement, target] of rules) {
      if (replacement.test(v)) return target;
    }
  }
  return val;
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
  // 必须同时满足：① 在 DOM 里 ② 可见（iView/EP 关闭的 Drawer DOM 不销毁，只是隐藏）
  const sel = '.ant-modal-content, .el-message-box, .el-dialog__body, .ant-drawer-content, [role="dialog"], .ivu-modal-content, .ivu-drawer-content, .n-dialog, .n-modal';
  for (const n of document.querySelectorAll(sel)) {
    if (isVisible(n)) return n;
  }
  return null;
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

// 按 label 精确绑定控件：label[for] / label 内嵌 input
// 标准 HTML 表单（如 GitHub 登录页）里多个 input 是 label 的兄弟节点，
// 只按"往上找容器里的第一个 input"会把两个输入框识别成同一个
function controlFromLabel(lbl) {
  const direct = (el) => {
    if (!el || !isVisible(el)) return null;
    const wrapped = classifyWrapped(el);
    if (wrapped) return wrapped;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      return { type: el.tagName === 'SELECT' ? 'select' : 'input', element: el };
    }
    return null;
  };
  const forId = lbl.getAttribute && lbl.getAttribute('for');
  if (forId) {
    const target = document.getElementById(forId);
    const ctl = direct(target);
    if (ctl) return ctl;
  }
  return direct(lbl.querySelector('input, textarea, select'));
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
    // 附件语义字段（简历附件/个人作品…）优先找 upload 控件：
    // 否则向上爬到大容器时，scanContainer 会先命中同一容器里其他字段的 select/date，返回错误控件类型
    const preferFile = /附件|作品|文件|材料|证明|简历/.test(cleanKey);
    for (let depth = 0; depth < 8 && container && container !== document.documentElement; depth++) {
      if (preferFile) {
        // 容器里可能有多个 upload（简历附件 + 个人作品），必须取表头之后、离表头最近的那个
        const cands = qSA(container, 'input[type="file"], .ant-upload, .el-upload, .ivu-upload, .n-upload')
          .map(f => f.closest('.ant-upload, .el-upload, .ivu-upload, .n-upload') || f)
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .filter(u => isVisible(u) && (node.compareDocumentPosition(u) & Node.DOCUMENT_POSITION_FOLLOWING));
        if (cands.length) return { type: 'file', element: cands[0] };
      }
      const found = scanContainer(container);
      if (found) return found;
      container = container.parentElement;
    }
  }
  return null;
}

// ===== 字段名模糊匹配：让"所属城市/城市/工作城市"都能对上页面上的"所在城市" =====
// 只做"核心词"级别的等价，不做编辑距离，避免把 职位名称 / 职位类别 这类近义字段判错
const KEY_NOISE_PREFIX = /^(所属|所在|当前|本人|我的|目前|现有|期望|目标|推荐|入职|应聘|意向|申请|投递|拟|现)/;

// 通用英文关键词 → 中文核心词。用完整单词边界替换，不会误伤。
// 替换后再交给 normKeyText / keyCore，就能和中文页面表头一起参与匹配
const EN_KEYWORD_MAP = [
  // ===== 基础信息 =====
  { en: /\bfull\s*name\b|\bname\b/gi, zh: '姓名' },
  { en: /\bfirst\s*name\b/gi, zh: '名' },
  { en: /\blast\s*name\b|\bfamily\s*name\b/gi, zh: '姓' },
  { en: /\bgender\b|\bsex\b/gi, zh: '性别' },
  { en: /\bmale\b/gi, zh: '男' },
  { en: /\bfemale\b/gi, zh: '女' },
  { en: /\bbirth\s*(date|day|year)?\b|\bdate\s*of\s*birth\b|\bdob\b/gi, zh: '出生时间' },
  { en: /\bage\b/gi, zh: '年龄' },
  { en: /\bnationality\b|\bcountry\s*of\s*(origin|birth)\b/gi, zh: '国籍' },
  { en: /\bmarital\s*(status)?\b|\bmarriage\b/gi, zh: '婚姻' },
  // ===== 联系方式 =====
  { en: /\bemail\b|\be-?mail\b|\bemail\s*address\b|\bcontact\s*email\b/gi, zh: '邮箱' },
  { en: /\bmobile\s*(phone)?\b|\bcell(phone)?\b|\bphone\b|\btelephone\b|\btel\b|\bcontact\s*(phone|no|number)\b/gi, zh: '手机' },
  { en: /\bwechat\b|\bweixin\b/gi, zh: '微信' },
  { en: /\bqq\b/gi, zh: 'QQ' },
  { en: /\baddress\b|\bcurrent\s*address\b|\bliving\s*address\b/gi, zh: '地址' },
  { en: /\bcity\b|\blocation\b|\bwork(ing)?\s*city\b|\bresidence\s*city\b/gi, zh: '城市' },
  { en: /\bprovince\b/gi, zh: '省' },
  { en: /\bdistrict\b|\barea\b/gi, zh: '区' },
  { en: /\bpost(al)?\s*code\b|\bzip\s*code\b/gi, zh: '邮编' },
  // ===== 证件 =====
  { en: /\bid\b|\bid\s*(card|number)\b|\bidentification\b|\bdocument\b/gi, zh: '证件' },
  { en: /\bid\s*type\b|\bidentification\s*type\b/gi, zh: '证件类型' },
  { en: /\bid\s*(number|no)\b|\bidentification\s*(number|no)\b|\bdocument\s*(number|no)\b/gi, zh: '证件号码' },
  { en: /\bpassport\b(\s*(no|number))?\b/gi, zh: '护照' },
  { en: /\bvisa\b/gi, zh: '签证' },
  { en: /\bdriver\b|\bdriving\s*license\b|\blicense\s*number\b/gi, zh: '驾驶证' },
  // ===== 教育 =====
  { en: /\beducation\b|\beducational\s*background\b|\bacademic\s*background\b/gi, zh: '学历' },
  { en: /\bdegree\b/gi, zh: '学位' },
  { en: /\bbachelor\b/gi, zh: '本科' },
  { en: /\bmaster\b/gi, zh: '硕士' },
  { en: /\bph\.?d\.?\b|\bdoctor\b/gi, zh: '博士' },
  { en: /\bcollege\b|\buniversity\b|\bschool\b|\binstitution\b/gi, zh: '学校' },
  { en: /\bmajor\b|\bspecialty\b|\bsubject\b/gi, zh: '专业' },
  { en: /\bgraduate\b|\bgraduation\b|\bgraduation\s*date\b/gi, zh: '毕业' },
  { en: /\binternship\b|\bintern\b/gi, zh: '实习' },
  // ===== 工作 =====
  { en: /\bwork(ing)?\s*(years?|experience|time)?\b|\bjob\s*experience\b|\byears?\s*of\s*experience\b|\bseniority\b/gi, zh: '工作年限' },
  { en: /\bjoin\s*(date|time)\b|\bstart\s*(date|time)\b|\bfirst\s*job\b/gi, zh: '参加工作时间' },
  { en: /\b(employment|job)\s*status\b|\bcurrently\s*employed\b|\bis\s*employed\b|\bworking\s*status\b/gi, zh: '是否在职' },
  { en: /\bjob\s*title\b|\bposition\b|\brole\b|\btitle\b|\bdesired\s*(position|job)\b|\btarget\s*(position|job)\b/gi, zh: '职位名称' },
  { en: /\bjob\s*category\b|\bposition\s*category\b|\bcategory\b|\bjob\s*type\b/gi, zh: '职位类别' },
  { en: /\bcompany\b|\bemployer\b|\borganization\b/gi, zh: '公司' },
  { en: /\bsalary\b|\bwage\b|\bcompensation\b/gi, zh: '薪资' },
  { en: /\bcurrent\s*salary\b|\bpresent\s*salary\b/gi, zh: '目前薪资' },
  { en: /\bexpected\s*salary\b|\bdesired\s*salary\b/gi, zh: '期望薪资' },
  // ===== 人员/状态 =====
  { en: /\bcandidate\b|\bapplicant\b|\bprospect\b/gi, zh: '候选人' },
  { en: /\bstatus\b|\bcurrent\s*status\b|\bcandidate\s*status\b/gi, zh: '状态' },
  { en: /\bpersonnel\s*type\b|\bemployee\s*type\b|\bcandidate\s*type\b/gi, zh: '人员类型' },
  // ===== 其他 =====
  { en: /\bremark\b|\bnotes?\b|\bcomment\b|\bother\b|\badditional\s*info(rmation)?\b/gi, zh: '备注' },
  { en: /\battachment\b|\battachments\b|\bupload\b|\bfile(s)?\b/gi, zh: '附件' },
  { en: /\bphoto\b|\bpicture\b|\bimage\b|\bavatar\b|\bportrait\b/gi, zh: '照片' },
];

// 把字段名里的英文关键词替换成中文。必须在 normKeyText 之前调用，
// 这样替换结果再去标点/小写化之后能和中文表头一起参与匹配
function enToZhKey(s) {
  let t = String(s || '');
  for (const { en, zh } of EN_KEYWORD_MAP) {
    t = t.replace(en, zh);
  }
  return t;
}

const normKeyText = (s) => enToZhKey(String(s || ''))
  .replace(/[*：:（）()【】\[\]\s\/\\·・、\-—_]/g, '')
  .toLowerCase();
const keyCore = (s) => normKeyText(s).replace(KEY_NOISE_PREFIX, '');

// 100 完全相同 / 90 去掉修饰词后相同 / 70+ 包含关系（被包含的词越长越可信）
function keyMatchScore(a, b) {
  const na = normKeyText(a), nb = normKeyText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  const ca = keyCore(a), cb = keyCore(b);
  if (ca && cb && ca === cb) return 90;
  const [s, l] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  if (s.length >= 2 && l.includes(s)) return 70 + Math.min(s.length, 5) * 2;
  return 0;
}

// 粘贴/Excel 里的字段名 → 页面已识别到的表头（找不到就返回原字段名）
function resolveFieldKey(rawKey) {
  const labels = pageFieldLabels();
  let best = null, second = 0;
  for (const l of labels) {
    const sc = keyMatchScore(rawKey, l);
    if (!best || sc > best.score) { second = best ? best.score : second; best = { label: l, score: sc }; }
    else if (sc > second) second = sc;
  }
  // 必须足够可信且明显优于第二名，防止两个相似字段之间乱猜
  if (best && best.score >= 74 && best.score - second >= 6) return best.label;

  let aliasBest = null;
  for (const { key, aliases } of PASTE_FIELD_ALIASES) {
    for (const a of [key, ...aliases]) {
      const sc = keyMatchScore(rawKey, a);
      if (sc >= 90 && (!aliasBest || sc > aliasBest.score)) aliasBest = { key, score: sc };
    }
  }
  return aliasBest ? aliasBest.key : rawKey;
}

// 页面表头缓存：一次填充会连续查十几个字段，避免反复全量扫描 DOM
let _labelCache = { at: 0, labels: [] };
function pageFieldLabels() {
  const now = Date.now();
  if (now - _labelCache.at < 1000) return _labelCache.labels;
  // scanPageLabels() 返回 { fields, diag }，不是数组
  _labelCache = { at: now, labels: (scanPageLabels().fields || []).map(f => f.label) };
  return _labelCache.labels;
}

function findControlByKey(key) {
  const cleanKey = key.replace(/[*：:]/g, '').trim();
  if (!cleanKey) return null;
  const dialog = getActiveDialog();
  const scopes = dialog ? [dialog, document] : [document];

  // 💡 增强：同时支持直接按英文字段名（如 resumeFile）匹配输入框或 wrapper
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

  // 模糊兜底：字段名与页面表头只是叫法不同（城市 / 所属城市 ↔ 所在城市）
  // 仅在最佳匹配足够可信、且明显优于次优项时才采用，避免两个相似字段之间乱填
  let best = null, second = 0;
  for (const l of pageFieldLabels()) {
    const sc = keyMatchScore(cleanKey, l);
    if (!best || sc > best.score) { second = best ? best.score : second; best = { label: l, score: sc }; }
    else if (sc > second) second = sc;
  }
  if (best && best.score >= 74 && best.score - second >= 6) {
    for (const labelScope of labelScopes) {
      const hit = findControlByLabel(labelScope, best.label);
      if (hit) return hit;
    }
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

async function fillFileInput(control, key, val, interval) {
  const base = control.element;
  const formItem = base.closest ? base.closest('.ant-form-item, .el-form-item, .ivu-form-item, .n-form-item') : null;
  const uploadWrap = base.closest ? base.closest('.ant-upload-wrapper, .el-upload, .ivu-upload, .n-upload') : null;

  const paths = String(val).split(/[,[,[,,;；、]/).map(p => p.trim()).filter(Boolean);
  const names = paths.map(p => p.split(/[\\\/]/).pop()).filter(Boolean);

  let input = null;
  if (base.tagName === 'INPUT' && base.type === 'file') { input = base; }
  for (const s of [uploadWrap, formItem].filter(Boolean)) {
    if (!input) { input = qS(s, 'input[type="file"]'); }
  }
  if (!input) input = qS(base, 'input[type="file"]') || qS(document, 'input[type="file"]');
  
  if (!input) {
    slog('Error', `附件字段「${key}」未找到原生 input[type=file]，转手动上传（控件 class: ${String(base.className || '').slice(0, 60)}）`);
    return { ok: false, manual: true, names, reason: '页面上没有可写入的文件输入框' };
  }

  // 附件仓库（侧边栏"选文件夹"加载到 chrome.storage.local），key 为文件名
  const attachRepo = await new Promise((resolve) => {
    try { chrome.storage.local.get('af_attachments', (r) => resolve(r.af_attachments || {})); }
    catch (e) { resolve({}); }
  });
  const repoSize = Object.keys(attachRepo).length;
  slog('Info', `附件字段「${key}」开始填充: Excel 值=${JSON.stringify(paths)}，附件仓库 ${repoSize} 个文件`);
  const repoHit = (baseName) => {
    if (!baseName) return null;
    if (attachRepo[baseName]) return attachRepo[baseName];
    const want = baseName.toLowerCase().replace(/\s+/g, '');
    for (const [k, v] of Object.entries(attachRepo)) {
      if (k.toLowerCase().replace(/\s+/g, '') === want) return v;
    }
    return null;
  };
  const files = [], meta = [], missing = [];
  for (const p of paths) {
    const baseName = p.split(/[\\\/]/).pop();
    // ① 优先：附件仓库按文件名匹配（真实二进制）
    const repo = repoHit(baseName);
    if (repo && repo.dataUrl) {
      const f = base64ToFile(repo.dataUrl.split(',')[1] || '', baseName, repo.type || guessMime(baseName));
      files.push(f);
      meta.push({ name: f.name, size: f.size, type: f.type });
      slog('Success', `附件「${baseName}」已从附件仓库匹配（${(f.size / 1024).toFixed(1)}KB）`);
      continue;
    }
    // ② 回退：background 读文件（完整路径 / 扩展 attachments 目录 / file:///）
    let r = await readFileViaBackground(p);
    if (!r.ok && /[\\\/]/.test(p)) r = await readFileViaBackground('attachments/' + baseName);
    if (!r.ok && !/[\\\/]/.test(p)) r = await readFileViaBackground('attachments/' + p);
    if (!r.ok && /^[A-Za-z]:[\\\/]/.test(p)) r = await readFileViaBackground('file:///' + p.replace(/\\/g, '/'));
    if (r.ok) {
      const f = base64ToFile(r.data, r.name || baseName, r.mime);
      files.push(f);
      meta.push({ name: f.name, size: f.size, type: f.type });
      slog('Success', `附件「${baseName}」已从路径读取（${(f.size / 1024).toFixed(1)}KB）`);
    } else {
      // 取不到真实文件时不造假文件（会把占位内容传到服务器），改为整项转手动上传
      slog('Warn', `附件「${baseName || p}」在附件仓库和本地路径都没读到，将转手动上传`);
      missing.push(baseName || p);
    }
  }

  if (!files.length) {
    slog('Warn', `附件字段「${key}」没取到任何真实文件，转手动上传（缺: ${missing.join('、') || '未知'}）`);
    return {
      ok: false, manual: true,
      names: names.length ? names : missing,
      reason: `附件仓库里没有：${missing.join('、') || '未知文件'}`
    };
  }

  // 部分文件缺失也转手动，避免服务器只收到一部分附件
  if (missing.length) {
    slog('Warn', `附件字段「${key}」缺少 ${missing.join('、')}，整项转手动上传`);
    return { ok: false, manual: true, names, reason: `附件仓库里没有：${missing.join('、')}` };
  }

  try {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    slog('Info', `附件字段「${key}」已塞入原生 input: ${files.length} 个文件`);
  } catch (e) {
    slog('Warn', `附件字段「${key}」设置 input.files 失败: ${e.message}，转手动上传`);
    return { ok: false, manual: true, names, reason: '无法写入文件输入框' };
  }

  await sleep(400);

  // 框架级直写兜底（DataTransfer 只触发原生 input，Vue Upload 的 fileList 不会自动更新）
  const r = await mainWorldSet(input || uploadWrap || base, { value: files[0].name, valueType: 'file', files: meta });
  if (r && r.ok) {
    slog('Success', `✅ 附件字段「${key}」框架直写成功 -> ${files.map(f=>f.name).join(',')} (${r.via})`);
    clearValidationErrors(formItem);
    await sleep(interval);
    return { ok: true, manual: false, names };
  }
  slog('Warn', `附件字段「${key}」框架直写未生效（文件已放入输入框但组件状态未同步），转手动上传: ${r && (r.error || JSON.stringify(r.diag || {}))}`);
  return { ok: false, manual: true, names, reason: '文件已放入但页面组件状态未同步' };
}

// ================= 手动保存等待（Excel 批量模式） =================
// 多条数据时不再自动点保存：逐条填入 → 用户在页面自己点「保存」→
// 用户在侧边栏点「已保存，下一条」后才继续，扩展不再自动判断页面是否保存成功
let saveWaiter = null;
let fillCancelled = false;   // 侧边栏点「暂停」时置位，让正在跑的填充循环立刻停下

function resolveManualSave(outcome) {
  if (!saveWaiter) return false;
  const w = saveWaiter;
  saveWaiter = null;
  clearInterval(w.timer);
  w.resolve(outcome);
  return true;
}

function waitForManualSave(index) {
  return new Promise((resolve) => {
    if (saveWaiter) resolveManualSave({ ok: false, reason: '已跳过本条' });
    // 不再轮询页面的成功提示/表单关闭/校验错误：
    // 那些信号在填充过程中也会误触发，会导致没等用户保存就跳到下一条。
    // 这里只挂起等待，由侧边栏 MANUAL_SAVE_RESOLVE（已保存，下一条 / 跳过本条）来结束。
    saveWaiter = { resolve, index };
  });
}

// ================= 主世界通信封装 =================
// 诊断日志：console + 侧边栏同步显示（排查附件填充问题不用开 DevTools）
function slog(type, text) {
  const line = `[AutoFill] ${text}`;
  if (type === 'Error') console.error(line); else if (type === 'Warn') console.warn(line); else console.log(line);
  try {
    chrome.runtime.sendMessage({ action: 'APPEND_LOG', log: { time: new Date().toTimeString().split(' ')[0], type, text } });
  } catch (e) { /* ignore */ }
}

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

async function clickChoiceControl(el, type, val, interval, fieldKey) {
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
    // 先把口语值归一到真实选项：是/在职 → 在职，否/离职 → 离职，男/男性 → 男
    const normalized = normalizeBooleanLikeValue(fieldKey, val);
    const mv = mapValue(normalized);
    const nv = normText(mv);
    for (const r of radios) {
      const wrapper = r.closest('.ivu-radio-wrapper, .ant-radio-wrapper, .el-radio, .n-radio, label') || r.parentElement;
      const label = wrapper ? wrapper.textContent.replace(/[*：:]/g, '').trim() : '';
      const ln = normText(label);
      // 兼容「男 / 男性」「是 / 是（在职）」这类 Excel 值与页面选项不完全一致的情况
      const hit = normText(r.value) === nv || ln === nv
        || (nv.length >= 2 && (ln.includes(nv) || nv.includes(ln)))
        || (ln.length >= 1 && nv.startsWith(ln));
      if (hit) {
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
    const targets = val.split(/[,[,[,,;；、]/)
      .map(v => mapValue(normalizeBooleanLikeValue(fieldKey, v.trim())))
      .filter(Boolean);
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

// 读取下拉当前显示的选中文本；空 / 占位符 返回 ''
function selectDisplayText(el) {
  if (!el) return '';
  try {
    const input = qS(el, 'input');
    const fromInput = input && input.value ? String(input.value).trim() : '';
    const labelNode = qS(el, '.ivu-select-selected-value, .el-select__selected-item, .ant-select-selection-item, .n-base-selection-label');
    const fromLabel = labelNode ? String(labelNode.textContent || '').trim() : '';
    const t = fromInput || fromLabel;
    if (!t || /^(请选择|请输入|select|placeholder)$/i.test(t)) return '';
    return t;
  } catch (e) { return ''; }
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
    return await clickChoiceControl(el, control.type, val, interval, key);
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
    // 策略：先不开面板，直接框架级直写（与 handlePasteQuickFill 里
    // 职位类别走的成功路径一致），避免「面板开着 Vue 不确认选中态」的问题。
    // mainWorldSet 失败后再打开面板 → 找 opt → realClick 兜底。
    let normalizedVals = [val];
    const norm = normalizeBooleanLikeValue(key, val);
    if (norm && norm !== val) normalizedVals.push(norm);
    const idNorm = normalizeIdType(val);
    if (idNorm && idNorm !== val && idNorm !== norm) normalizedVals.push(idNorm);
    const eduNorm = normalizeEdu(val);
    if (eduNorm && eduNorm !== val && eduNorm !== norm && eduNorm !== idNorm) normalizedVals.push(eduNorm);
    // 人员类型：扩展候选变体（normalizePersonType 返回数组，含原始值+多个同义词）
    if (/人员类型|用工性质|员工类型|候选人类型/.test(key)) {
      normalizedVals.push(...normalizePersonType(val));
    }
    normalizedVals = [...new Set(normalizedVals.filter(Boolean))];
    console.log(`[AutoFill-DBG] select ${key}: rawVal="${val}", normalizedVals=`, normalizedVals);

    for (const tryVal of normalizedVals) {
      const r = await mainWorldSet(el, { value: tryVal, valueType: 'select' });
      console.log(`[AutoFill-DBG] select ${key}: MAIN_WORLD_SET("${tryVal}") =>`, r);
      if (r && r.ok) {
        // 写入成功 ≠ 页面上真的选中：
        // 正式环境第一次粘贴时，值会被随后的框架初始化/回写冲掉（显示一下又清空），
        // 所以这里间隔检测两次，两次都有显示值才算成功，否则继续走面板点击兜底。
        await sleep(Math.max(interval, 250));
        const shown1 = selectDisplayText(el);
        await sleep(150);
        const shown2 = selectDisplayText(el);
        if (shown1 && shown2) {
          slog('Info', `✅ ${key} 已选中：${tryVal} (${r.via || 'vue3-select'})`);
          return true;
        }
        console.warn(`[AutoFill] ${key} 写入后显示被清空（${r.via || 'unknown'}），继续尝试下一个候选/兜底`);
      }
    }

    // 兜底：打开面板 → 找 opt → realClick(opt)
    console.log(`[AutoFill-DBG] select ${key}: emit 全挂，走 DOM 兜底（openPanel + realClick）`);
    const trigger = qS(el, 'input, .ant-select-selector, .ivu-select-selection, .el-select__caret, .el-input__inner') || el;
    const preSnap = snapPanels();
    realClick(trigger);
    const panel = await waitForPanel(preSnap) || findVisiblePanels()[0];
    if (panel) {
      const optSel = 'li, .ivu-select-item, .el-select-dropdown__item, [role="option"]';
      const allOpts = qSA(panel, optSel).filter(isVisible);
      console.log(`[AutoFill-DBG] select ${key}: panel 打开成功，option 数量=${allOpts.length}，样本=`, allOpts.slice(0, 5).map(o => o.textContent.trim()));
      let opt = null;
      for (const tryVal of normalizedVals) {
        opt = opt || findNodeByText(panel, optSel, tryVal);
      }
      // 数值 → 区间兜底：4年 / 4 / 4.5 → 3~5年；「一个月」→ 0.0833 → 1年以下
      if (!opt) {
        const num = parseNumberLike(val);
        console.log(`[AutoFill-DBG] select ${key}: text 匹配失败，parseNumberLike("${val}") => ${num}`);
        if (num !== null) opt = findOptionByNumber(panel, optSel, num);
      }
      if (opt) {
        console.log(`[AutoFill-DBG] select ${key}: 找到 option="${opt.textContent.trim()}"，realClick`);
        realClick(opt);
        realClick(document.body);
        await sleep(interval);
        // 验证一下点击后 DOM 显示是否正确
        const inputAfter = qS(el, 'input');
        const displayedAfter = (inputAfter && inputAfter.value) || (el.innerText || '').trim().slice(0, 40);
        console.log(`[AutoFill-DBG] select ${key}: realClick 后 displayed="${displayedAfter}"`);
        return true;
      }
      console.warn(`[AutoFill-DBG] select ${key}: 面板里没找到匹配的 option（text + number 两条路径都失败）`);
      realClick(document.body);
    } else {
      console.warn(`[AutoFill-DBG] select ${key}: openPanel 后没等到面板（waitForPanel + findVisiblePanels 都返回 null）`);
    }
    console.warn(`[AutoFill] Select 未找到选项: ${key}=${val}`);
    return false;
  }

  if (control.type === 'file') {
    return await fillFileInput(control, key, val, interval);
  }

  if (control.type === 'input') {
    const input = qS(el, 'input, textarea') || el;
    setNativeInputValue(input, val);
    await sleep(interval);
    return true;
  }

  return false;
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
  // 英文表头（Username or email address 之类）天然更长，中文表头一般不超过 12 字
  const maxLen = /[A-Za-z]/.test(txt) ? 40 : 12;
  if (txt.length < 2 || txt.length > maxLen) return false;
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

function scanPageLabelsIn(scope) {
  const fields = [];
  const seen = new Set();
  const usedEls = new Set(); // 已被绑定的控件，防止两个 label 抢同一个 input
  const push = (label, ctl, anchor) => {
    const t = cleanLabelText(label);
    if (!isValidHeader(t) || seen.has(t)) return;
    seen.add(t);
    if (ctl.element) usedEls.add(ctl.element);
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
    // 优先按 label[for] / label 内嵌控件精确绑定，避免相邻的两个输入框被识别成同一个
    let ctl = controlFromLabel(lbl);
    if (ctl && usedEls.has(ctl.element)) ctl = null;
    if (!ctl) {
      let cur = lbl.parentElement;
      for (let d = 0; d < 4 && cur && !ctl; d++) {
        const found = scanContainer(cur);
        if (found && !usedEls.has(found.element)) ctl = found;
        cur = cur.parentElement;
      }
    }
    if (ctl) { usedEls.add(ctl.element); push(t, ctl, lbl); }
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

// 扫描入口：优先只扫"可见的抽屉/弹窗"，扫不到再退回整页（避免被关闭的抽屉容器锁死范围）
function scanPageLabels() {
  const dialog = getActiveDialog();
  let scope = dialog || document;
  let fields = scanPageLabelsIn(scope);
  if (dialog && !fields.length) {
    scope = document;
    fields = scanPageLabelsIn(document);
  }

  const formSel = '.ant-form-item, .el-form-item, .ivu-form-item, .n-form-item, .form-group';
  const allItems = document.querySelectorAll(formSel);
  const diag = {
    url: location.href,
    dialog: !!dialog,
    scope: scope === document ? 'document' : 'dialog',
    formItems: allItems.length,
    visibleFormItems: Array.from(allItems).filter(isVisible).length,
    uploads: document.querySelectorAll('.ant-upload, .el-upload, .ivu-upload, input[type="file"]').length,
    iframes: document.querySelectorAll('iframe').length,
    bodyText: (document.body && document.body.textContent || '').replace(/\s+/g, '').slice(0, 40),
  };
  return { fields, diag };
}

// ================= 主流程 =================
const isAttachmentKey = (k) => /附件|作品|文件|材料|证明|简历|upload|file/i.test(String(k || ''));

// 上一条保存成功后页面上的新增表单会关闭，这里判断并自动重新打开
async function ensureRecordFormOpen(row) {
  if (isFormDrawerOpen()) return true;
  const keys = Object.keys(row)
    .map(k => String(k).replace(/[（(]\s*(禁用|只读|disabled)\s*[)）]/gi, '').replace(/[\r\n*：:]/g, '').trim())
    .filter(k => k && !k.startsWith('_') && k !== 'id')
    .slice(0, 6);
  // 内联表单（非抽屉/弹窗）没有新增界面，能直接定位到字段就算可用
  if (keys.some(k => findControlByKey(k))) return true;
  slog('Info', '当前页面没有打开的新增表单，尝试自动点击「新增」…');
  if (!(await clickPageAddButton())) return false;
  await sleep(600);
  return isFormDrawerOpen() || keys.some(k => findControlByKey(k));
}

async function handleAutoFill(row, interval = 300, fieldMapping, valueMapping, recordIndex = 0) {
  fillCancelled = false;
  FIELD_ALIAS = fieldMapping || {};
  VALUE_ALIAS = valueMapping || {};

  // 性别是必填项，但 Excel 里经常没有这一列：用身份证号第 17 位推导（奇男偶女）
  if (!row["性别"]) {
    const idNo = String(row["证件号码"] || row["身份证号码"] || row["身份证号"] || "").replace(/\s/g, "");
    if (/^\d{17}[\dXx]$/.test(idNo)) row["性别"] = Number(idNo.charAt(16)) % 2 === 1 ? "男" : "女";
  }

  // Excel 批量模式：表单可能已被上一条的保存操作关掉，先确保新增表单是打开的
  if (recordIndex >= 0 && !(await ensureRecordFormOpen(row))) {
    const msg = '未检测到已打开的新增表单，且自动点击「新增」失败，请手动打开新增表单后重试';
    slog('Error', msg);
    chrome.runtime.sendMessage({ action: "TASK_RESULT", success: false, reason: msg });
    return;
  }

  let matchedCount = 0;
  const skipped = [];
  const manualKeys = [];

  try {
    for (const [rawKey, value] of Object.entries(row)) {
      if (fillCancelled) break; // 用户点了「暂停」：不再继续写后面的字段
      let key = String(rawKey)
        .replace(/[（(]\s*(禁用|只读|disabled)\s*[)）]/gi, '')
        .replace(/[\r\n*：:]/g, '')
        .trim();
      if (key.startsWith('_') || key === 'id' || value === undefined || value === null || String(value).trim() === '') continue;
      if (FIELD_ALIAS[key]) key = FIELD_ALIAS[key];

      if (findVisiblePanels().length) { realClick(document.body); await sleep(150); }

      try {
        const control = findControlByKey(key);
        if (!control) {
          skipped.push(`${key}(未找到控件)`);
          // 附件类字段找不到控件时，把页面上的 upload 候选和表头文本打到侧边栏，便于排查
          if (isAttachmentKey(key)) {
            const ups = qSA(document, '.ant-upload, .el-upload, .ivu-upload, input[type="file"]').filter(isVisible);
            const titles = qSA(document, '.section-title, .attach-title, [class*="title"]')
              .map(n => cleanLabelText(n.textContent)).filter(t => t && t.length <= 14).slice(0, 10);
            slog('Warn', `字段「${key}」未找到控件。页面可见 upload 组件 ${ups.length} 个，标题候选: ${titles.join(' | ') || '(无)'}`);
            // 附件字段找不到控件也走手动兜底，不阻断整条记录
            manualKeys.push({ key, names: [] });
            matchedCount++;
          }
          continue;
        }
        const res = await fillControl(control, key, value, interval);
        const ok = (typeof res === 'object' && res !== null) ? res.ok : res;
        if (res && res.manual) {
          // 自动填附件失败 → 记为待手动上传，继续填完其余字段后再暂停等用户
          manualKeys.push({ key, names: res.names || [], reason: res.reason || '' });
          matchedCount++;
        } else if (ok) {
          matchedCount++;
        } else {
          skipped.push(`${key}(填充未生效)`);
        }
      } catch (e) {
        skipped.push(`${key}(异常)`);
        console.error(`[AutoFill] 字段 "${key}" 处理异常:`, e);
      }
    }

    if (fillCancelled) {
      slog('Warn', '已暂停，本条停止继续填充（已填内容保留在页面上）');
      chrome.runtime.sendMessage({ action: 'FILL_ABORTED', index: recordIndex });
      return;
    }

    if (skipped.length > 0) {
      console.warn(`[AutoFill] 未成功处理的字段: ${skipped.join('、')}`);
      // 同步到侧边栏：必填项没填上时，用户能直接看到是哪个字段
      slog('Warn', `${recordIndex >= 0 ? `第 ${recordIndex + 1} 条` : '粘贴录入'}未成功填充的字段: ${skipped.join('、')}`);
    }

    if (matchedCount === 0) throw new Error("未能匹配到任何有效字段，请检查 Excel 表头与网页标签是否一致");

    // 附件自动填充失败：不暂停，只提示用户在页面补传，随后一并等手动保存
    if (manualKeys.length) {
      const names = manualKeys
        .map(m => m.names && m.names.length ? `${m.key}(${m.names.join('、')})` : m.key)
        .join('、');
      slog('Warn', `${recordIndex >= 0 ? `第 ${recordIndex + 1} 条` : '粘贴录入'}附件需手动上传：${names}`);
    }

    await sleep(400);

    // 粘贴快速录入（recordIndex = -1）不自动点保存，由用户确认后手动保存
    if (recordIndex === -1) {
      slog('Info', '粘贴录入完成（不自动保存），请检查后手动点页面保存');
      return;
    }

    // Excel 批量模式：只填入不提交，等用户在页面点「保存」，并在侧边栏手动确认后才继续下一条
    slog('Info', `第 ${recordIndex + 1} 条已填入，请在页面点「保存」提交；确认保存成功后，在侧边栏点「已保存，下一条」`);
    const savePromise = waitForManualSave(recordIndex); // 先挂上等待器，避免侧边栏抢先点「已保存」时丢事件
    chrome.runtime.sendMessage({ action: 'AWAIT_MANUAL_SAVE', index: recordIndex });
    const saveRes = await savePromise;
    if (!saveRes.ok) throw new Error(saveRes.reason || '本条未保存');
    slog('Success', `第 ${recordIndex + 1} 条已手动确认保存，继续下一条`);

    chrome.runtime.sendMessage({ action: "TASK_RESULT", success: true });
  } catch (error) {
    chrome.runtime.sendMessage({ action: "TASK_RESULT", success: false, reason: error.message || "未知异常" });
  }
}

// ================= 消息监听 =================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 侧边栏注入检测：确认当前页面里 content script 存活
  if (request.action === "PING") {
    sendResponse({ ok: true, pong: true, href: location.href });
    return true;
  }

  if (request.action === "SCAN_PAGE_FORMS") {
    const { fields, diag } = scanPageLabels();
    sendResponse({ success: true, fields, labels: fields.map(f => f.label), diag });
  }

  if (request.action === "FILL_SINGLE_RECORD") {
    handleAutoFill(request.row, request.interval, request.fieldMapping, request.valueMapping, request.index || 0)
      .catch(err => console.error('[AutoFill] FILL_SINGLE_RECORD uncaught:', err));
  }

  // 后台被回收重启时用来确认：页面这里是否真的还在等用户点保存
  if (request.action === "IS_WAITING_SAVE") {
    sendResponse({ waiting: !!saveWaiter });
    return true;
  }

  // 侧边栏点「暂停」：中断正在进行的逐字段填充
  if (request.action === "CANCEL_FILL") {
    fillCancelled = true;
    sendResponse({ ok: true });
    return true;
  }

  // 侧边栏点「已保存，下一条」/「跳过本条」后，由后台转发这里结束本条等待
  if (request.action === "MANUAL_SAVE_RESOLVE") {
    sendResponse({ ok: resolveManualSave({ ok: request.ok !== false, reason: request.reason || '已手动标记保存成功' }) });
  }
  return true;
});

// ================= 粘贴快速录入 =================
// 用户粘贴文本 → 解析结构化 → 推荐岗位匹配/新增 → 点页面"新增"按钮 → 复用 handleAutoFill 填其余字段

// 粘贴文本里的各种说法 → 统一成页面表单字段 key
// 内部 key 就是页面 label 扫描出来的文字（如"候选人姓名"、"入职岗位"）
// aliases 覆盖粘贴文本可能出现的各种说法（编号、变体、省略）
const PASTE_FIELD_ALIASES = [
  // 推荐岗位（最核心，多个页面可能叫不同名）
  // 推荐岗位 → 页面字段名就是「职位名称」
  { key: '职位名称', aliases: [
    '推荐岗位', '岗位', '职位', '岗位名称', '职位名称', '推荐职位', '目标岗位',
    '入职岗位', '应聘岗位', '意向岗位', '期望岗位', '申请岗位', '投递岗位', '目标职位'
  ]},
  // 职位类别（下拉固定选项，粘贴值通常由"推荐岗位"拆分而来，也可直接粘贴）
  { key: '职位类别', aliases: ['职位类别', '岗位类别', '职位分类', '岗位分类', '职位大类', '职类'] },
  // 姓名
  { key: '姓名', aliases: ['姓名', '候选人', '求职者', '候选人姓名', '应聘人', '申请人'] },
  // 手机
  { key: '手机', aliases: ['电话', '手机', '手机号', '手机', '联系方式', '联系电话', 'Tel', 'tel'] },
  // 邮箱
  { key: '邮箱', aliases: ['邮箱', '电子邮箱', '电子邮件', 'E-Mail', 'Email', 'email', '邮箱地址'] },
  // 身份证号 → 证件号码（证件类型由号码自动推导为"居民身份证"）
  { key: '证件号码', aliases: [
    '身份证号', '身份证号码', '身份证', '证件号码', '证件号', 'ID', 'id',
    '护照号', '护照号码', '港澳通行证号', '通行证号', '驾照号', '驾驶证号',
    '台胞证号', '军官证号', '士兵证号', '警官证号', '户口本号', '社保号'
  ] },
  { key: '证件类型', aliases: [
    '证件类型', '证件类别', '证件类型(身份证)', '身份证件类型',
    '身份证', '居民身份证', '护照', '港澳通行证', '台胞证', '驾照', '驾驶证',
    '军官证', '士兵证', '警官证', '户口簿', '社保卡', '社会保障卡', '签证', '居住证'
  ] },
  // 岗位城市 → 所在城市
  { key: '所在城市', aliases: [
    '岗位城市', '所在城市', '城市', '工作地', '期望城市', '工作地点',
    '应聘城市', '意向城市', '求职城市', '目标城市'
  ]},
  // 学历背景 → 学历/学位（"统本"等口语值会归一成"本科"）
  { key: '学历/学位', aliases: [
    '学历背景', '学历/学位', '学历学位', '学历', '学位', '候选人学历', '最高学历',
    '教育背景', '文化程度'
  ]},
  // 工作年限
  { key: '工作年限', aliases: ['工作年限', '工龄', '工作几年', '几年经验', '工作经验年限'] },
  // 出生时间 / 参加工作时间（必填的日期字段，别名表里经常漏）
  { key: '出生时间', aliases: ['出生时间', '出生日期', '出生年月', '生日'] },
  { key: '参加工作时间', aliases: ['参加工作时间', '首次参加工作时间', '首次工作时间', '工作时间'] },
  // 国籍
  { key: '国籍', aliases: ['国籍', '国家/地区', '国家'] },
  // 人员类型 / 建议级别
  { key: '人员类型', aliases: ['人员类型', '员工类型', '候选人类型', '用工类型'] },
  { key: '供应商建议级别', aliases: ['供应商建议级别', '供应商级别', '建议级别', '推荐级别'] },
  // 推荐理由 / 个人评价
  { key: '推荐理由', aliases: ['推荐理由', '推荐说明', '备注', '说明', '个人评价', '个人简介', '自我描述'] },
  // 目前状态 / 是否在职
  { key: '是否在职', aliases: ['目前状态', '是否在职', '在职状态', '当前状态', '求职状态', '在离职', '状态'] },
  // 薪资范围
  { key: '薪资范围', aliases: ['目前薪资', '期望薪资', '薪资范围', '薪资', '薪酬', '期望薪酬', '目前工资', '工资'] },
  // 来源
  { key: '来源', aliases: ['来源', '推荐渠道', '渠道', '来源渠道'] },
  // 入职日期
  { key: '入职日期', aliases: ['入职日期', '到岗日期', '到岗时间', '可入职日期', '到岗时间'] },
  // 工作类型
  { key: '工作类型', aliases: ['工作类型', '雇佣类型', '合同类型', '用工方式'] },
  // 入职部门
  { key: '入职部门', aliases: ['入职部门', '部门', '应聘部门', '所属部门', '归属部门'] },
  // 职级 / 期望级别
  { key: '期望级别', aliases: ['期望级别', '职级', '级别', '岗位级别', '期望职级'] },
];

function parsePastedText(text) {
  const row = {};
  // 先按行拆，再每行剥掉编号前缀 "1. " "1、" "1）" "1)" "（1）" "①" 等
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const cleanLine = (l) => l.replace(/^(?:[（(]?\s*\d+\s*[)）.、]\s*|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十]+[.、)）])\s*/, '');

  for (const raw of lines) {
    const line = cleanLine(raw);
    if (!line) continue;

    let matched = false;

    // ① 证件号类字段（护照号/港澳通行证号/驾照号…）→ 同时派生「证件类型」和「证件号码」
    // 这一步必须在 PASTE_FIELD_ALIASES 之前，否则"护照号"会走通用兜底拿到错误字段名
    const idLine = line.match(/^(?:【|[（(])?\s*([^：:=]{1,20}?)\s*(?:[）)]|】)?\s*(?:[:：=]\s*|\s+)(.+)$/);
    if (idLine) {
      const rawField = idLine[1].trim();
      for (const rule of CITIZEN_ID_SPLIT_RULES) {
        if (rule.fieldRe.test(rawField)) {
          row['证件类型'] = rule.typeValue;
          row['证件号码'] = idLine[2].trim();
          matched = true;
          break;
        }
      }
    }
    if (matched) continue;

    for (const { key, aliases } of PASTE_FIELD_ALIASES) {
      for (const alias of aliases) {
        // "推荐岗位：值" / "推荐岗位=值" / "推荐岗位 值"
        // ⚠️ 别名和值之间必须有明确分隔符（冒号/等号/空格），
        // 否则短别名"岗位"会误吞"岗位城市: 北京" → 把"城市: 北京"当成职位名称
        const re = new RegExp(`^(?:【|[（(])?\\s*${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:[）)]|】)?\\s*(?:[:：=]\\s*|\\s+)(.+)$`, 'i');
        const m = line.match(re);
        if (m && m[1].trim()) {
          row[key] = m[1].trim();
          matched = true;
          break;
        }
      }
      if (matched) break;
    }

    if (!matched) {
      // 通用兜底：别名表里没有的「字段名：值」也保留，
      // 并先按页面表头/别名做一次核心词归一（所属城市 → 所在城市），换项目也不用改代码
      const gm = line.match(/^([^：:=]{1,20})\s*[:：=]\s*(.+)$/);
      if (gm && gm[2].trim()) {
        const rawKey = gm[1].replace(/^[【（(]|[】）)]$/g, '').trim();
        if (rawKey) {
          row[resolveFieldKey(rawKey)] = gm[2].trim();
          matched = true;
        }
      }
    }

    if (!matched) {
      // 没有字段名前缀：默认整行当作职位名称（粘贴最常见场景）
      // 排除两种假行：① 只有字段名没有值（"期望级别："）② 字段名：值 格式但别名没匹配上
      if (!row['职位名称'] && line.length >= 2 && line.length <= 60
        && !/[：:]$/.test(line) && !/^[^：:]{1,10}[：:]/.test(line)) {
        row['职位名称'] = line;
      }
    }
  }

  // 派生的页面字段：只有证件号码没有证件类型时，根据号码格式推导
  // 18位/15位数字 → 居民身份证；1位字母+7/8位数字 → 护照
  // 已有证件类型时（如粘贴里写了"护照号: xxx"）保持原值不动
  if (row['证件号码'] && !row['证件类型']) {
    const deduced = deduceIdTypeFromNumber(row['证件号码']);
    if (deduced) row['证件类型'] = deduced;
  }

  // 推荐岗位拆分："前端/后端开发工程师-抖音研发&QA日常运维" → 职位类别 + 职位名称
  // 页面上是两个字段：职位类别（下拉，固定选项）+ 职位名称（输入框，自由填写）
  if (row['职位名称'] && !row['职位类别']) {
    const m = row['职位名称'].split(/\s*[-—－]\s*/);
    if (m.length >= 2 && m[0] && m[1]) {
      row['职位类别'] = m[0].trim();
      row['职位名称'] = m.slice(1).join('-').trim();
    }
  }

  // 学历口语值归一：统本/统招本科/全日制本科 → 本科
  if (row['学历/学位']) row['学历/学位'] = normalizeEducation(row['学历/学位']);

  // 注意：人员类型不在 paste 阶段做替换式归一化，因为不同系统下拉 label 差异大
  // （有的叫「外包」有的叫「劳务派遣」），替换反而会让匹配失效
  // 归一化候选值由 select 分支 normalizedVals 动态生成

  // 附件类字段粘贴值无意义（文件不能靠文本填充），直接剔除，交由用户手动上传
  for (const k of Object.keys(row)) {
    if (/附件|作品|证明材料|照片|文件/.test(k)) delete row[k];
  }

  return row;
}

// 学历口语 → 页面下拉选项值
function normalizeEducation(v) {
  const s = String(v || '').trim();
  if (!s) return s;
  const rules = [
    [/博士/, '博士'],
    [/硕士|研究生/, '硕士'],
    [/统本|全日制本科|统招本科|本科/, '本科'],
    [/大专|专科|统专|专科/, '大专'],
    [/中专|高中/, '中专'],
  ];
  for (const [re, out] of rules) if (re.test(s)) return out;
  return s;
}

// 人员类型 / 用工性质口语 → 多个候选下拉 label 值
// 返回数组：原始值 + 各种变体，供 normalizedVals 全量尝试匹配
function normalizePersonType(v) {
  const s = String(v || '').trim();
  if (!s) return [];
  const out = [s]; // 保留原始值
  const add = (...xs) => { for (const x of xs) if (x && !out.includes(x)) out.push(x); };

  if (/正式(员工|工|编制)?|正编|正式编|全职|直接雇佣/.test(s)) add('正式员工', '正式编制', '全职');
  if (/实习|见习|学徒/.test(s)) add('实习生', '实习');
  if (/派遣|外包|外协|劳务派遣|人力外包|ODC/.test(s)) add('劳务派遣', '外包', '人力外包');
  if (/合同|合同制|固定期限|无固定期限/.test(s)) add('合同制', '固定期限');
  if (/兼职|兼职人员|part[\s-]?time/i.test(s)) add('兼职', '兼职人员');
  if (/顾问|咨询|外包顾问/.test(s)) add('顾问');
  if (/退休|返聘|退休返聘/.test(s)) add('退休返聘');
  if (/临时|临时工|短期/.test(s)) add('临时人员', '临时工');

  return out;
}

async function clickPageAddButton() {
  // 在页面上找"新增/添加/+"按钮并点击，触发新增表单展开（抽屉/弹窗）
  // 优先匹配明确文字（避免误点页面上其他"+"号）
  const strongPattern = /^(新增|添加|新建|发起|录入|提交推荐|新增岗位|添加岗位|新增候选人|添加候选人|新增推荐|添加推荐|新增简历|添加简历|新建候选人|添加.*候选人|新建.*候选人)/;
  const weakPattern = /^[+＋➕]$/;

  const candidates = qSA(document, 'button, a, [role="button"], span, div').filter(n => {
    if (!isVisible(n)) return false;
    const t = (n.textContent || '').trim();
    if (!t) return false;
    if (strongPattern.test(t)) return true;
    return false;
  });
  // 没找到明确文字的，最后才 fallback 到孤立的 "+" 号按钮（带 title 或 aria-label 也算）
  let target = candidates[0];
  if (!target) {
    const plusOnly = qSA(document, 'button, a, [role="button"], span, div').filter(n => {
      if (!isVisible(n)) return false;
      const t = (n.textContent || '').trim();
      if (!weakPattern.test(t)) return false;
      // "+" 号按钮要排除它在另一个文字按钮的内部
      const parentBtn = n.closest('button, [role="button"]');
      if (parentBtn && parentBtn !== n) {
        const parentText = (parentBtn.textContent || '').trim();
        if (parentText !== t) return false; // 父按钮有更多文字，跳过
      }
      return true;
    });
    plusOnly.sort((a, b) => (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight));
    target = plusOnly[0];
  }
  if (!target) {
    slog('Error', '未找到页面上的"新增/添加"按钮，请手动点击打开新增表单后再重试');
    return false;
  }
  slog('Info', `点击页面按钮展开新增表单："${(target.textContent || '').trim().slice(0, 30)}"`);
  realClick(target);
  // 抽屉/弹窗需要时间滑入 + DOM 挂载
  await sleep(1200);
  return true;
}

function setMarkerOnSelect(control) {
  // 给控件打 marker，返回 marker 值，让 MAIN_WORLD_SET 能通过 querySelector 定位
  const m = 'af' + Date.now() + Math.floor(Math.random() * 1000);
  try { control.element.setAttribute('data-autofill-marker', m); } catch (e) {}
  return m;
}

// 检测页面上是否已有可见的抽屉/弹窗表单（用户自己点开了新增界面时跳过插件自动点开）
function isFormDrawerOpen() {
  const selectors = '.ivu-drawer, .el-drawer, .ivu-modal, .el-dialog, .ant-drawer, .ant-modal, .n-drawer, .n-modal';
  const overlays = document.querySelectorAll(selectors);
  for (const n of overlays) {
    if (!isVisible(n)) continue;
    // 抽屉/弹窗要在 body 末尾且 form-item > 0（确认是"新增表单"而不是空壳）
    const items = n.querySelectorAll('.ivu-form-item, .el-form-item, .ant-form-item, .n-form-item, .ivu-row, .el-row');
    if (items.length >= 2) return true;
    // 或者里面有 input / select 控件
    const ctrls = n.querySelectorAll('input, select, textarea, .ivu-select, .el-select, .ant-select');
    if (ctrls.length >= 3) return true;
  }
  return false;
}

async function handlePasteQuickFill(pastedText, interval = 500) {
  if (_pasteShouldSkip(pastedText)) return;
  slog('Info', '开始粘贴快速录入...');
  const row = parsePastedText(pastedText);
  const jobKey = '职位名称';
  const parsedKeys = Object.keys(row);

  // 不再强制要求岗位字段：只贴部分字段（比如只有姓名/证件类型）也应该照常填。
  // 只有整段内容一个字段都解析不出来时才报错退出。
  if (parsedKeys.length === 0) {
    slog('Error', '粘贴内容未解析出任何字段，请按「字段名: 值」一行一个的格式填写');
    chrome.runtime.sendMessage({ action: 'APPEND_LOG', log: { time: new Date().toTimeString().split(' ')[0], type: 'Error', text: '粘贴内容未解析出任何字段' } });
    return;
  }
  if (!row[jobKey]) {
    slog('Warn', `未解析到岗位字段，跳过岗位选择，只填已解析的 ${parsedKeys.length} 个字段：${parsedKeys.join('、')}`);
  } else if (row['职位类别']) {
    slog('Info', `解析结果：职位类别="${row['职位类别']}"，职位名称="${row[jobKey]}"，共 ${parsedKeys.length} 个字段`);
  } else {
    slog('Info', `解析结果：职位名称="${row[jobKey]}"，共 ${parsedKeys.length} 个字段`);
  }

  const attachFields = ['简历附件', '个人作品'].filter(f => pastedText.includes(f));
  if (attachFields.length) {
    slog('Warn', `${attachFields.join('、')} 属于附件字段，需要手动上传，已跳过`);
  }

  const findJobCtl = () =>
    findControlByKey('职位名称') || findControlByKey('入职岗位') || findControlByKey('推荐岗位') ||
    findControlByKey('岗位') || findControlByKey('职位');

  // 用"已解析到的任意字段"定位表单，避免没有岗位字段时误判为"表单没打开"而重复点新增
  const anchorKeys = [jobKey, '职位类别', '姓名', '证件号码', '手机号', '邮箱', '所在城市', ...parsedKeys];
  const findAnchorCtl = () => {
    for (const k of anchorKeys) {
      const c = findControlByKey(k);
      if (c) return c;
    }
    return null;
  };

  // 1. 优先在当前页面直接定位（用户可能已经自己点开了新增表单）
  let rc = findAnchorCtl();
  if (!rc) {
    // 当前 DOM 里找不到，说明新增界面还没打开 → 插件自动点"新增"按钮
    const clickedAdd = await clickPageAddButton();
    if (!clickedAdd) {
      slog('Error', '未能打开新增表单，请手动打开后再粘贴重试');
      return;
    }
    // 抽屉展开后再定位一次
    rc = findAnchorCtl();
  } else {
    slog('Info', '检测到表单已打开，直接定位控件');
  }
  if (!rc) {
    slog('Error', '当前页面没找到可填写的表单控件，请手动打开新增表单后再粘贴');
    return;
  }

  if (row['职位类别']) {
    // 拆分场景：职位类别是下拉（固定/可搜索选项）走 select-or-create 链路，
    // 职位名称是输入框由 handleAutoFill 普通写入
    const catCtl = findControlByKey('职位类别') || findControlByKey('岗位类别') || findControlByKey('职类');
    if (catCtl) {
      slog('Info', `定位到职位类别下拉控件（type=${catCtl.type}）`);
      try {
        let catRes = await mainWorldSet(catCtl.element, { valueType: 'select', value: row['职位类别'] });
        if (catRes && catRes.ok) {
          slog('Success', `✅ 职位类别已选中：${row['职位类别']} (${catRes.via})`);
        } else {
          slog('Warn', '职位类别直写未生效，尝试搜索新增...');
          catRes = await mainWorldSet(catCtl.element, { action: 'select-or-create', valueType: 'select', value: row['职位类别'] });
          if (catRes && catRes.ok) slog('Success', `✅ 职位类别已设置（${catRes.matched ? '匹配已有' : '搜索新增'}）：${row['职位类别']}`);
          else slog('Warn', `职位类别自动选择未生效，请手动核对下拉值`);
        }
      } catch (e) {
        slog('Warn', `职位类别选择异常：${e.message}`);
      }
      // 已选好类别，从 row 里移除避免 handleAutoFill 重复填
      delete row['职位类别'];
    } else {
      slog('Warn', '未找到职位类别下拉控件，交由通用填充尝试');
    }
    slog('Info', '继续填充其余字段（职位名称输入框 + 基本信息等）...');
    await sleep(300);
    await handleAutoFill(row, interval, FIELD_ALIAS, VALUE_ALIAS, -1);
    slog('Success', '粘贴快速录入完成，请手动点页面保存');
    return;
  }

  if (row[jobKey]) {
    const jobCtl = findJobCtl();
    if (!jobCtl) {
      slog('Warn', '未找到职位名称控件，交由通用填充尝试');
    } else {
      slog('Info', `定位到职位名称下拉控件（type=${jobCtl.type}）`);
      // 3. 主世界直写 select（优先走已有选项）
      let selRes = null;
      try {
        selRes = await mainWorldSet(jobCtl.element, { valueType: 'select', value: row[jobKey] });
        if (selRes && selRes.ok) {
          slog('Success', `✅ 职位名称已选中：${row[jobKey]} (${selRes.via})`);
        } else {
          // 直写没生效，尝试搜索新增
          slog('Warn', `直写未生效，尝试搜索新增...`);
          selRes = await mainWorldSet(jobCtl.element, { action: 'select-or-create', valueType: 'select', value: row[jobKey] });
          if (selRes && selRes.ok) slog('Success', `✅ 职位名称已设置（${selRes.matched ? '匹配已有' : '搜索新增'}）：${row[jobKey]}`);
        }
      } catch (e) {
        slog('Warn', `职位名称选择异常：${e.message}`);
      }
    }
  }

  // 4. 复用 handleAutoFill 填剩余字段
  slog('Info', '继续填充其余字段...');
  await sleep(300);
  await handleAutoFill(row, interval, FIELD_ALIAS, VALUE_ALIAS, -1);
  slog('Success', '粘贴快速录入完成，请手动点页面保存');
}

// 侧边栏点"粘贴快速录入"按钮触发
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "PASTE_QUICK_FILL") {
    handlePasteQuickFill(request.text, request.interval || 500)
      .catch(err => console.error('[AutoFill] PASTE_QUICK_FILL uncaught:', err));
    sendResponse({ ok: true });
  }
  return false;
});