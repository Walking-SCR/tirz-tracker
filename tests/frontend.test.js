import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'acorn';
import { getFallbackHtml } from '../src/fallbackHtml.js';

test('index.html and public/index.html exist and are identical', () => {
  const rootHtml = fs.readFileSync('index.html', 'utf-8');
  const publicHtml = fs.readFileSync('public/index.html', 'utf-8');
  assert.equal(rootHtml, publicHtml, 'Root index.html and public/index.html must match');
});

test('src/fallbackHtml.js provides the exact content of index.html', () => {
  const rootHtml = fs.readFileSync('index.html', 'utf-8');
  const fallbackHtml = getFallbackHtml();
  assert.equal(rootHtml, fallbackHtml, 'fallbackHtml must decode to root index.html');
});

test('V6 interaction DOM IDs and structures are present', () => {
  const html = fs.readFileSync('index.html', 'utf-8');

  const requiredIds = [
    // 01 主页面
    'appHeader',
    'btnHeaderSync',
    'headerSyncIcon',
    'headerSyncText',
    'headerDateText',
    'metricsSummary',
    'statTargetWeight',
    'statCurrentWeight',
    'statTotalDrop',
    'trendSection',
    'trendRangeAll',
    'trendRange7d',
    'trendRange1m',
    'weightChartCanvas',
    'btnRecordToday',
    'btnManualAdd',
    'treatmentTimeline',
    'timelineViewport',
    'timelineNodesContainer',
    'timelineWeekText',
    'timelineResetToday',
    'timelineGestureHint',
    'btnTimelineSettings',
    'recordsListSection',
    'recordCountBadge',
    'recordsListContainer',
    // 02 确认称重数据
    'confirmModal',
    'confirmModalTitle',
    'btnCloseModal',
    'confirmImageCard',
    'confirmPhotoThumb',
    'confirmPhotoPlaceholder',
    'btnChangeImageInConfirm',
    'confirmWeightInput',
    'confirmDateInput',
    'confirmTimeInput',
    'tagPickerGroup',
    'confirmRemarkInput',
    'confirmRemarkCount',
    'btnCancelConfirm',
    'btnSaveConfirm',
    // 03 更换图片·来源选择
    'photoSourceSheet',
    'btnSheetCamera',
    'btnSheetGallery',
    'btnSheetCancel',
    'btnCloseSheet',
    // 04 识别中状态
    'confirmScanState',
    'scanProgressCircle',
    'scanCountdownText',
    'btnCancelScan',
    // 05 识别超时错误
    'confirmTimeoutError',
    'btnRetryScan',
    'btnManualInputOnError',
    'btnCancelTimeout',
    // 06 图片无法处理
    'confirmUnsupportedError',
    'btnPickNewImageOnError',
    'btnCancelUnsupported',
    // 07 上传失败
    'confirmUploadError',
    'btnRetryUploadOnError',
    'btnCancelUploadError',
    // 08 首次记录给药
    'doseModal',
    'doseModalTitle',
    'btnCloseDoseModal',
    'doseIntervalSection',
    'doseInterval7',
    'doseInterval14',
    'doseIntervalCustom',
    'doseIntervalDaysContainer',
    'doseIntervalMinus',
    'doseIntervalPlus',
    'doseIntervalDaysInput',
    'doseSeqInput',
    'doseAmountSelect',
    'doseDateInput',
    'doseTimeInput',
    'doseSiteContainer',
    'doseWeightInput',
    'doseRemarkInput',
    'btnSaveDose',
    // 09 疗程设置
    'doseScheduleSheet',
    'btnCloseDoseScheduleSheet',
    'scheduleCycleDisplay',
    'scheduleAmountDisplay',
    'scheduleSiteDisplay',
    'scheduleNextDateDisplay',
    'btnEditDoseSchedule',
    // 给药详情
    'doseDetailModal',
    'btnCloseDoseDetailModal',
    'detailSeq',
    'detailAmount',
    'detailDate',
    'detailSite',
    'detailWeight',
    'detailCycle',
    'detailRemark',
    'btnEditDetailDose',
    'btnDeleteDetailDose',
    // 10 删除确认
    'customConfirmModal',
    'customConfirmTitle',
    'customConfirmMsg',
    'customConfirmCancel',
    'customConfirmOk',
    // 11 账号与同步
    'sessionInfoModal',
    'btnCloseSessionInfoModal',
    'sessionUserEmail',
    'sessionDeviceStatus',
    'ghTokenStatusBadge',
    'geminiKeyStatusBadge',
    'sessionLastSyncTime',
    'btnToggleTimelineVisibility',
    'inputUserGithubToken',
    'btnSaveGithubToken',
    'btnRefreshData',
    'btnLogOut',
    // 全屏照片查看器
    'photoViewerModal',
    'photoViewerImg',
    'photoViewerTitle',
    'btnReplaceViewerPhoto',
    'closePhotoViewerModal',
    // 12/13/14 Toast
    'cyberToast',
    'toastIcon',
    'toastText',
    'toastRetryBtn',
    'toastCloseBtn',
    // 15 空记录状态
    'recordsEmptyState',
    'btnEmptyRecordToday',
    // 16 离线待同步横幅
    'offlineBanner'
  ];

  for (const id of requiredIds) {
    assert.ok(html.includes(`id="${id}"`), `Expected id="${id}" to be present in index.html`);
  }

  assert.match(html, /timelineWindowOffsetDays/, 'Timeline should keep a draggable window offset');
  assert.match(html, /onpointerdown/, 'Timeline should support pointer drag start');
  assert.match(html, /onpointermove/, 'Timeline should provide drag feedback');
  assert.match(html, /onpointerup/, 'Timeline should support pointer drag end');
  assert.match(html, /addEventListener\('touchstart'/, 'Timeline should support touch drag fallback on iPhone WebViews');
  assert.match(html, /addEventListener\('touchmove'/, 'Timeline should handle horizontal touch movement');
  assert.match(html, /touch-action: none/, 'Timeline should lock the gesture after horizontal dragging starts');
  assert.match(html, /timelineDebugEnabled/, 'Timeline should expose opt-in debug logging');
  assert.match(html, /STORAGE_KEY_TIMELINE_VISIBILITY = 'tirz_timeline_visible_v1'/, 'Timeline visibility should have a durable preference key');
  assert.match(html, /localStorage\.setItem\(STORAGE_KEY_TIMELINE_VISIBILITY, String\(nextVisibility\)\)/, 'Toggle changes should persist across reloads');
  assert.match(html, /section\.classList\.toggle\('hidden', !timelineIsVisible\)/, 'Turning the preference off should hide the entire timeline section');
  assert.match(html, /role="switch" aria-label="显示疗程时间轴" aria-checked="true"/, 'The account modal toggle should be accessible as a switch');
  assert.match(html, /capture-failed/, 'Pointer capture failures must not break touch pagination');
  assert.match(html, /AUTH_SERVICE_UNREACHABLE/, 'A fetch-level login failure should explain the network/VPN requirement');
  assert.match(html, /无法连接登录服务，请检查网络或 VPN 后重试/, 'Login fetch errors should not expose a raw Failed to fetch message');
  assert.match(html, /timelineOffsetInitialized/, 'Timeline should initialize its window around today once');
  assert.match(html, /state\.axis = Math\.abs\(dx\)/, 'Timeline should lock the gesture axis before dragging');
  assert.match(html, /timelineSuppressClick/, 'Timeline drag should not accidentally activate a date node');
  assert.match(html, /dataset\.timelineKey/, 'Timeline nodes should expose their local date key');
  assert.match(html, /timelineFirstDose/, 'Timeline should anchor to the first dose');
  assert.match(html, /TIMELINE_DRAG_STEP_DAYS = 4/, 'Timeline should page four days per swipe');
  assert.match(html, /state\.source !== source/, 'A gesture must stay bound to the event source that started it');
  assert.match(html, /state\.identifier/, 'Touch gestures must stay bound to the originating touch identifier');
  assert.match(html, /const isAppleTouchBrowser = \/iPhone\|iPad\|iPod\//, 'iPhone/iPad Safari must be detected independently of PointerEvent support');
  assert.match(html, /const useTouchEvents = isAppleTouchBrowser \|\| !\('PointerEvent' in window\)/, 'iOS Safari must use Touch Events even when it exposes Pointer Events');
  assert.match(html, /if \(useTouchEvents\)[\s\S]{0,320}addEventListener\('touchstart'/, 'Touch and Pointer listeners must be mutually exclusive');
  assert.match(html, /\.timeline-viewport\.is-touch-driven[\s\S]{0,120}touch-action: pan-y/, 'iOS touch mode must preserve vertical page scrolling while handling horizontal drags');
  assert.match(html, /const target = Math\.max\(0, Math\.min\(info\.maxOffsetDays, timelineWindowOffsetDays \+ \(shouldPage \? direction \* TIMELINE_DRAG_STEP_DAYS : 0\)\)\)/, 'Finger direction should map to bounded four-day timeline paging');
  assert.match(html, /timelineAddDays\(latestDateKey, intervalDays \* \(index \+ 1\)\)/, 'Future dose predictions should use local calendar-day arithmetic');
  assert.match(html, /Array\.from\(\{ length: 4 \}/, 'Timeline should forecast four upcoming doses');
  assert.match(html, /projectedEndOffset/, 'Timeline browsing must extend through projected doses and stop at a finite boundary');
  assert.match(html, /疗程第 \$\{daysToToday \+ 1\} 天/, 'Timeline header should show elapsed treatment day count');
  assert.match(html, /getPixelForValue\(targetWeight\)/, 'Goal line should be rendered at the target value even without data points');
  assert.match(html, /ctx\.setLineDash\(\[6, 5\]\)/, 'Goal line should have a visible dashed style');
  assert.match(html, /class="trend-target-legend">目标 148 斤/, 'Goal label should live outside the plot');
  assert.match(html, /const dataPoints = filtered\.map\(r => r\.weight\)/, 'Empty chart state should not create a visible null datapoint');
  assert.match(html, /const yMin = Math\.min\(145, Math\.floor\(Math\.min\(targetWeight, \.\.\.chartValues\)/, 'Y scale should include the target when all recorded values are below it');
  assert.match(html, /pastBorder[\s\S]{0,240}83,106,132,0\.78/, 'Completed timeline circles should use the design 2px slate border');
  assert.match(html, /border-2 border-\[rgba\(62,84,108,0\.78\)\]/, 'Future timeline circles should use the design 2px dark border');
  assert.match(html, /weightOnThisDay/, 'Timeline should distinguish recorded past dates from empty past dates');
  assert.match(html, /border-2 border-cyberPurple text-cyberPurple/, 'Next-dose node should use the solid purple design border');
  assert.doesNotMatch(html, /border-2 border-dashed border-cyberPurple/, 'Next-dose node should not use a dashed border');
  assert.match(html, /align-items:\s*center/, 'All app overlays should be vertically centered');
  assert.match(html, /position:\s*sticky/, 'The top header should remain pinned while scrolling');
  assert.match(html, /\.hidden\s*\{\s*display:\s*none\s*!important;/, 'Critical hidden fallback CSS must not depend on Tailwind CDN');
  assert.match(html, /new URLSearchParams\(window\.location\.search\)/, 'Setup mode query should open the first-device flow');
  assert.match(html, /正在绑定/, 'Bootstrap action should show a visible pending state');
});

test('health page, report trends, plans, and private iPhone calendar controls are present once', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const requiredIds = [
    'btnNavHealth', 'healthPage', 'healthTodayPlan', 'btnConfigureHealthPlans',
    'healthMetricCharts', 'btnAddHealthReport', 'btnAddHealthCalendar',
    'healthReportsList', 'btnConfirmCalendarSubscription', 'btnStopCalendarSync'
  ];
  for (const id of requiredIds) assert.ok(html.includes(`id="${id}"`), `Expected id="${id}"`);
  assert.equal((html.match(/document\.addEventListener\('DOMContentLoaded'/g) || []).length, 1, 'App initialization must only run once');
  assert.equal((html.match(/function updateHealthMetric\(/g) || []).length, 1, 'Health metric action must only be declared once');
  assert.match(html, /healthSourceDateLabel\(report\)/, 'Health report rows must use the date label helper that exists');
  assert.doesNotMatch(html, /healthReportDateLabel/, 'A stale helper name must not abort report and chart rendering');
});

test('health plan save uses the persisted action and report list omits screenshot-marked source/status labels', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /persistHealthAction\('save-plans'/, 'Plan save must call the implemented health persistence method');
  assert.doesNotMatch(html, /commitHealthAction/, 'No stale health action function references may remain');
  assert.match(html, /configured \? '调整用药计划'/, 'Configured plans must still have a visible edit entry');
  assert.doesNotMatch(html, /setupButton\.classList\.toggle\('hidden', configured\)/);
  assert.doesNotMatch(html, /heading\.textContent = '来源 ' \+ report\.sourceOrder/, 'Report rows must not render the red-boxed source sequence');
  assert.doesNotMatch(html, /state\.textContent = report\.dateConfirmed \? '日期已核对'/, 'Report rows must not render the removed confirmation-status column');
});

test('scale OCR deadline covers image preparation and has a real abort timer', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /const SCALE_SCAN_DEADLINE_MS = 20_000/);
  assert.match(html, /scanDeadlineTimer = setTimeout\(/, 'The 20-second clock must actually abort a pending recognition request');
  assert.match(html, /const scanContext = createScaleScanContext\(file\)/, 'The deadline must start before HEIC conversion and resize');
  assert.match(html, /requestId: scanContext\.requestId/);
  assert.match(html, /clientPrepareMs: scanContext\.prepareMs/);
  assert.match(html, /clientRemainingMs:/);
});

test('OCR frontend does not label service, network or unreadable-result errors as a timeout', async () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].sort((a, b) => b[1].length - a[1].length)[0][1];
  const fn = parse(script, { ecmaVersion: 'latest' }).body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'startScanRecognition');
  const cases = [
    { status: 502, body: { error: 'AI_AUTH_FAILED', message: '识别服务认证失败' }, expected: 'error', message: '识别服务认证失败' },
    { status: 504, body: { error: 'AI_UPSTREAM_TIMEOUT' }, expected: 'timeout' },
    { status: 200, body: { weight: null }, expected: 'error', message: '未能从照片中读到体重数字' },
    { networkError: true, expected: 'error', message: '无法连接识别服务' }
  ];
  for (const example of cases) {
    const nodes = new Map();
    const panels = [];
    const document = { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { classList: { remove() {} }, value: '', textContent: '', disabled: false });
      return nodes.get(id);
    } };
    const fakeFetch = async () => {
      if (example.networkError) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(example.body), { status: example.status });
    };
    const run = new Function('document', 'fetch', 'performance', 'console', 'context', 'panels', `
      let currentParsedImageBase64, ocrAbortController;
      const API_BASE = '';
      const CloudStorageAdapter = { getCustomHeaders: () => ({}) };
      function estimateDataUrlBytes() { return 120; }
      function hideConfirmInModalErrors() {}
      function clearScaleScanTimers() {}
      function showToast() {}
      function showUnsupportedErrorState() { panels.push({ type: 'unsupported' }); }
      function showTimeoutErrorState() { panels.push({ type: 'timeout' }); }
      function showRecognitionErrorState(message) { panels.push({ type: 'error', message }); }
      ${script.slice(fn.start, fn.end)}
      return startScanRecognition('data:image/jpeg;base64,AAAA', context);
    `);
    await run(document, fakeFetch, { now: () => 1000 }, { info() {}, warn() {} }, {
      requestId: 'test-ui', deadlineAt: 21000, prepareMs: 0, inputBytes: 120, inputMimeType: 'image/jpeg', cancelled: false, expired: false
    }, panels);
    assert.equal(panels.length, 1);
    assert.equal(panels[0].type, example.expected);
    if (example.message) assert.ok(panels[0].message.includes(example.message));
  }
});

function trendPreviewHarness(records, range = 'all') {
  const html = fs.readFileSync('index.html', 'utf8');
  const mainScript = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .sort((a, b) => b[1].length - a[1].length)[0][1];
  const ast = parse(mainScript, { ecmaVersion: 'latest' });
  const render = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'renderTelemetryChart');
  const stats = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'calculateStats');
  const gap = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'formatGoalGapSummary');
  const elements = new Map();
  const attributes = {};
  const drawnLabels = [];
  const ctx = {
    createLinearGradient() { return { addColorStop() {} }; },
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    setLineDash() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
    fillRect() {},
    measureText(text) { return { width: String(text).length * 7 }; },
    fillText(text, x, y) { drawnLabels.push({ text, x, y, width: String(text).length * 7 }); }
  };
  const canvas = { getContext: () => ctx, setAttribute: (key, value) => { attributes[key] = value; } };
  elements.set('weightChartCanvas', canvas);
  elements.set('trendSelectedDate', {});
  for (const id of ['statGoalGap', 'statTargetWeight', 'statCurrentWeight', 'statTotalDrop']) elements.set(id, {});
  class MockChart {
    constructor(context, config) {
      this.ctx = context;
      this.config = config;
      this.chartArea = { left: 24, right: 320, top: 0, bottom: 180 };
      this.scales = { y: { getPixelForValue: () => 160 } };
      this.points = config.data.labels.map((_, i) => ({ x: 24 + i * 296 / Math.max(1, config.data.labels.length - 1), y: 60 }));
      this.drawCount = 0;
    }
    getDatasetMeta() { return { data: this.points }; }
    draw() { this.drawCount += 1; }
  }
  const chart = new Function('document', 'weightRecords', 'trendRange', 'Chart', 'TARGET_WEIGHT',
    'let chartInstance; ' + mainScript.slice(gap.start, gap.end) + mainScript.slice(stats.start, stats.end) + mainScript.slice(render.start, render.end) + '; calculateStats(); renderTelemetryChart(); return chartInstance;'
  )({ getElementById: id => elements.get(id) }, records, range, MockChart, 148);
  return { chart, canvas, elements, attributes, drawnLabels };
}

