// 点击插件图标自动在右侧展开侧边栏
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

