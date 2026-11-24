# Debug Session: paste-double-select-reset

**Created:** 2026-11-13
**PROJECT_ROOT:** `d:\project\excel-fill-react`
**Evidence Source:** Chrome DevTools Console（所有日志均带 `[DEBUG-PDR]` 前缀）

---

## 🔧 用户操作指南（复制给用户）

### 我需要你做什么

1. **重新加载扩展**
   - Chrome 地址栏输入 `chrome://extensions` 回车
   - 找到「自动化助手 / Excel Fill」扩展卡片
   - 点击卡片上的 **🔄 重新加载** 按钮

2. **刷新目标页面**（⚠️ 这一步很关键，否则新 content script 不会注入）
   - 回到你平时用的那个业务页面
   - 按 `Ctrl + F5` 强制刷新
   - 或者关闭这个标签页重新打开

3. **打开 Console**
   - 在目标页面按 `F12`
   - 点顶部的 **Console** 标签
   - 在 Console 顶部的过滤输入框里输入：`DEBUG-PDR`
     （这样会只显示调试日志，业务日志全隐藏）

4. **复现问题**
   - 点页面的「新增」按钮，让表单抽屉出来
   - 执行一次粘贴快速录入（和你平时一样）
   - 等表单填完后，去 Console 看日志

5. **把日志发给我**
   - 在 Console 区域右键 → "Save as..." 保存成文件发给我
   - 或者按 `Ctrl + A` 全选 Console 里的所有 `DEBUG-PDR` 行 → 复制粘贴回我
   - 截图也行，要保证能看到每一行的完整内容

### 你会在 Console 里看到什么

所有日志都以 `[DEBUG-PDR]` 开头，大概长这样：

```
[DEBUG-PDR] chrome.onMessage 收到 PASTE_QUICK_FILL { instanceId: "a3f9c1", tabId: 123 }
[DEBUG-PDR] PASTE_QUICK_FILL 入口 { instanceId: "a3f9c1", traceId: "paste-a3f9c1-1731421234567", pastedLen: 240, pastedPreview: "姓名：张三\n邮箱：..." }
[DEBUG-PDR] handleAutoFill 入口 { instanceId: "a3f9c1", recordIndex: -1, rowKeys: ["姓名","邮箱","工作年限","学历",...], rowSnapshot: {...} }
[DEBUG-PDR] select 打开面板前 { instanceId: "a3f9c1", key: "工作年限", val: "4年", elType: "ant-select", preInnerText: "", preValue: "no-input" }
[DEBUG-PDR] select 找到 opt { instanceId: "a3f9c1", key: "工作年限", val: "4年", picked: "3~5年", innerVal: "3-5y", optAttrs: {...} }
[DEBUG-PDR] mainWorldSet 返回 { instanceId: "a3f9c1", key: "工作年限", tryVal: "3-5y", r: { ok: true, via: "antd-form-store" }, afterInner: "3~5年", afterInputVal: "no-input", errClass: "" }
[DEBUG-PDR] 填充前所有 select snapshot { instanceId: "a3f9c1", currentKey: "工作年限", beforeSelects: { "工作年限": "(empty)", "学历": "(empty)", ... } }
[DEBUG-PDR] 填充后所有 select snapshot { instanceId: "a3f9c1", currentKey: "工作年限", ok: true, afterSelects: { "工作年限": "3~5年", "学历": "(empty)", ... }, changedSelects: { "工作年限": "(empty) → 3~5年" } }
...
```

### 注意事项

- 如果 Console 里**一条 `DEBUG-PDR` 都没有**，说明扩展没重新加载成功，回到步骤 1 重新来
- 过滤输入框要写准确：`DEBUG-PDR`，没有空格、没有引号
- 按 F12 后 Console 标签可能默认是隐藏的，要手动点一下顶部菜单里的 Console

---

## 🧪 假设验证表（拿到日志后 Agent 对照判定）

### 症状 1：粘贴走两次

| ID | 假设 | 日志信号 | 判定 |
|---|---|---|---|
| A1 | chrome.runtime.onMessage 被触发两次 | 两条「chrome.onMessage 收到 PASTE_QUICK_FILL」，同一 tabId | CONFIRMED |
| A2 | content script 注入了两份 | 两条「PASTE_QUICK_FILL 入口」，**不同的 instanceId** | CONFIRMED |
| A3 | paste 文本含换行导致 parsePastedText 走两行 | 两条不同 rowKeys 的「handleAutoFill 入口」，同一 instanceId | CONFIRMED |
| A0 | 正常（只有一条完整链路） | 只有一套 instanceId 的日志 | REJECTED |

### 症状 2：select 填完又清空

| ID | 假设 | 日志信号 | 判定 |
|---|---|---|---|
| B1 | mainWorldSet 成功但框架 watcher 重置 | `mainWorldSet 返回` 里 `r.ok=true`，但 `afterInner` 已是 placeholder / 空 | CONFIRMED |
| B2 | click body 关面板触发 blur 重置 | `mainWorldSet 返回` 里 `afterInner` 正确，但后续的 snapshot 里值变空 | CONFIRMED |
| B3 | 值格式不匹配导致 mainWorldSet 全失败 | 所有 tryVal 都返回 `ok=false`，最终走 realClick 分支 | CONFIRMED |
| B4 | 填充顺序：后面的字段触发框架重新渲染冲掉前面的值 | 工作年限填完 snapshot 正确，填**学历**（或其他字段）后的 snapshot 里工作年限已空 | CONFIRMED |
| B5 | 正常 | snapshot 链路里每个字段填完都保持正确 | REJECTED |

---

## Agent Notes

- 当前 evidence source 是 Console，无需 HTTP debug server
- instrumentation 全部在 `#region debug-point X:Y` / `#endregion` 包裹里，修复完后整段删除
- 拿到用户日志后先跑一遍上面的验证表，再做最小修复