test('trend history selection leaves the latest-weight goal summary unchanged', () => {
  const records = Array.from({ length: 30 }, (_, index) => ({
    date: '2026-10-' + String(index + 1).padStart(2, '0'),
    timestamp: index + 1,
    weight: 174.7 - index * 0.2
  }));
  const { chart, canvas, elements, attributes } = trendPreviewHarness(records);
  assert.match(attributes['aria-valuetext'], /168\.9斤/);
  assert.doesNotMatch(fs.readFileSync('index.html', 'utf8'), /id="trendSelectedWeight"/);
  assert.equal(elements.get('statGoalGap').textContent, '还差 20.9 斤');
  assert.match(elements.get('trendSelectedDate').textContent, /最新/);
  assert.equal(chart.config.options.plugins.tooltip.enabled, false);
  assert.equal(chart.config.options.scales.x.ticks.maxTicksLimit, 5);
  const plugin = chart.config.plugins[0];
  plugin.beforeDatasetsDraw(chart);
  plugin.afterDatasetsDraw(chart);
  const args = { event: { type: 'touchmove', x: 24, y: 60 } };
  plugin.afterEvent(chart, args);
  assert.match(attributes['aria-valuetext'], /174\.7斤/);
  assert.equal(elements.get('statGoalGap').textContent, '还差 20.9 斤');
  assert.equal(attributes['aria-valuenow'], '0');
  assert.equal(args.changed, true);
  canvas.onkeydown({ key: 'End', preventDefault() {} });
  assert.match(attributes['aria-valuetext'], /168\.9斤/);
  canvas.onkeydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(attributes['aria-valuenow'], '28');
  assert.equal(chart.drawCount, 2);
});

