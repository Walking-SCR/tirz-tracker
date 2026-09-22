# Tirz Tracker iPhone 17 Pro Max 设计实现方案 V6

![iPhone 17 Pro Max 首页](./tirz-tracker-iphone17-promax-v4.png)

![V6 交互状态总览](./tirz-tracker-iphone17-promax-interactions-v6.png)

## 1. 实现目标与边界

在不改变单页产品结构的前提下，将首页、体重 CRUD、照片凭证、疗程 CRUD、账号认证、云端同步和系统反馈统一到 V5 视觉体系。

设计基准为 iPhone 17 Pro Max，物理分辨率 `1320 × 2868px`，实现时按约 `440 × 956 CSS px` 规划，并始终以运行时 `100dvh` 和安全区变量为准。

参考：[Apple iPhone 17 Pro Max 技术规格](https://support.apple.com/en-au/125091)、[Apple HIG Layout](https://developer.apple.com/design/human-interface-guidelines/layout)。

## 2. 当前实现审计

### 已存在并可复用

- 体重 `GET / POST / PATCH / DELETE` 后端接口。
- 给药 `GET / POST / DELETE` 后端接口。
- Gemini 图片识别、20 秒客户端超时、HEIC/HEIF 回退。
- 相册、相机、手动补录、称重确认表单。
- 本地缓存、自动同步、手动刷新、登录、设备绑定和退出。
- 照片替换请求、删除确认、Toast 和 PWA 安装提示。
- 客户端 20 秒识别超时和 HEIC/HEIF 回退处理。

### 需要补齐

1. `photoViewerModal` 仅有 JS 调用，没有对应 HTML 结构。
2. 体重 PATCH 后端支持字段修改，但前端 Adapter 只提供 `updateRecordPhoto()`。
3. 疗程 API 已有新增和删除，但页面没有新增、详情和删除交互。
4. 疗程缺少 PATCH 接口，无法真正完成修改。
5. `doseModal` 被生命周期代码引用，但页面中没有实现。
6. 趋势尚未实现累计、近 7 天、近 1 个月切换。
7. 同步失败状态主要依赖 Toast，缺少可持续的待同步与重试状态。
8. 确认称重弹层没有“更换图片”、图片来源选择和完整的识别/上传异常恢复设计。
9. 首次给药没有用药间隔配置，无法可靠计算下一次给药日期。

## 3. DOM 与组件改造

### 3.1 首页组件

保留关键业务 ID，新增语义化容器：

```text
#appHeader
#metricsSummary
#trendSection
#trendRangeAll / #trendRange7d / #trendRange1m
#btnRecordToday
#btnManualAdd
#treatmentTimeline
#recordsListContainer
```

模块顺序严格为指标、趋势、主按钮、疗程时间轴、记录明细。`btnManualAdd` 保留，改为主按钮下方的次级文字入口。

### 3.2 弹层组件

| 组件 | 建议 ID | 形态 |
| --- | --- | --- |
| 照片来源选择 | `photoSourceSheet` | 底部 Action Sheet |
| 称重新增/确认 | 保留 `confirmModal` | 底部弹层 |
| 称重异常恢复 | `recognitionErrorState` | 确认弹层内行内错误 |
| 编辑体重 | `editRecordModal`，或复用 `confirmModal` 模式 | 底部弹层 |
| 照片查看 | 补齐 `photoViewerModal` | 全屏查看器 |
| 删除确认 | 保留 `customConfirmModal` | 居中紧凑确认框 |
| 记录给药 | 补齐 `doseModal` | 首次配置/后续记录底部弹层 |
| 疗程设置 | `doseScheduleSheet` | 底部弹层 |
| 给药详情 | `doseDetailModal` | 底部弹层 |
| 账号与同步 | 保留 `sessionInfoModal` | 底部弹层 |
| 登录验证 | 保留 `authModal` | 居中安全弹层 |
| 设备绑定 | 保留 `deviceSetupModal` | 居中安全弹层 |

建议以一个通用 `.app-sheet` 和 `.app-dialog` 样式族实现，避免每个弹层复制视觉类。

### 3.3 通用弹层骨架

```html
<div class="app-overlay hidden" data-modal-root>
  <section class="app-sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
    <header class="app-sheet__header">
      <h2 id="sheetTitle"></h2>
      <button class="icon-button" aria-label="关闭"></button>
    </header>
    <div class="app-sheet__body"></div>
    <footer class="app-sheet__actions"></footer>
  </section>
</div>
```

移动端底部对齐，桌面端宽度限制为 `420px` 并居中。表单弹层最大高度：

```css
.app-sheet {
  max-height: calc(100dvh - env(safe-area-inset-top, 0px) - 24px);
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 16px);
}
```

## 4. 首页实现

### 4.1 安全区

```css
body {
  min-height: 100dvh;
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 24px);
}

.app-header {
  padding-top: calc(env(safe-area-inset-top, 0px) + 8px);
}
```

不要固定写死 Dynamic Island 高度。Toast 顶部位置使用 `safe-area-inset-top + 12px`。

### 4.2 趋势范围

新增页面状态：

```js
let trendRange = 'all';
```

过滤规则：

- `all`：第一条有效记录至最新记录。
- `7d`：当前时间向前 7 个自然日。
- `1m`：当前时间向前 1 个自然月。

首次进入、刷新或重新打开均恢复 `all`。切换只更新 Chart.js 数据，不销毁 Canvas，不修改原始记录。

### 4.3 双行记录卡

`renderRecordsList()` 输出固定结构：图片跨两行；第一行体重、单位、差值、删除；第二行日期、时间、状态、备注。文本区域增加 `data-edit-id`，照片使用 `data-view-img`，删除使用 `data-del-id`。

```css
.record-card { min-height: 92px; max-height: 108px; }
.record-remark { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

## 5. 体重 CRUD 实现

### 5.1 新增

复用当前 `confirmModal` 和 `CloudStorageAdapter.createRecord()`。增加显式模式：

```js
openWeightModal({ mode: 'create', source: 'camera' | 'gallery' | 'manual' });
```

主按钮保存期间禁止关闭和重复提交。失败时保留全部字段。

确认弹层图片区域增加 `更换图片` 按钮。点击后暂存当前表单快照：

```js
const draft = readWeightForm();
openPhotoSourceSheet({ returnTo: 'confirmModal', draft });
```

重新选择图片后只替换 `currentParsedImageBase64` 并重新开始识别，不清空 `weight/date/time/condition/remark`。确认弹层中显示识别状态和剩余秒数，识别完成后恢复可编辑。

异常状态必须区分：

| 错误 | 行内文案 | 主恢复动作 | 数据保留 |
| --- | --- | --- | --- |
| 超时 | `识别超时，请重试` | `重新识别` / `手动输入` | 图片、表单 |
| Gemini 无法处理 | `图片格式或内容无法被 Gemini 处理，请重新拍摄` | `重新选择图片` | 图片、表单 |
| 上传失败 | `图片上传失败，已保留本地记录` | `重试上传` | 本地记录、原图 |

不要显示“请使用 JPG”等技术要求。只有在用户主动更换图片时才打开来源选择；错误状态本身不关闭弹层。

### 5.2 查询

首页加载本地缓存后立即渲染，再后台请求云端。云端返回后按 `timestamp` 合并和排序，避免先出现空屏。

### 5.3 修改

新增通用 Adapter：

```js
async updateRecord(id, changes) {
  return fetch(`${API_BASE}/api/records/${id}`, {
    method: 'PATCH',
    credentials: API_BASE ? 'omit' : 'same-origin',
    headers: { 'Content-Type': 'application/json', ...this.getCustomHeaders() },
    body: JSON.stringify(changes)
  });
}
```

`updateRecordPhoto()` 可保留为兼容包装，内部调用 `updateRecord(id, { photoBase64 })`。编辑保存时只发送变化字段；日期或时间变化后同时在服务端重新计算 `timestamp`，否则排序会与显示日期不一致。

### 5.4 删除

当前代码先删除本地再请求云端。V5 保持“即时响应”，但应写入待同步删除队列：

```text
pendingMutations = [{ type: 'deleteRecord', id, createdAt, retryCount }]
```

云端失败时提示 `本地已删除，云端待同步`，提供重试，不能把云端失败描述为整体删除成功。

## 6. 照片凭证实现

补齐以下 DOM：

```text
#photoViewerModal
#photoViewerImg
#photoViewerTitle
#btnReplaceViewerPhoto
#closePhotoViewerModal
```

查看器显示原图和记录元数据。更换照片复用现有 `replacePhotoInput` 与压缩逻辑；上传期间在原图上显示进度层，失败后保留旧照片。

图片缺失时记录卡继续展示 `补凭证`，点击直接打开文件选择，而不是打开空查看器。

## 7. 疗程 CRUD 实现

### 7.1 新增与查询

新增 `openDoseModal()` 和 `openDoseDetail(id)`。新增调用现有 `saveDose()`；详情数据直接来自 `doseRecords`，无需再次请求。

首次检测到 `doseRecords.length === 0` 时，弹层标题为 `首次记录给药`，必须先完成周期配置；已有记录时标题为 `记录给药`，默认带出当前疗程周期。

字段映射：

| 表单 | 数据字段 |
| --- | --- |
| 针次 | `seq` |
| 剂量 | `amount` |
| 日期 | `date` |
| 时间 | `time` |
| 当时体重 | `weight` |
| 注射部位 | `site` |
| 备注 | 新增 `remark`，可选 |
| 用药间隔 | 新增 `intervalDays`，首次记录必填 |

周期控件：

```text
每7天 / 每14天 / 自定义
自定义：间隔天数 [ 7 ] 天
说明：之后按此周期计算下次给药
主按钮：保存并开始疗程
```

保存时用药间隔必须是 `1–90` 的整数。`nextDoseAt = doseTimestamp + intervalDays * 86400000`，后续时间轴和倒计时统一使用该值，不再硬编码 7 天。疗程详情显示当前周期并提供 `编辑疗程设置`。

### 7.2 修改接口

在 `src/api/doseRoutes.js` 增加：

```text
PATCH /api/doses/:id
```

允许更新 `seq`、`amount`、`date`、`time`、`weight`、`site`、`remark`，并重新计算 `timestamp` 和写入 `updatedAt`。前端新增 `CloudStorageAdapter.updateDose(id, changes)`。

### 7.3 删除

给药详情中的删除调用现有 `deleteDose(id)`，必须经过通用危险确认框。删除成功后重新计算时间轴、下一次给药时间和进度。

### 7.4 周期配置接口与兼容

在 `data/doses.json` 的给药记录增加 `intervalDays`；读取旧数据时没有该字段则兼容为默认 `7`，并在下一次编辑或保存时补齐。首次新增接口请求示例：

```json
{
  "seq": "第1针",
  "amount": "2.5mg",
  "date": "2026-09-22",
  "time": "08:16",
  "weight": 169.5,
  "site": "腹部",
  "intervalDays": 7,
  "remark": ""
}
```

## 8. 账号、认证与同步

### 8.1 账号与同步弹层

保留 `sessionInfoModal`，改为显示：

- 登录邮箱。
- 当前设备和 180 天信任状态。
- GitHub 存储：已连接/异常。
- Gemini：可用/不可用。
- 上次成功同步时间。

主操作为 `立即同步`，退出登录为低强调危险操作。GitHub Token 输入移动到折叠的“高级配置”；密码框默认不回填明文。

### 8.2 同步状态模型

```js
const syncState = {
  status: 'idle' | 'syncing' | 'synced' | 'pending' | 'error',
  lastSyncedAt: null,
  message: '',
  pendingCount: 0
};
```

顶栏展示简短状态；详细错误只在弹层和可重试 Toast 中显示。网络恢复、应用从后台回到前台、用户点击重试时处理待同步队列。

## 9. 反馈与错误处理

### 9.1 Toast

- 成功：薄荷绿图标，2.5 秒自动关闭。
- 错误：红色图标，存在可恢复动作时显示 `重试`，最长 6 秒。
- 加载：旋转图标，不自动关闭，由任务结束更新状态。

### 9.2 行内错误

表单错误显示在对应字段下方；识别失败显示在体重输入上方并保留图片。不要同时显示重复 Toast 和行内错误。

图片识别状态机：

```text
idle → selecting → analyzing → success
                         ├→ timeout → retry / manual
                         ├→ unsupported → replace image
                         └→ upload-error → retry upload
```

设计要求：

- `analyzing` 显示最多 20 秒的进度，不使用无限旋转让用户误以为仍在工作。
- `timeout` 不清空图片和表单，可继续手动输入。
- `unsupported` 不暴露 JPG/HEIC 等内部实现细节，只指导重新拍摄/选择。
- `upload-error` 先确认本地记录成功，再提供云端重试；不要回滚用户已经输入的体重。
- 更换图片后清理旧的识别请求标识，避免旧响应覆盖新图片。

### 9.3 空状态

体重空状态提供唯一操作 `记录今日体重`；给药空状态提供 `记录首次给药`；离线空状态必须说明数据仍保存在本机。

## 10. JS 模块建议

当前脚本集中在单个 HTML。实现时至少按职责组织函数，即使暂不拆文件：

```text
modalManager: open / close / focusTrap / restoreFocus
weightController: create / update / delete / photo
doseController: create / update / delete
syncController: state / queue / retry
renderers: metrics / chart / timeline / records
feedback: toast / inlineError / loading
```

所有关闭路径都必须清理临时状态：`currentParsedImageBase64`、`targetRecordForPhotoUpdate`、编辑中的记录 ID、文件输入值和 pending confirm callback。

## 11. 静态文件同步

项目同时维护 `index.html`、`public/index.html` 和 Worker fallback。实施时：

1. 以 `index.html` 为唯一编辑源。
2. 验证后同步到 `public/index.html`。
3. 更新 Worker fallback 或改为构建时注入，避免三份手工漂移。
4. 提升 Service Worker 缓存版本。
5. 部署后检查 iPhone 是否拿到新 HTML 和新缓存版本。

## 12. 测试方案

### 12.1 视觉与安全区

- `440 × 956`、`390 × 844`、`320 × 568` 三种视口。
- Safari 普通模式与 PWA standalone。
- Dynamic Island、地址栏展开/收起、键盘弹出、Home Indicator 均不遮挡操作。
- 弹层内部滚动时底层页面不滚动。

### 12.2 体重 CRUD

- 相机、相册、HEIC、JPEG、手动补录分别新增。
- 识别成功、失败、20 秒超时后均能继续手动保存。
- 在确认称重弹层中更换图片，验证字段不被清空。
- 验证来源选择、识别超时、Gemini 无法处理、图片上传失败四种状态的文案和恢复动作。
- 超时后再次识别，验证旧请求不会覆盖新图片结果。
- 修改体重、日期、时间、状态、备注、照片后，指标、排序、趋势和详情一致。
- 删除成功、云端失败、离线删除和恢复联网重试均验证。
- 长备注、无照片、图片加载失败不产生第三行或高度跳动。

### 12.3 疗程 CRUD

- 新增第一针和后续针次。
- 首次新增必须选择每 7 天、每 14 天或自定义周期；非法间隔不能保存。
- 保存后下一次给药日期、时间轴和倒计时使用配置的周期，而不是固定 7 天。
- 再次记录给药时默认带出当前周期，修改周期后详情与后续计算一致。
- 查看、编辑和删除后，时间轴、当前针次、下次给药日期同步更新。
- 修改日期后 `timestamp` 正确重算。
- 离线和云端失败时不丢失本地输入。

### 12.4 账号与同步

- 未登录、登录中、已登录、信任过期、退出登录。
- GitHub 可用/401/403/网络错误；Gemini 可用/不可用。
- 同步中禁止重复操作；失败可重试；网络恢复自动处理队列。
- 高级配置默认折叠，Token 不以明文回显。

### 12.5 回归与发布

- `index.html` 与 `public/index.html` 内容一致。
- 单元检查覆盖趋势范围过滤、时间戳重算和 pending mutations 合并。
- 浏览器回归覆盖所有弹层的打开、关闭、返回键、焦点恢复。
- 部署后用真实 iPhone 完成一次新增、修改、照片替换、删除、给药新增和手动同步。

## 13. 验收标准

- 仍是一个页面，所有辅助流程以弹层或状态反馈完成。
- 首页保持 V4 布局和双行记录卡。
- 体重和疗程均具备完整增删查改；不存在只画入口但没有接口的操作。
- 照片预览 DOM 完整，查看和替换均可用。
- 同步失败不丢失本地数据，状态和重试路径清晰。
- 所有弹层满足 44px 触控目标、焦点管理和安全区要求。

## 14. 推荐实施顺序

1. 建立通用弹层、状态反馈和同步状态模型。
2. 完成 V4 首页与体重 CRUD、照片查看器、换图和识别异常恢复。
3. 完成首次给药周期配置、疗程新增/详情/删除，并补充 PATCH 更新接口。
4. 统一账号认证、PWA 和高级配置。
5. 完成 iPhone 真机回归、缓存版本更新和部署验证。
