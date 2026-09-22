import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  assert.match(html, /capture-failed/, 'Pointer capture failures must not break touch pagination');
  assert.match(html, /timelineOffsetInitialized/, 'Timeline should initialize its window around today once');
  assert.match(html, /state\.axis = Math\.abs\(dx\)/, 'Timeline should lock the gesture axis before dragging');
  assert.match(html, /timelineSuppressClick/, 'Timeline drag should not accidentally activate a date node');
  assert.match(html, /dataset\.timelineKey/, 'Timeline nodes should expose their local date key');
  assert.match(html, /timelineFirstDose/, 'Timeline should anchor to the first dose');
  assert.match(html, /TIMELINE_DRAG_STEP_DAYS = 4/, 'Timeline should page four days per swipe');
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

test('Service Worker cache version is v6.0 in sw.js and public/sw.js', () => {
  const rootSw = fs.readFileSync('sw.js', 'utf-8');
  const publicSw = fs.readFileSync('public/sw.js', 'utf-8');
  assert.ok(rootSw.includes('tirz-tracker-v6.0'), 'sw.js must contain cache v6.0');
  assert.ok(publicSw.includes('tirz-tracker-v6.0'), 'public/sw.js must contain cache v6.0');
});