test('trend key labels remain sparse, inside the plot and separated for dense records', () => {
  for (const count of [0, 7, 30, 90, 365]) {
    const records = Array.from({ length: count }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      timestamp: index + 1, weight: index % 2 ? 166.8 : 166.9
    }));
    const { chart, elements, drawnLabels } = trendPreviewHarness(records);
    chart.config.plugins[0].beforeDatasetsDraw(chart);
    chart.config.plugins[0].afterDatasetsDraw(chart);
    if (!count) assert.equal(elements.get('trendSelectedDate').textContent, '暂无记录');
    assert.equal(chart.points.length, count);
    assert.ok(drawnLabels.length <= 3);
    if (count) assert.ok(drawnLabels.length > 0);
    for (let i = 0; i < drawnLabels.length; i++) {
      const label = drawnLabels[i];
      assert.ok(label.x - label.width / 2 >= chart.chartArea.left);
      assert.ok(label.x + label.width / 2 <= chart.chartArea.right);
      for (const other of drawnLabels.slice(i + 1)) {
        assert.ok(Math.abs(label.x - other.x) >= (label.width + other.width) / 2 + 14);
      }
    }
  }
});

test('goal summary handles no data, invalid measurements, reaching and exceeding the target', () => {
  assert.equal(trendPreviewHarness([]).elements.get('statGoalGap').textContent, '暂无最新体重');
  for (const [weight, expected] of [[148, '已达到目标体重'], [147.8, '已低于目标 0.2 斤']]) {
    assert.equal(trendPreviewHarness([{ date: '2026-10-15', timestamp: 1, weight }]).elements.get('statGoalGap').textContent, expected);
  }
  const html = fs.readFileSync('index.html', 'utf8');
  assert.doesNotMatch(html, /id="trendGoalGap"/);
  assert.match(html, /id="statGoalGap"/);
});

