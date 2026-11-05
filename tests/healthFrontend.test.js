import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'acorn';

const html = fs.readFileSync('index.html', 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].sort((a, b) => b[1].length - a[1].length)[0][1];
const ast = parse(script, { ecmaVersion: 'latest' });

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this._text = '';
    this.className = '';
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.classList = {
      add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
      remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, enabled) => { if (enabled) this.classList.add(name); else this.classList.remove(name); }
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this._text = ''; this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getContext() { return {}; }
}

function findAll(element, predicate) {
  return [...(predicate(element) ? [element] : []), ...element.children.flatMap(child => findAll(child, predicate))];
}

function harness(ids = []) {
  const elements = new Map(ids.map(id => [id, new Element()]));
  return { elements, document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag) } };
}

function run(names, context, invocation) {
  const source = names.map(name => {
    const fn = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
    assert.ok(fn, name + ' must exist');
    return script.slice(fn.start, fn.end);
  }).join('\n');
  return new Function(...Object.keys(context), source + '\n' + invocation)(...Object.values(context));
}

test('health page shares the weight header, card tokens, button hierarchy and accessible controls', () => {
  assert.match(html, /id="healthHeader" class="app-header/);
  assert.match(html, /id="healthMain" class="health-page-content"/);
  assert.match(html, /id="btnAddHealthReport"[^>]*h-16 rounded-2xl bg-cyberNeon/);
  assert.equal((html.match(/id="btnAddHealthReport"/g) || []).length, 1);
  assert.match(html, /\.health-report-thumb\s*\{[^}]*border-radius: 16px/);
  assert.match(html, /\.health-modal\s*\{[^}]*border-radius: 22px/);
  assert.doesNotMatch(html, /#weightPage main, #healthPage \{ padding-bottom/);
});

test('report cards retain dates, measurements, private photos, editor and delete actions', () => {
  const { document, elements } = harness(['healthReportsList', 'healthReportsEmpty', 'healthReportCount', 'healthSourceOrderNotice']);
  const reports = [
    { id: 'synthetic-2', sourceOrder: 2, examDate: '2025-04-03', dateType: 'examination', dateConfirmed: true, observations: [{ metricCode: 'ALT', value: 55, unit: 'U/L', printedFlag: 'high' }] },
    { id: 'synthetic-1', sourceOrder: 1, reportDate: '2025-04-02', dateType: 'report', dateConfirmed: true, photoPath: 'images/health/2025/04/test.jpg', observations: [{ metricCode: 'AST', value: 35, unit: 'U/L' }] }
  ];
  const healthDocument = { reports };
  const before = JSON.stringify(healthDocument);
  const edited = [], removed = [];
  run(['healthSourceDateLabel', 'renderHealthReports'], {
    document, healthDocument,
    CloudStorageAdapter: { resolvePhotoUrl: path => '/mock-private-photo/' + path },
    openHealthReportEditor: report => edited.push(report.id),
    confirmDeleteHealthReport: report => removed.push(report.id)
  }, 'renderHealthReports();');
  const list = elements.get('healthReportsList');
  assert.equal(list.children.length, 2);
  assert.equal(elements.get('healthReportCount').textContent, '共 2 条');
  assert.match(list.children[0].className, /glass-surface health-report-card rounded-2xl/);
  assert.match(list.children[0].textContent, /04\/02 报告日AST 35 U\/L/);
  assert.match(list.children[1].textContent, /04\/03 检查日ALT 55 U\/L ↑/);
  assert.doesNotMatch(list.textContent, /来源 [12]|日期已核对/);
  const image = findAll(list.children[0], node => node.tagName === 'img')[0];
  assert.equal(image.alt, '检查报告图片');
  assert.match(image.src, /^\/mock-private-photo\/images\/health\//);
  image.onerror();
  assert.equal(findAll(list.children[0], node => node.tagName === 'img').length, 0);
  assert.ok(findAll(list.children[0], node => node.className.includes('ph-file-text')).length);
  list.children[0].children[0].onclick();
  list.children[1].children[1].onclick();
  assert.deepEqual(edited, ['synthetic-1']);
  assert.deepEqual(removed, ['synthetic-2']);
  assert.equal(JSON.stringify(healthDocument), before);
});

test('today plan cards preserve completion, undo and ten-minute snooze actions', async () => {
  const { document, elements } = harness(['healthTodayPlan', 'healthTodayProgress', 'btnConfigureHealthPlans']);
  const tasks = [
    { planId: 'oral', time: '08:10', title: '测试口服计划', status: 'pending' },
    { planId: 'topical', time: '21:40', title: '测试外用计划', status: 'done' }
  ];
  const mutations = [];
  run(['appendHealthButton', 'renderHealthTodayPlan'], {
    document, getHealthPlanReady: () => true, getHealthTasksForToday: () => tasks,
    getHealthDateKey: () => '2025-04-03',
    sendHealthMutation: async (path, method, payload) => mutations.push({ path, method, payload }),
    showToast: () => {}
  }, 'renderHealthTodayPlan();');
  const rows = elements.get('healthTodayPlan').children[0].children;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.className.includes('glass-surface health-task-row')));
  assert.equal(elements.get('healthTodayProgress').textContent, '已记录 1/2');
  assert.equal(elements.get('btnConfigureHealthPlans').textContent, '调整用药计划');
  const pendingActions = rows[0].children[2].children;
  const doneAction = rows[1].children[2].children[0];
  await pendingActions[0].onclick();
  await pendingActions[1].onclick();
  await doneAction.onclick();
  assert.deepEqual(mutations.map(row => row.payload.action), ['complete', 'snooze', 'undo']);
  assert.equal(mutations[1].payload.minutes, 10);
  assert.ok(mutations.every(row => row.path === '/tasks' && row.method === 'POST' && row.payload.date === '2025-04-03'));
});

test('health chart card keeps the exact values, range and report-opening behavior', () => {
  const { document } = harness();
  const root = new Element();
  const instances = {};
  const opened = [];
  const drawnLabels = [];
  const reports = [50, 55].map((value, index) => ({
    id: 'synthetic-' + index, sourceOrder: index + 1, reportDate: '2025-04-0' + (index + 2), dateType: 'report', dateConfirmed: true,
    observations: [{ metricId: 'alt', metricCode: 'ALT', value, unit: 'U/L', referenceRange: { lower: 0, upper: index ? 60 : 50 } }]
  }));
  class Chart {
    constructor(_context, config) { this.config = config; }
    getElementsAtEventForMode() { return [{ index: 0 }]; }
  }
  const metric = { id: 'alt', code: 'ALT', label: 'ALT · 谷丙转氨酶', unit: 'U/L' };
  run(['renderHealthChart'], {
    document, healthDocument: { reports }, healthChartInstances: instances, Chart, metric, root,
    openHealthReportEditor: report => opened.push(report.id)
  }, 'renderHealthChart(metric, root);');
  assert.match(root.children[0].className, /glass-surface health-chart-block/);
  assert.deepEqual(instances.alt.config.data.datasets[0].data.map(point => point.y), [50, 55]);
  assert.deepEqual(instances.alt.config.data.datasets[1].data.map(point => point.y), [50, 50]);
  assert.equal(instances.alt.config.data.datasets[1].label, '目标值 50 U/L');
  const xScale = instances.alt.config.options.scales.x;
  const firstX = instances.alt.config.data.datasets[0].data[0].x;
  const lastX = instances.alt.config.data.datasets[0].data[1].x;
  const padding = (lastX - firstX) * 0.04;
  assert.ok(firstX - xScale.min >= padding);
  assert.ok(xScale.max - lastX >= padding);
  assert.match(root.textContent, /最新 55 U\/L · 报告日/);
  const canvas = findAll(root, node => node.tagName === 'canvas')[0];
  const plot = instances.alt.config.plugins[0];
  const firstChartPoint = { x: 101, y: 40 }, lastChartPoint = { x: 309, y: 60 };
  const chartContext = {
    save() {}, restore() {}, measureText: text => ({ width: String(text).length * 9 }),
    fillText: (text, x, y) => drawnLabels.push({ text, x, y })
  };
  plot.afterDatasetsDraw({
    getDatasetMeta: () => ({ data: [firstChartPoint, lastChartPoint] }),
    ctx: chartContext, chartArea: { left: 100, right: 310, top: 0, bottom: 100 }
  });
  assert.ok(drawnLabels.length > 0);
  for (const label of drawnLabels) assert.ok(label.x >= 100 + String(label.text).length * 4.5 && label.x <= 310 - String(label.text).length * 4.5);
  canvas.onclick({});
  assert.deepEqual(opened, ['synthetic-0']);
});
