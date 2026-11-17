import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const indexPath = path.join(rootDir, 'index.html');
const publicIndexPath = path.join(rootDir, 'public/index.html');
const fallbackPath = path.join(rootDir, 'src/fallbackHtml.js');

const htmlContent = fs.readFileSync(indexPath, 'utf-8');

// 1. 同步静态资源至 public/，确保三处副本字节级一致
fs.writeFileSync(publicIndexPath, htmlContent, 'utf-8');

for (const assetName of ['sw.js', 'manifest.json']) {
  const srcAsset = path.join(rootDir, assetName);
  const dstAsset = path.join(rootDir, 'public', assetName);
  if (fs.existsSync(srcAsset)) {
    fs.writeFileSync(dstAsset, fs.readFileSync(srcAsset));
  }
}

for (const dirName of ['icons', 'vendor']) {
  const srcDir = path.join(rootDir, dirName);
  const dstDir = path.join(rootDir, 'public', dirName);
  if (fs.existsSync(srcDir)) {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir)) {
      const srcFile = path.join(srcDir, entry);
      const dstFile = path.join(dstDir, entry);
      if (fs.statSync(srcFile).isFile()) {
        fs.copyFileSync(srcFile, dstFile);
      }
    }
  }
}

// 2. 同步生成 src/fallbackHtml.js（使用纯 Web 标准 TextDecoder + atob，零 Node Buffer 依赖）
const b64 = Buffer.from(htmlContent, 'utf-8').toString('base64');
const fallbackContent = [
  '// This file is generated from index.html for the Worker fallback response.',
  `const B64_HTML = "${b64}";`,
  'let cachedHtml = null;',
  '',
  'export function getFallbackHtml() {',
  '  if (cachedHtml !== null) return cachedHtml;',
  '  const binary = atob(B64_HTML);',
  '  const bytes = new Uint8Array(binary.length);',
  '  for (let i = 0; i < binary.length; i++) {',
  '    bytes[i] = binary.charCodeAt(i);',
  '  }',
  "  cachedHtml = new TextDecoder('utf-8').decode(bytes);",
  '  return cachedHtml;',
  '}',
  ''
].join('\n');

fs.writeFileSync(fallbackPath, fallbackContent, 'utf-8');
console.log('✅ Synchronized index.html, sw.js, manifest.json, icons/, vendor/ -> public/ and src/fallbackHtml.js');