test('mobile goal strip is centered with symmetric spacing and keeps timeline target sizes', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /\.goal-gap-summary\s*\{[^}]*justify-content: center;[^}]*align-items: center;[^}]*padding: 9px 0;/);
  assert.match(html, /#metricsSummary\s*\{ padding-bottom: 0; \}/);
  assert.match(html, /\.metric-value\s*\{[^}]*white-space: nowrap;/, 'Metric values must keep the jin unit on the same line');
  assert.match(html, /font-size: clamp\(24px, 6\.8vw, 30px\)/);
  assert.match(html, /#timelineViewport\s*\{ min-height: 106px;/);
  assert.match(html, /class="w-10 h-10 rounded-full/);
  assert.match(html, /visualViewport\?\.addEventListener\('resize', scheduleWeightFirstScreenFit\)/);
});

test('mobile first-screen fitting reserves navigation space without shrinking the timeline', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].sort((a, b) => b[1].length - a[1].length)[0][1];
  const ast = parse(script, { ecmaVersion: 'latest' });
  const names = ['calculateFirstScreenChartHeight', 'fitWeightFirstScreen'];
  const source = names.map(name => { const fn = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name); return script.slice(fn.start, fn.end); }).join('\n');
  for (const example of [
    { bottom: 930, navTop: 887, scrollY: 0, expected: 'full' },
    { bottom: 880, navTop: 853, scrollY: 0, expected: 'full' },
    { bottom: 900, navTop: 887, scrollY: 80, expected: 'full' },
    { bottom: 1050, navTop: 650, scrollY: 0, expected: 'scroll' }
  ]) {
    let height = 252;
    let resizeCount = 0;
    const chart = {
      dataset: {},
      style: { setProperty(_name, value) { height = parseFloat(value); }, removeProperty() { return ''; } },
      getBoundingClientRect() { return { height, width: 408 }; }
    };
    const nodes = {
      weightPage: { classList: { contains() { return false; } } },
      weightTrendChart: chart,
      treatmentTimeline: { classList: { contains() { return false; } }, getBoundingClientRect() { return { bottom: example.bottom - example.scrollY + height - 252 }; } },
      appBottomNav: { getBoundingClientRect() { return { top: example.navTop }; } }
    };
    new Function('document', 'window', 'chartInstance', source + ';fitWeightFirstScreen();')(
      { getElementById: id => nodes[id] },
      { innerWidth: 440, scrollY: example.scrollY, visualViewport: { scale: 1 } },
      { resize() { resizeCount += 1; } }
    );
    assert.ok(height >= 176 && height <= 280);
    assert.equal(chart.dataset.firstScreenFit, example.expected);
    assert.equal(resizeCount, 1);
    if (example.expected === 'full') assert.ok(nodes.treatmentTimeline.getBoundingClientRect().bottom + example.scrollY <= example.navTop - 12);
  }
});

test('Service Worker cache version is v6.5 in sw.js and public/sw.js', () => {
  const rootSw = fs.readFileSync('sw.js', 'utf-8');
  const publicSw = fs.readFileSync('public/sw.js', 'utf-8');
  assert.ok(rootSw.includes('tirz-tracker-v6.5'), 'sw.js must contain cache v6.5');
  assert.ok(publicSw.includes('tirz-tracker-v6.5'), 'public/sw.js must contain cache v6.5');
});
