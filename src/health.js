export const HEALTH_TIME_ZONE = 'Asia/Shanghai';

export const HEALTH_METRICS = [
  { id: 'alt', code: 'ALT', label: 'ALT · 谷丙转氨酶', aliases: ['ALT', 'GPT', '谷丙转氨酶', '丙氨酸氨基转移酶'] },
  { id: 'ast', code: 'AST', label: 'AST · 谷草转氨酶', aliases: ['AST', 'GOT', '谷草转氨酶', '天门冬氨酸氨基转移酶'] }
];

export function createEmptyHealthDocument() {
  return {
    schemaVersion: 1,
    revision: 0,
    timeZone: HEALTH_TIME_ZONE,
    indicators: HEALTH_METRICS.map(metric => ({ ...metric, unit: 'U/L', visible: true, deletedAt: null })),
    reports: [],
    medicationPlans: [
      { id: 'oral', name: '口服用药', cadence: 'daily-slots', frequencyPerDay: 3, times: [], startDate: null, active: true },
      { id: 'topical', name: '晚间外用药', cadence: 'daily', frequencyPerDay: 1, times: [], startDate: null, active: true },
      { id: 'nail-lacquer', name: '涂甲油', cadence: 'interval-days', intervalDays: 3, time: null, startDate: null, active: true }
    ],
    taskCompletions: [],
    calendar: { active: true, version: 1, userConfirmedAt: null, updatedAt: null }
  };
}

export function normalizeMetricCode(value) {
  const input = String(value || '').toLocaleLowerCase().replace(/[\s（）()·._-]/g, '');
  if (!input) return null;
  for (const metric of HEALTH_METRICS) {
    if (metric.aliases.some(alias => input.includes(alias.toLocaleLowerCase().replace(/[\s（）()·._-]/g, '')))) return metric.code;
  }
  return null;
}

export function validateHealthDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validateHealthTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function formatIcsDateTime(date, time) {
  if (!validateHealthDate(date) || !validateHealthTime(time)) throw new Error('Invalid calendar date or time');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
  return utc.getUTCFullYear().toString().padStart(4, '0')
    + String(utc.getUTCMonth() + 1).padStart(2, '0')
    + String(utc.getUTCDate()).padStart(2, '0')
    + 'T' + String(utc.getUTCHours()).padStart(2, '0')
    + String(utc.getUTCMinutes()).padStart(2, '0') + '00Z';
}

export function escapeIcsText(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

export function foldIcsLine(line, maxOctets = 75) {
  const parts = [];
  let current = '';
  let byteCount = 0;
  for (const character of String(line)) {
    const size = new TextEncoder().encode(character).length;
    if (byteCount + size > maxOctets && current) {
      parts.push(current);
      current = ' ';
      byteCount = 1;
    }
    current += character;
    byteCount += size;
  }
  parts.push(current);
  return parts.join('\r\n');
}

function eventLines({ uid, date, time, rule, completedDates }) {
  const lines = [
    'BEGIN:VEVENT',
    'UID:' + uid + '@tirz-tracker',
    'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''),
    'DTSTART:' + formatIcsDateTime(date, time),
    'DURATION:PT5M',
    'SUMMARY:健康计划待确认',
    'DESCRIPTION:请打开健康管理查看计划并记录。',
    'STATUS:CONFIRMED'
  ];
  if (rule) lines.push('RRULE:' + rule);
  const exclusions = [...new Set(completedDates || [])]
    .filter(validateHealthDate)
    .map(day => formatIcsDateTime(day, time));
  exclusions.forEach(value => lines.push('EXDATE:' + value));
  lines.push(
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT0M',
    'DESCRIPTION:健康计划待确认',
    'END:VALARM',
    'END:VEVENT'
  );
  return lines;
}

export function buildHealthCalendar(health) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Walking-SCR//Tirz Tracker//ZH',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:健康用药', 'X-WR-TIMEZONE:Asia/Shanghai'
  ];
  const plans = Array.isArray(health?.medicationPlans) ? health.medicationPlans : [];
  const completions = Array.isArray(health?.taskCompletions) ? health.taskCompletions : [];
  const doneDates = (planId, time) => completions
    .filter(row => row.planId === planId && row.time === time && ['done', 'snoozed'].includes(row.status))
    .map(row => row.date);

  for (const plan of plans) {
    if (plan.active === false || !validateHealthDate(plan.startDate)) continue;
    if (plan.cadence === 'daily-slots' && Array.isArray(plan.times) && plan.times.length === 3 && plan.times.every(validateHealthTime)) {
      plan.times.forEach((time, index) => lines.push(...eventLines({
        uid: plan.id + '-' + (index + 1), date: plan.startDate, time, rule: 'FREQ=DAILY',
        completedDates: doneDates(plan.id, time)
      })));
    } else if (plan.cadence === 'daily' && Array.isArray(plan.times) && plan.times.length === 1 && validateHealthTime(plan.times[0])) {
      lines.push(...eventLines({ uid: plan.id, date: plan.startDate, time: plan.times[0], rule: 'FREQ=DAILY', completedDates: doneDates(plan.id, plan.times[0]) }));
    } else if (plan.cadence === 'interval-days' && plan.intervalDays === 3 && validateHealthTime(plan.time)) {
      lines.push(...eventLines({ uid: plan.id, date: plan.startDate, time: plan.time, rule: 'FREQ=DAILY;INTERVAL=3', completedDates: doneDates(plan.id, plan.time) }));
    }
  }

  completions.filter(row => row.status === 'snoozed' && typeof row.snoozedUntil === 'string').forEach(row => {
    const instant = new Date(row.snoozedUntil);
    if (!Number.isFinite(instant.getTime()) || instant.getTime() <= Date.now()) return;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: HEALTH_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const date = values.year + '-' + values.month + '-' + values.day;
    const time = values.hour + ':' + values.minute;
    lines.push(...eventLines({ uid: 'snooze-' + row.id, date, time, rule: null, completedDates: [] }));
  });

  lines.push('END:VCALENDAR');
  return lines.map(line => foldIcsLine(line)).join('\r\n') + '\r\n';
}

export async function signHealthCalendarVersion(secret, version) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('tirz-tracker:health-calendar:v1:' + version)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyHealthCalendarVersion(secret, version, signature) {
  if (!Number.isSafeInteger(version) || version < 1 || !/^[0-9a-f]{64}$/i.test(String(signature || ''))) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(String(signature).match(/.{2}/g), byte => Number.parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode('tirz-tracker:health-calendar:v1:' + version));
}

export function chronologicalObservations(health, metricCode) {
  return (Array.isArray(health?.reports) ? health.reports : [])
    .flatMap(report => (report.observations || []).filter(row => row.metricCode === metricCode)
      .map(row => ({ ...row, sourceId: report.id, sourceOrder: report.sourceOrder, date: report.dateConfirmed ? report.examDate || report.reportDate : null })))
    .filter(row => validateHealthDate(row.date))
    .sort((a, b) => a.date.localeCompare(b.date) || a.sourceOrder - b.sourceOrder);
}

export function sourceOrderObservations(health, metricCode) {
  return (Array.isArray(health?.reports) ? health.reports : [])
    .flatMap(report => (report.observations || []).filter(row => row.metricCode === metricCode)
      .map(row => ({ ...row, sourceId: report.id, sourceOrder: report.sourceOrder, date: null })))
    .sort((a, b) => a.sourceOrder - b.sourceOrder);
}
