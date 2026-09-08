/**
 * Build script: compiles TypeScript and copies manifest to dist/
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const srcDir = join(rootDir, 'src');
const distDir = join(rootDir, 'dist');
const manifestPath = join(rootDir, 'manifest.json');

// Clean dist directory
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true });
}
mkdirSync(distDir, { recursive: true });

// Compile TypeScript
console.log('TypeScript compilation...');
try {
  execSync('npx tsc --outDir dist', { cwd: rootDir, stdio: 'inherit' });
  console.log('✓ TypeScript compiled');
} catch {
  console.error('✗ TypeScript compilation failed');
  process.exit(1);
}

// Create subdirectories in dist
mkdirSync(join(distDir, 'background'), { recursive: true });
mkdirSync(join(distDir, 'content'), { recursive: true });
mkdirSync(join(distDir, 'popup'), { recursive: true });
mkdirSync(join(distDir, 'icons'), { recursive: true });

// Bundle content script with esbuild
console.log('Bundling content script...');
try {
  execSync(
    `npx esbuild ${join(srcDir, 'content', 'content-script.ts')} --bundle --format=iife --platform=browser --target=es2022 --loader:.ts=ts --outfile=${join(distDir, 'content', 'content-script.js')} --log-level=error`,
    { cwd: rootDir, stdio: 'inherit' }
  );
  console.log('✓ Content script bundled');
} catch {
  console.error('✗ Content script bundling failed');
  process.exit(1);
}

// Copy manifest.json to dist
copyFileSync(manifestPath, join(distDir, 'manifest.json'));

// Copy CSS
mkdirSync(join(srcDir, 'popup'), { recursive: true });
copyFileSync(join(srcDir, 'popup', 'styles.css'), join(distDir, 'popup', 'styles.css'));

// Copy popup HTML
copyFileSync(join(srcDir, 'popup', 'popup.html'), join(distDir, 'popup', 'popup.html'));

// Copy placeholder icons (minimal valid 1x1 transparent PNG)
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const iconPlaceholder = Buffer.from(pngBase64, 'base64');
['16', '48', '128'].forEach(size => {
  writeFileSync(join(distDir, 'icons', `icon${size}.png`), iconPlaceholder);
});

console.log('✓ Build complete — output in extension/dist');