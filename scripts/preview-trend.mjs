// Local-only UI preview. Uses simulated data; never connects to the production API.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const values = [174.7, 171.5, 171, 169.9, 168.5, 167.9, 170.3, 169.6, 169.5, 168.3, 166, 169, 167.8, 167.2, 165.7, 168.3, 169, 167.6, 167.1, 166.8, 166.8];
const records = values.map((weight, index) => {
  const date = new Date();
  date.setDate(date.getDate() - values.length + index + 1);
  date.setHours(8, 0, 0, 0);
  return { id: `preview-${index}`, date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, timestamp: date.getTime(), time: '08:00', weight, tag: '空腹', remark: '设计预览模拟记录', cloudSync: true };
});
const seed = `<script>localStorage.setItem('tirzepatide_weights_v3', ${JSON.stringify(JSON.stringify(records))});localStorage.setItem('tirzepatide_doses_v3','[]');</script>`;
const mime = { '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.css': 'text/css' };
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ preview: true }));
  }
  try {
    if (path === '/' || path === '/index.html') {
      let html = await readFile(resolve(root, 'index.html'), 'utf8');
      html = html.replace('</head>', `${seed}</head>`)
        .replace("if ('serviceWorker' in navigator)", 'if (false)')
        .replace('<main ', '<div style="max-width:448px;margin:0 auto;padding:4px 16px;color:#93A4B8;font:11px system-ui">本地设计预览 · 模拟数据 · 点击或左右滑动曲线查看读数</div><main ');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    const file = resolve(root, '.' + decodeURIComponent(path));
    if (!file.startsWith(root + sep)) throw new Error('Invalid path');
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(4173, '127.0.0.1', () => console.log('Trend design preview: http://127.0.0.1:4173'));
