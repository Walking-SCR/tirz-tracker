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

// 1. 同步至 public/index.html
fs.writeFileSync(publicIndexPath, htmlContent, 'utf-8');

// 2. 同步生成 src/fallbackHtml.js
const b64 = Buffer.from(htmlContent, 'utf-8').toString('base64');
const fallbackContent = `// This file is generated from index.html for the Worker fallback response.\nconst B64_HTML = "${b64}";\n\nexport function getFallbackHtml() {\n  return Buffer.from(B64_HTML, 'base64').toString('utf-8');\n}\n`;

fs.writeFileSync(fallbackPath, fallbackContent, 'utf-8');
console.log('✅ Synchronized index.html -> public/index.html and src/fallbackHtml.js');
