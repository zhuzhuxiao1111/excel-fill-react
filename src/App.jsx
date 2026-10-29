﻿import React, { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';

export default function App() {
  const [pageFields, setPageFields] = useState([]);
  const [dataset, setDataset] = useState([]);
  const [controlState, setControlState] = useState('就绪');
  const [intervalMs, setIntervalMs] = useState(300);
  const [logs, setLogs] = useState([{ time: '00:00:00', type: 'Sys', text: '右侧边栏智能填表助手已就绪' }]);
  const [hasFailed, setHasFailed] = useState(false);
  const [mapping, setMapping] = useState({ field: {}, value: {} });
  const logEndRef = useRef(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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

  const handleScanPage = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { action: "SCAN_PAGE_FORMS" }, (res) => {
        const fields = (res && res.fields) || [];
        if (fields.length > 0) {
          setPageFields(fields);
          const disabledCount = fields.filter(f => f.disabled).length;
          addLog('Sys', `成功识别当前网页表单，共 ${fields.length} 个字段${disabledCount ? `（其中 ${disabledCount} 个为禁用/只读）` : ''}`);
        } else {
          alert("未能识别到表单项，请确保当前页面是表单页并已刷新！");
        }
      });
    });
  };

  const handleDownloadTemplate = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { action: "SCAN_PAGE_FORMS" }, (res) => {
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
      const mF = Object.keys(fieldMapping).length, mV = Object.keys(valueMapping).length;
      addLog('Sys', `成功解析 Excel，加载 ${formatted.length} 条待录入记录${(mF || mV) ? `，映射: 字段${mF}条/值${mV}条` : ''}`);
      chrome.runtime.sendMessage({ action: "SET_DATASET", dataset: formatted, fieldMapping, valueMapping });
    };
    reader.readAsArrayBuffer(file);
  };

  const sendControl = (command) => {
    chrome.runtime.sendMessage({ action: "CONTROL_EXECUTION", command, intervalMs });
  };

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

  return (
    <div style={{ padding: '12px', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', background: '#f8fafc', minHeight: '100vh', boxSizing: 'border-box' }}>
      
      <div style={{ background: '#fff', borderRadius: '10px', padding: '12px', marginBottom: '12px', border: '1px solid #e2e8f0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#1e293b' }}>🔍 1. 当前页面表单识别</span>
          <button onClick={handleScanPage} style={{ background: '#4f46e5', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', fontWeight: 'bold' }}>
            扫描识别
          </button>
        </div>
        <div style={{ fontSize: '11px', color: '#64748b' }}>已识别控件/字段: {pageFields.length} 个</div>
        {pageFields.filter(f => f.disabled).length > 0 && (
          <div style={{ fontSize: '11px', color: '#b45309', marginTop: '4px', lineHeight: 1.5 }}>
            ⚠️ 禁用/只读字段（下载模板时表头会标注"(禁用)"）：{pageFields.filter(f => f.disabled).map(f => f.label).join('、')}
          </div>
        )}
      </div>

      <div style={{ background: '#fff', borderRadius: '10px', padding: '12px', marginBottom: '12px', border: '1px solid #e2e8f0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#1e293b' }}>📊 2. Excel 数据集 ({dataset.length}条)</span>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button 
              onClick={handleDownloadTemplate} 
              style={{ fontSize: '11px', color: '#059669', cursor: 'pointer', background: '#ecfdf5', border: '1px solid #a7f3d0', padding: '3px 8px', borderRadius: '4px', fontWeight: 'bold' }}
            >
              📥 下载导入模板
            </button>
            <label style={{ fontSize: '11px', color: '#2563eb', cursor: 'pointer', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '3px 8px', borderRadius: '4px', fontWeight: 'bold' }}>
              上传 Excel
              <input type="file" accept=".xlsx, .xls" onChange={handleFileUpload} style={{ display: 'none' }} />
            </label>
          </div>
        </div>

        <div style={{ maxHeight: '120px', overflowY: 'auto', border: '1px solid #f1f5f9', borderRadius: '6px' }}>
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
                <tr><td colSpan="3" style={{ textAlign: 'center', padding: '15px', color: '#94a3b8' }}>可先点击右上角“下载导入模板”填写数据后上传</td></tr>
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
      </div>

      <div style={{ background: '#fff', borderRadius: '10px', padding: '12px', marginBottom: '12px', border: '1px solid #e2e8f0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#1e293b' }}>⚙️ 3. 自动化录入控制台</span>
          <span style={{ fontSize: '11px', background: controlState === '执行中' ? '#dcfce7' : '#f1f5f9', color: controlState === '执行中' ? '#166534' : '#475569', padding: '2px 8px', borderRadius: '12px', fontWeight: 'bold' }}>
            {controlState}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <button onClick={() => sendControl('start')} style={{ background: '#10b981', color: '#fff', border: 'none', padding: '8px 0', borderRadius: '6px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}>开始执行</button>
          <button onClick={() => sendControl('pause')} style={{ background: '#f59e0b', color: '#fff', border: 'none', padding: '8px 0', borderRadius: '6px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}>暂停</button>
          <button onClick={() => sendControl('reset')} style={{ background: '#64748b', color: '#fff', border: 'none', padding: '8px 0', borderRadius: '6px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}>重置</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', background: '#f1f5f9', padding: '6px 10px', borderRadius: '6px' }}>
          <span style={{ fontSize: '11px', color: '#475569', whiteSpace: 'nowrap' }}>⏱ 操作间隔</span>
          <input
            type="number"
            min={50}
            max={5000}
            step={50}
            value={intervalMs}
            onChange={(e) => setIntervalMs(Math.max(50, Math.min(5000, Number(e.target.value) || 300)))}
            style={{ flex: 1, padding: '3px 6px', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '11px', width: '60px', textAlign: 'center', outline: 'none' }}
          />
          <span style={{ fontSize: '11px', color: '#64748b' }}>毫秒</span>
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
          <button onClick={downloadLogs} style={{ width: '100%', background: '#059669', color: '#fff', border: 'none', padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', marginBottom: '10px' }}>
            📥 导出未成功填写的记录表格
          </button>
        )}

        <div style={{ background: '#0f172a', borderRadius: '8px', padding: '10px', height: '120px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '10px', color: '#38bdf8' }}>
          <div style={{ color: '#64748b', marginBottom: '4px', borderBottom: '1px solid #1e293b', paddingBottom: '2px' }}>&gt;_ 实况日志 (Terminal)</div>
          {logs.map((log, idx) => (
            <div key={idx} style={{ marginBottom: '3px', wordBreak: 'break-all' }}>
              <span style={{ color: '#64748b' }}>[{log.time}]</span>{' '}
              <span style={{ color: log.type === 'Error' ? '#f87171' : log.type === 'Warn' ? '#fbbf24' : log.type === 'Success' ? '#4ade80' : '#cbd5e1' }}>
                [{log.type}] {log.text}
              </span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>

    </div>
  );
}