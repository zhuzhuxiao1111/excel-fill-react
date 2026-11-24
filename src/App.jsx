﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿import React, { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';

// 通用卡片组件（支持折叠）
// 必须定义在 App 外部：定义在组件内部会因每次渲染生成新组件类型而导致折叠状态被重置
function CardShell({ title, icon, defaultCollapsed = false, action = null, autoExpandKey = null, children }) {
  const [open, setOpen] = useState(!defaultCollapsed);
  // Excel 已导入 / 重新导入 / 进入执行时自动展开
  useEffect(() => {
    if (autoExpandKey) setOpen(true);
  }, [autoExpandKey]);
  return (
    <div style={{ background: '#fff', borderRadius: '10px', marginBottom: '12px', border: '1px solid #e2e8f0', overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', cursor: 'pointer', userSelect: 'none', background: '#fafbfc' }}
      >
        <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#1e293b' }}>
          {icon} {title}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }} onClick={(e) => e.stopPropagation()}>
          {action}
          <span style={{ color: '#94a3b8', fontSize: '12px', transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'rotate(0)' }}>›</span>
        </div>
      </div>
      {open && <div style={{ padding: '12px' }}>{children}</div>}
    </div>
  );
}

export default function App() {
  const [pageFields, setPageFields] = useState([]);
  const [dataset, setDataset] = useState([]);
  const [controlState, setControlState] = useState('就绪');
  const [intervalMs, setIntervalMs] = useState(300);
  const [logs, setLogs] = useState([{ time: '00:00:00', type: 'Sys', text: '右侧边栏智能填表助手已就绪' }]);
  const [hasFailed, setHasFailed] = useState(false);
  const [mapping, setMapping] = useState({ field: {}, value: {} });
  const [pasteText, setPasteText] = useState('');
  const [datasetVersion, setDatasetVersion] = useState(0);
  const logBoxRef = useRef(null);

  // 只滚动日志框自身，不要用 scrollIntoView（会把整个侧边栏滚到底部）
  useEffect(() => {
    const el = logBoxRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [logs]);

  useEffect(() => {
    chrome.runtime.sendMessage({ action: "GET_STATUS" }, (res) => {
      if (res) {
        if (res.dataset) setDataset(res.dataset);
        if (res.controlState) setControlState(res.controlState);
        if (res.hasFailed) setHasFailed(res.hasFailed);
        if (res.fieldMapping) setMapping({ field: res.fieldMapping, value: res.valueMapping });
      }
    });

    const listener = (msg) => {
      if (msg.action === "UPDATE_UI_STATE") {
        if (msg.dataset) setDataset(msg.dataset);
        if (msg.controlState) setControlState(msg.controlState);
        if (msg.hasFailed !== undefined) setHasFailed(msg.hasFailed);
      }
      if (msg.action === "APPEND_LOG") {
        setLogs(prev => [...prev.slice(-50), msg.log]);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      try { chrome.runtime.onMessage.removeListener(listener); } catch(e){}
    };
  }, []);

  const addLog = (type, text) => {
    const now = new Date().toTimeString().split(' ')[0];
    setLogs(prev => [...prev.slice(-50), { time: now, type, text }]);
  };

  // 向页面发消息；仅当"页面无接收端"（扩展重载后脚本失联）时自动注入再重试，避免业务消息被重复执行
  const sendToTab = (tabId, msg, cb) => {
    const once = (retried) => {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        const err = chrome.runtime.lastError;
        if (!err) { cb(res, null); return; }
        const noReceiver = /Receiving end does not exist|Could not establish connection/i.test(err.message || '');
        if (retried || !noReceiver) { cb(null, err.message); return; }
        chrome.runtime.sendMessage({ action: 'ENSURE_CONTENT', tabId }, (r) => {
          if (chrome.runtime.lastError || !r || !r.ok) {
            cb(null, (r && r.error) || err.message);
            return;
          }
          if (r.injected) addLog('Sys', '检测到页面脚本已失联，已自动注入（无需刷新页面）');
          setTimeout(() => once(true), 120);
        });
      });
    };
    once(false);
  };

  const handleScanPage = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;
      // 页面可能异步渲染表单，空结果时自动重试两次
      const attempt = (n) => {
        sendToTab(tabId, { action: 'SCAN_PAGE_FORMS' }, (res, err) => {
          if (err) {
            addLog('Error', `无法连接当前页面：${err}`);
            alert(`无法连接当前页面（${err}）\n请确认当前标签页是目标业务系统页面。`);
            return;
          }
          const fields = (res && res.fields) || [];
          if (fields.length > 0) {
            setPageFields(fields);
            const disabledCount = fields.filter(f => f.disabled).length;
            addLog('Sys', `成功识别当前网页表单，共 ${fields.length} 个字段${disabledCount ? `（其中 ${disabledCount} 个为禁用/只读）` : ''}`);
            return;
          }
          if (n < 2) { setTimeout(() => attempt(n + 1), 700); return; }
          const d = (res && res.diag) || {};
          addLog('Warn', `未识别到字段（表单容器 ${d.formItems || 0} 个，可见 ${d.visibleFormItems || 0} 个，附件控件 ${d.uploads || 0} 个，iframe ${d.iframes || 0} 个）`);
          if (d.iframes > 0) {
            alert('当前页面的表单可能在 iframe 里，插件无法直接读取。\n请在该 iframe 内的页面打开侧边栏后重试。');
          } else if (!d.formItems) {
            alert('当前页面没有检测到表单。\n如果表单在"新增"抽屉里，请先点页面上的"新增"按钮打开，再点扫描。');
          } else {
            alert(`检测到 ${d.formItems} 个表单项但都没解析出表头，请把侧边栏日志发我排查。`);
          }
        });
      };
      attempt(0);
    });
  };

  const handleDownloadTemplate = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      sendToTab(tabs[0].id, { action: 'SCAN_PAGE_FORMS' }, (res) => {
        let fields = (res && res.fields) || [];
        if (!fields.length && res && res.labels) fields = res.labels.map(l => ({ label: l, disabled: false }));
        if (!fields.length) {
          fields = ["姓名", "性别", "所在城市", "证件类型", "证件号码", "国籍", "手机号", "电子邮箱", "出生时间", "参加工作时间", "工作年限", "学历学位", "职位类别", "职位名称", "供应商建议级别", "人员类型", "是否在职", "简历附件", "个人作品", "推荐理由"]
            .map(l => ({ label: l, disabled: false }));
        }

        // 禁用字段：直接跟在表头后面标注，导入解析时会自动剥掉（不影响自动录入识别）
        const headers = fields.map(f => f.disabled ? `${f.label}(禁用)` : f.label);
        const ws = XLSX.utils.aoa_to_sheet([headers]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "数据录入");
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        // Windows 文件名不支持冒号，时分用 '-' 分隔：导入模板_2026-10-29 11-46.xlsx
        const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
        const fileName = `导入模板_${stamp}.xlsx`;
        XLSX.writeFile(wb, fileName);

        const disabledNames = fields.filter(f => f.disabled).map(f => f.label);
        addLog('Sys', `已生成模板 ${fileName}，共 ${headers.length} 个列标题`);
        if (disabledNames.length) {
          addLog('Sys', `⚠️ 页面上为禁用/只读的字段已在表头标注"(禁用)"：${disabledNames.join('、')}`);
        }
      });
    });
  };

  // 3. 💡 升级版：上传 Excel 并对所有键名进行严格的去空格清洗
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const data = new Uint8Array(event.target.result);
      const workbook = XLSX.read(data, { type: 'array', cellDates: true });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(worksheet, { raw: false });

      // 💡 核心清洗：剥离表头的"(禁用)"标注 + 去除空格、换行符等隐藏字符
      const cleanedJson = json.map(row => {
        const newRow = {};
        for (const [k, v] of Object.entries(row)) {
          const cleanKey = String(k)
            .replace(/[（(]\s*(禁用|只读|disabled)\s*[)）]/gi, '')
            .replace(/[\r\n*：:\s]/g, '')
            .trim();
          if (!cleanKey) continue;
          newRow[cleanKey] = v;
        }
        return newRow;
      });

      const fieldMapping = {}, valueMapping = {};
      const mapSheet = workbook.Sheets['映射'] || workbook.Sheets['mapping'] || workbook.Sheets['Mapping'];
      if (mapSheet) {
        const rows = XLSX.utils.sheet_to_json(mapSheet, { header: 1, raw: false });
        for (const r of rows) {
          const cells = (r || []).map(c => String(c ?? '').trim());
          if (cells.some(c => /^类型$|页面侧|Excel侧/i.test(c))) continue;
          if (cells.length >= 3 && cells[1] && cells[2]) {
            if (/^值$/i.test(cells[0])) valueMapping[cells[1]] = cells[2];
            else fieldMapping[cells[1]] = cells[2];
          } else if (cells.length === 2 && cells[0] && cells[1]) {
            fieldMapping[cells[0]] = cells[1];
          }
        }
      }
      
      const formatted = cleanedJson.map((item, idx) => ({
        id: idx + 1,
        ...item,
        _status: 'pending',
        _reason: ''
      }));

      setDataset(formatted);
      setMapping({ field: fieldMapping, value: valueMapping });
      setDatasetVersion(v => v + 1);
      const mF = Object.keys(fieldMapping).length, mV = Object.keys(valueMapping).length;
      addLog('Sys', `成功解析 Excel，加载 ${formatted.length} 条待录入记录${(mF || mV) ? `，映射: 字段${mF}条/值${mV}条` : ''}`);
      chrome.runtime.sendMessage({ action: "SET_DATASET", dataset: formatted, fieldMapping, valueMapping });
    };
    reader.readAsArrayBuffer(file);
  };

  const sendControl = (command) => {
    chrome.runtime.sendMessage({ action: "CONTROL_EXECUTION", command, intervalMs });
    // 重置同时清空已导入的 Excel 数据
    if (command === 'reset') {
      chrome.runtime.sendMessage({ action: "SET_DATASET", dataset: [], fieldMapping: {}, valueMapping: {} });
      setDataset([]);
      setMapping({ field: {}, value: {} });
    }
  };

  // 附件仓库功能暂时隐藏（手动上传兜底路径已够用，待后续恢复）
  // handleAttachmentSelect / handleClearAttachments 保留但不在 UI 展示

  const downloadLogs = () => {
    chrome.runtime.sendMessage({ action: "GET_FAILED_LOGS" }, (res) => {
      if (res && res.failedLogs && res.failedLogs.length > 0) {
        const cleanLogs = res.failedLogs.map(({ id, _status, ...rest }) => rest);
        const ws = XLSX.utils.json_to_sheet(cleanLogs);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "失败记录");
        XLSX.writeFile(wb, "未提交成功记录列表.xlsx");
      }
    });
  };

  // 通用卡片组件（支持折叠）
  const Card = CardShell;


  // 生成"按页面字段名"的粘贴模板，避免用户自己写字段名导致匹配不上
  const handleCopyTemplate = () => {
    const isAttach = (l) => /附件|作品|证明材料|照片|文件/.test(l);
    const build = (fields) => {
      const all = fields.map(f => f.label);
      const attach = all.filter(isAttach);
      const labels = all.filter(l => !isAttach(l));
      return {
        text: labels.map((l, i) => `${i + 1}.${l}：${l === '证件类型' ? '居民身份证' : ''}`).join('\n'),
        attach,
      };
    };
    const fallbackCopy = (text, done) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { addLog('Error', '复制失败，请手动选中复制'); }
      document.body.removeChild(ta);
    };
    const copy = ({ text, attach }) => {
      const done = () => {
        addLog('Sys', `已按当前页面表单复制字段模板（${text.split('\n').length} 个字段），粘贴后只需补值即可`);
        if (attach.length) addLog('Warn', `模板已排除附件字段（需在页面上手动上传）：${attach.join('、')}`);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      } else {
        fallbackCopy(text, done);
      }
    };
    // 模板始终按「当前页面表单」实时提取，切换模块/换页面后也不会用旧字段
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      sendToTab(tabs[0].id, { action: 'SCAN_PAGE_FORMS' }, (res) => {
        const fields = (res && res.fields) || [];
        if (!fields.length) {
          addLog('Warn', '未识别到页面表单字段，请先点页面「新增」打开表单后再复制模板');
          return;
        }
        setPageFields(fields);
        copy(build(fields));
      });
    });
  };

  return (
    <div style={{ padding: '12px', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', background: '#f8fafc', minHeight: '100vh', boxSizing: 'border-box' }}>

      {/* ======== 1. 扫描识别（第一步，默认展开） ======== */}
      <Card title="当前页面表单识别" icon="🔍" defaultCollapsed={false}
        action={<button onClick={handleScanPage} style={{ background: '#4f46e5', color: '#fff', border: 'none', padding: '3px 8px', borderRadius: '4px', fontSize: '10px', cursor: 'pointer', fontWeight: 'bold' }}>扫描</button>}
      >
        <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '4px' }}>已识别控件/字段: <b>{pageFields.length}</b> 个</div>
        {pageFields.filter(f => f.disabled).length > 0 && (
          <div style={{ fontSize: '11px', color: '#b45309', lineHeight: 1.5 }}>
            ⚠️ 禁用/只读字段：{pageFields.filter(f => f.disabled).map(f => f.label).join('、')}
          </div>
        )}
        {pageFields.length === 0 && (
          <div style={{ fontSize: '11px', color: '#94a3b8' }}>点击右上角"扫描"识别当前页面表单字段（打开新增抽屉后扫描效果最佳）</div>
        )}
      </Card>

      {/* ======== 2. 粘贴快速录入（第二步） ======== */}
      <div style={{ background: '#fff', borderRadius: '10px', padding: '12px', marginBottom: '12px', border: '1px solid #e2e8f0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#1e293b' }}>📋 粘贴快速录入</span>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              onClick={() => setPasteText('')}
              disabled={!pasteText}
              style={{ fontSize: '10px', color: pasteText ? '#64748b' : '#cbd5e1', background: '#f8fafc', border: '1px solid #e2e8f0', padding: '3px 8px', borderRadius: '4px', cursor: pasteText ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}
            >
              清空
            </button>
            <button
              onClick={handleCopyTemplate}
              style={{ fontSize: '10px', color: '#2563eb', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '3px 8px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              复制模板
            </button>
          </div>
        </div>
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder="先点右上角「复制模板」按页面字段名生成，再补值：&#10;1.姓名：张三&#10;2.证件号码：610526200006034163&#10;3.职位名称：前端开发工程师"
          style={{ width: '100%', minHeight: '70px', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '11px', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box', outline: 'none' }}
        />
        <button
          disabled={!pasteText.trim() || controlState === '执行中' || controlState === '等待保存'}
          onClick={() => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (!tabs[0]) return;
              sendToTab(tabs[0].id, { action: 'PASTE_QUICK_FILL', text: pasteText, interval: intervalMs }, (_, err) => {
                if (err) addLog('Error', `无法连接当前页面：${err}`);
              });
            });
          }}
          style={{ width: '100%', marginTop: '6px', background: pasteText.trim() && controlState !== '执行中' && controlState !== '等待保存' ? '#4f46e5' : '#cbd5e1', color: '#fff', border: 'none', padding: '8px 0', borderRadius: '6px', fontSize: '11px', fontWeight: 'bold', cursor: pasteText.trim() && controlState !== '执行中' && controlState !== '等待保存' ? 'pointer' : 'not-allowed' }}
        >
          🚀 粘贴并自动录入（填完后请手动点页面保存）
        </button>
      </div>

      {/* ======== 3. Excel 批量数据集（默认折叠，导入后自动展开） ======== */}
      <Card title={`Excel 批量数据集 (${dataset.length}条)`} icon="📊" defaultCollapsed={true} autoExpandKey={datasetVersion || dataset.length || null}
        action={
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              onClick={handleDownloadTemplate}
              style={{ fontSize: '10px', color: '#059669', cursor: 'pointer', background: '#ecfdf5', border: '1px solid #a7f3d0', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold' }}
            >📥 模板</button>
            <label style={{ fontSize: '10px', color: '#2563eb', cursor: 'pointer', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold' }}>
              上传
              <input type="file" accept=".xlsx, .xls" onChange={handleFileUpload} style={{ display: 'none' }} />
            </label>
          </div>
        }
      >
        <div style={{ maxHeight: '150px', overflowY: 'auto', border: '1px solid #f1f5f9', borderRadius: '6px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: '#f8fafc', color: '#64748b', position: 'sticky', top: 0 }}>
                <th style={{ padding: '6px' }}>#</th>
                <th style={{ padding: '6px' }}>预览内容</th>
                <th style={{ padding: '6px' }}>状态</th>
              </tr>
            </thead>
            <tbody>
              {dataset.length === 0 ? (
                <tr><td colSpan="3" style={{ textAlign: 'center', padding: '12px', color: '#94a3b8', fontSize: '11px' }}>暂无数据，可点右上角"模板"下载空表，填好后"上传"</td></tr>
              ) : (
                dataset.map((row, idx) => {
                  const firstKey = Object.keys(row).find(k => !k.startsWith('_') && k !== 'id') || '数据';
                  return (
                    <tr key={idx} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '6px', color: '#64748b' }}>{row.id}</td>
                      <td style={{ padding: '6px', color: '#334155', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(row[firstKey] || '')}</td>
                      <td style={{ padding: '6px' }}>
                        {row._status === 'success' && <span style={{ color: '#10b981', background: '#ecfdf5', padding: '2px 6px', borderRadius: '4px', fontSize: '10px' }}>成功</span>}
                        {row._status === 'fail' && <span style={{ color: '#ef4444', background: '#fef2f2', padding: '2px 6px', borderRadius: '4px', fontSize: '10px' }} title={row._reason}>失败</span>}
                        {row._status === 'pending' && <span style={{ color: '#64748b', background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px', fontSize: '10px' }}>待填</span>}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ======== 4. 自动化批量执行（默认展开，有手动等待时自动展开） ======== */}
      <Card title="自动化批量执行" icon="⚙️" defaultCollapsed={false} autoExpandKey={controlState === '就绪' ? null : controlState}
        action={<span style={{ fontSize: '11px', background: controlState === '执行中' ? '#dcfce7' : controlState === '等待保存' ? '#ffedd5' : '#f1f5f9', color: controlState === '执行中' ? '#166534' : controlState === '等待保存' ? '#9a3412' : '#475569', padding: '2px 8px', borderRadius: '12px', fontWeight: 'bold' }}>
          {controlState}
        </span>}
      >

        {controlState === '等待保存' && (() => {
          const row = dataset.find(d => d._status === 'pending');
          return (
            <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '6px', padding: '8px', marginBottom: '8px' }}>
              <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#1d4ed8', marginBottom: '6px', lineHeight: 1.5 }}>
                ✍️ 第 {row ? row.id : '-'} 条已填入，请在页面补传附件并点「保存」，确认保存成功后点下方「已保存，下一条」
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                <button onClick={() => chrome.runtime.sendMessage({ action: 'MANUAL_SAVE_CONTINUE' })} style={{ background: '#10b981', color: '#fff', border: 'none', padding: '5px 0', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}>
                  已保存，下一条
                </button>
                <button onClick={() => chrome.runtime.sendMessage({ action: 'MANUAL_SAVE_SKIP' })} style={{ background: '#fff', color: '#b45309', border: '1px solid #fed7aa', padding: '5px 0', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}>
                  跳过本条
                </button>
              </div>
            </div>
          );
        })()}

        <div style={{ display: 'grid', gridTemplateColumns: controlState === '等待保存' ? '1fr' : '1fr 1fr', gap: '6px', marginBottom: '8px' }}>
          {controlState === '执行中' ? (
            <button onClick={() => sendControl('pause')} style={{ background: '#f59e0b', color: '#fff', border: 'none', padding: '7px 0', borderRadius: '6px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}>暂停</button>
          ) : controlState === '等待保存' ? (
            <button onClick={() => sendControl('reset')} style={{ background: '#64748b', color: '#fff', border: 'none', padding: '7px 0', borderRadius: '6px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}>结束本次执行</button>
          ) : (
            <button onClick={() => sendControl('start')} style={{ background: '#10b981', color: '#fff', border: 'none', padding: '7px 0', borderRadius: '6px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}>
              {controlState === '暂停' ? '继续执行' : '开始执行'}
            </button>
          )}
          {controlState !== '等待保存' && (
            <button onClick={() => sendControl('reset')} style={{ background: '#64748b', color: '#fff', border: 'none', padding: '7px 0', borderRadius: '6px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}>重置</button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', background: '#f1f5f9', padding: '5px 8px', borderRadius: '6px' }}>
          <span style={{ fontSize: '11px', color: '#475569', whiteSpace: 'nowrap' }}>⏱ 间隔</span>
          <input
            type="number"
            min={50}
            max={5000}
            step={50}
            value={intervalMs}
            onChange={(e) => setIntervalMs(Math.max(50, Math.min(5000, Number(e.target.value) || 300)))}
            style={{ flex: 1, padding: '3px 6px', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '11px', width: '60px', textAlign: 'center', outline: 'none' }}
          />
          <span style={{ fontSize: '11px', color: '#64748b' }}>ms</span>
          <div style={{ display: 'flex', gap: '3px' }}>
            {[200, 500, 1000, 2000].map(v => (
              <button
                key={v}
                onClick={() => setIntervalMs(v)}
                style={{
                  fontSize: '10px',
                  padding: '2px 5px',
                  border: intervalMs === v ? '1px solid #4f46e5' : '1px solid #cbd5e1',
                  background: intervalMs === v ? '#4f46e5' : '#fff',
                  color: intervalMs === v ? '#fff' : '#475569',
                  borderRadius: '3px',
                  cursor: 'pointer'
                }}
              >{v}</button>
            ))}
          </div>
        </div>

        {hasFailed && (
          <button onClick={downloadLogs} style={{ width: '100%', fontSize: '10px', color: '#059669', background: '#ecfdf5', border: '1px solid #a7f3d0', padding: '5px 0', borderRadius: '4px', fontWeight: 'bold', cursor: 'pointer', marginBottom: '8px' }}>
            📥 导出未成功记录
          </button>
        )}

        <div ref={logBoxRef} style={{ background: '#0f172a', borderRadius: '8px', padding: '8px', height: '96px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '10px', color: '#38bdf8' }}>
          <div style={{ color: '#64748b', marginBottom: '4px', borderBottom: '1px solid #1e293b', paddingBottom: '2px' }}>&gt;_ 实时日志</div>
          {logs.map((log, idx) => (
            <div key={idx} style={{ marginBottom: '3px', wordBreak: 'break-all' }}>
              <span style={{ color: '#64748b' }}>[{log.time}]</span>{' '}
              <span style={{ color: log.type === 'Error' ? '#f87171' : log.type === 'Warn' ? '#fbbf24' : log.type === 'Success' ? '#4ade80' : '#cbd5e1' }}>
                [{log.type}] {log.text}
              </span>
            </div>
          ))}
        </div>
      </Card>

    </div>
  );
}