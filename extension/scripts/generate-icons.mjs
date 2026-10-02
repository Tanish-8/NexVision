/**
 * Generates the official NexVision AI Chrome extension icons in 16x16, 32x32, 48x48, and 128x128.
 * Uses headless Chrome to render the exact vector geometry with antialiasing onto an HTML5 canvas.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const iconsDir = join(rootDir, 'icons');

if (!existsSync(iconsDir)) {
  mkdirSync(iconsDir, { recursive: true });
}

const htmlContent = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<div id="results"></div>
<script>
function renderIcon(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Draw background rounded rectangle (squircle)
  const r = size * 0.22;
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#6366f1');   // Indigo
  grad.addColorStop(0.5, '#7c3aed'); // Violet
  grad.addColorStop(1, '#8b5cf6');   // Purple

  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Subtle inner glow / border for extra polish
  if (size >= 32) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = Math.max(1, size * 0.02);
    ctx.stroke();
  }

  // Draw layered vision / AI geometric symbol
  ctx.save();
  if (size <= 16) {
    // Highly optimized for 16x16 pixel grid
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Top rhombus
    ctx.beginPath();
    ctx.moveTo(8, 2.5);
    ctx.lineTo(13.5, 5);
    ctx.lineTo(8, 7.5);
    ctx.lineTo(2.5, 5);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fill();
    ctx.stroke();

    // Middle chevron
    ctx.beginPath();
    ctx.moveTo(3, 8.5);
    ctx.lineTo(8, 11);
    ctx.lineTo(13, 8.5);
    ctx.stroke();

    // Bottom chevron
    ctx.beginPath();
    ctx.moveTo(3, 11.5);
    ctx.lineTo(8, 14);
    ctx.lineTo(13, 11.5);
    ctx.stroke();
  } else {
    // Scaled vector glyph for 32, 48, 128
    const glyphScale = (size * 0.58) / 20;
    ctx.translate((size - 24 * glyphScale) / 2, (size - 24 * glyphScale) / 2);
    ctx.scale(glyphScale, glyphScale);

    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = size <= 32 ? 2.2 : 2.0;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 1. Top rhombus
    ctx.beginPath();
    ctx.moveTo(12, 2.5);
    ctx.lineTo(21.5, 7.25);
    ctx.lineTo(12, 12);
    ctx.lineTo(2.5, 7.25);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 2. Middle chevron
    ctx.beginPath();
    ctx.moveTo(2.5, 12);
    ctx.lineTo(12, 16.75);
    ctx.lineTo(21.5, 12);
    ctx.stroke();

    // 3. Bottom chevron
    ctx.beginPath();
    ctx.moveTo(2.5, 16.75);
    ctx.lineTo(12, 21.5);
    ctx.lineTo(21.5, 16.75);
    ctx.stroke();
  }
  ctx.restore();

  return canvas.toDataURL('image/png');
}

const sizes = [16, 32, 48, 128];
const res = {};
sizes.forEach(s => { res[s] = renderIcon(s); });
document.getElementById('results').innerText = JSON.stringify(res);
</script>
</body>
</html>`;

const tempHtmlPath = join(iconsDir, 'render_temp.html');
writeFileSync(tempHtmlPath, htmlContent, 'utf-8');

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fileUrl = 'file:///' + tempHtmlPath.replace(/\\/g, '/');

console.log('Rendering official NexVision AI icons with headless Chrome...');
const output = execFileSync(chromePath, ['--headless=new', '--dump-dom', fileUrl], { maxBuffer: 10 * 1024 * 1024 }).toString();

const match = output.match(/<div id="results">([\s\S]*?)<\/div>/);
if (match) {
  const data = JSON.parse(match[1]);
  for (const size of [16, 32, 48, 128]) {
    const base64Data = data[size].replace(/^data:image\/png;base64,/, '');
    const buf = Buffer.from(base64Data, 'base64');
    const targetPath = join(iconsDir, `icon${size}.png`);
    writeFileSync(targetPath, buf);
    console.log(`✓ Generated ${targetPath} (${buf.length} bytes)`);
  }
} else {
  console.error('Failed to parse results from Chrome output');
  process.exit(1);
}

// Clean up temp html file
try {
  const { unlinkSync } = await import('node:fs');
  unlinkSync(tempHtmlPath);
} catch {
  // ignore
}
