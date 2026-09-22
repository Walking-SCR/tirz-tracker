# Tirz Tracker 首页视觉修复技术实现方案

## 目标

以 `tirz-tracker-iphone17-promax-v4.png` 为首页基准，保留 V6 已有交互能力和测试依赖的 DOM ID，只修正视觉层级、布局密度和趋势数据呈现。所有修改必须同步到根页面、`public/index.html` 和 Worker fallback。

## 实现策略

### 1. 首页布局与安全区

- `appHeader` 去掉 sticky 玻璃卡片和底部边框，改为透明 Hero；保留 `viewport-fit=cover` 和 `env(safe-area-inset-top)`。
- 用 `.home-section-title` 统一标题字号，使用 `clamp` 让 iPhone 390–440px 宽度平滑缩放。
- 主内容继续使用 `max-w-md`，避免桌面预览无限拉伸；间距统一由主容器 `space-y-5` 管理。

### 2. 指标卡、趋势和主 CTA

- 指标卡保留三列及分隔线，标签提升为 14px、数值提升为 30px，单位保持弱化色。
- 趋势区移除外层玻璃卡片，保留标题、范围切换和图表；图表高度使用 `clamp(15rem, 45vw, 18rem)`。
- Chart.js x 轴强制水平显示并限制 11 个刻度；保留目标体重基准线和设计稿霓虹配色。
- 主 CTA 调整为 64px 高、24px 图标；手动补录提升到 14px，确保主次关系。

### 3. 趋势数据去重

- 在 `renderTelemetryChart()` 中先按 `record.date` 聚合，同一天只保留时间戳最新的一条。
- 聚合后再按时间升序生成 labels/data，避免重复日期造成标签重叠。
- 该处理只影响图表展示，不删除或修改原始体重记录，也不影响记录明细和云同步。

### 4. 疗程时间轴和记录明细

- 时间轴从玻璃卡片改成上下分隔线，节点尺寸统一到 36–40px，连接线定位到节点中心。
- 记录卡图片提升到 80px，体重值提升到 30px，保留两行信息、备注截断和删除操作。
- 不改变既有 `data-view-img`、`data-edit-record`、`data-del-record` 事件绑定。

### 5. 产物同步

执行顺序：

1. 修改根 `index.html`。
2. 将完全相同内容同步到 `public/index.html`。
3. 重新生成 `src/fallbackHtml.js` 的 UTF-8 Base64 常量，确保 Worker 无静态资源时仍返回新页面。
4. 运行前端 DOM/一致性测试和全量测试。

## 测试方案

### 自动化

- `npm test`：验证根页面、public 页面、fallback 内容一致，以及 V6 所有关键 DOM ID 和 API 路由。
- 重点验证 `tests/frontend.test.js` 中的图表、时间轴、记录卡、弹层状态和 Service Worker v6.0 断言。

### 视觉回归

- 在 390px、430px、桌面辅助宽度下打开 `index.html`。
- 检查首屏顺序、指标数值层级、趋势 x 轴是否水平、同日数据是否只出现一个点、时间轴连接线是否穿过节点中心。
- 打开来源选择和确认称重弹层，确认弹层 DOM ID 未变、更换图片和异常状态仍可达。

### 验收标准

- 根页面、public 页面、fallback 三者字节级一致。
- `npm test` 全部通过。
- 390–440px 宽度下无横向滚动；主 CTA、关闭、换图、删除等触控目标不低于 44px。
- 同一天多条称重记录不再造成趋势图日期/数值标签重叠。

