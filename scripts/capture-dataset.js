#!/usr/bin/env node
/**
 * KRONOS Dataset Capture (Playwright)
 *
 * Opens KRONOS locally, uploads dataset files that don't yet have a sidecar,
 * waits for scan COMPLETED, reads window.__kronosGetExportPayload(), and writes:
 *   <file>.<ext>.kronos.json   (same dir as the media file)
 *
 * Usage:
 *   node scripts/capture-dataset.js --url http://localhost:5173
 *
 * Notes:
 * - You must run KRONOS dev server first (npm run dev).
 * - Requires Playwright installed and browsers downloaded.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const REALS_DIR = path.join(ROOT, 'tests', 'dataset', 'reales');
const FAKES_DIR = path.join(ROOT, 'tests', 'dataset', 'fakes');

function parseArgs(argv) {
  const out = { url: 'http://localhost:5173', headful: false, force: false, videoOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[i + 1] ?? out.url;
    if (a === '--headful') out.headful = true;
    if (a === '--force') out.force = true;
    if (a === '--video-only' || a === '--videoOnly') out.videoOnly = true;
  }
  return out;
}

function isMediaFile(name) {
  return /\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|mov|mkv|webm|avi|m4v|3gp|mp3|wav|m4a|aac|ogg|opus|flac|txt|pdf)$/i.test(
    name
  );
}

function kindFromPath(p) {
  const n = path.basename(p).toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(n)) return 'image';
  if (/\.(mp3|wav|m4a|aac|ogg|opus|flac)$/.test(n)) return 'audio';
  if (/\.(mp4|mov|mkv|webm|avi|m4v|3gp)$/.test(n)) return 'video';
  if (/\.(txt|pdf)$/.test(n)) return 'text';
  return 'video';
}

async function listMediaFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(dir, e.name))
    .filter((p) => isMediaFile(path.basename(p)));
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function writeJson(p, obj) {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
}

async function captureOne(page, filePath, sidecarPath) {
  // Switch tab based on file kind (KRONOS ignores mismatched uploads per-tab)
  const kind = kindFromPath(filePath);
  const tabTestId =
    kind === 'image'
      ? 'kronos-tab-image'
      : kind === 'audio'
        ? 'kronos-tab-audio'
        : kind === 'text'
          ? 'kronos-tab-text'
          : 'kronos-tab-video';
  await page.getByTestId(tabTestId).click();

  // Upload via testid
  const input = page.getByTestId('kronos-file-input');
  await input.setInputFiles(filePath);

  // Wait until scan COMPLETED and payload available.
  const fileName = path.basename(filePath);

  await page.getByTestId('kronos-phase').waitFor({ state: 'attached', timeout: 120000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="kronos-phase"]');
      return Boolean(el && (el.textContent ?? '').trim() === 'COMPLETED');
    },
    null,
    { timeout: 900000 }
  );

  await page.waitForFunction(
    (expectedName) => {
      const fn = window.__kronosGetExportPayload;
      if (typeof fn !== 'function') return false;
      const p = fn();
      return Boolean(p && p.file && p.file.name === expectedName && p.riskScore !== undefined);
    },
    fileName,
    { timeout: 60000 }
  );

  const payload = await page.evaluate(() => window.__kronosGetExportPayload());
  if (!payload) throw new Error('No payload returned from __kronosGetExportPayload()');

  await writeJson(sidecarPath, payload);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url;
  const headful = args.headful;

  const realFiles = await listMediaFiles(REALS_DIR);
  const fakeFiles = await listMediaFiles(FAKES_DIR);

  const all = [
    ...realFiles.map((p) => ({ file: p, truth: 'REAL' })),
    ...fakeFiles.map((p) => ({ file: p, truth: 'FAKE' }))
  ];

  const queue = [];
  for (const item of all) {
    if (args.videoOnly && kindFromPath(item.file) !== 'video') continue;
    const sidecar = `${item.file}.kronos.json`;
    const has = await fileExists(sidecar);
    if (args.force || !has) queue.push({ ...item, sidecar });
  }

  console.log(`KRONOS capture-dataset`);
  console.log(`- url: ${url}`);
  console.log(`- headful: ${headful}`);
  console.log(`- force: ${args.force}`);
  console.log(`- video-only: ${args.videoOnly}`);
  console.log(`- total media: ${all.length}`);
  console.log(`- to capture: ${queue.length}`);

  if (!queue.length) return;

  const browser = await chromium.launch({ headless: !headful });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Tell the app we are running automation (disable report modal).
  await page.addInitScript(() => {
    window.__kronosAutomation = true;
  });

  // Load app
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('[data-testid="kronos-file-input"]', { timeout: 120000 });

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const rel = path.relative(ROOT, item.file);
    console.log(`\n[${i + 1}/${queue.length}] Capturing ${item.truth}: ${rel}`);
    try {
      await captureOne(page, item.file, item.sidecar);
      console.log(`Wrote: ${path.relative(ROOT, item.sidecar)}`);
    } catch (err) {
      console.error(`FAILED: ${rel}`);
      console.error(String(err?.message ?? err));
    }
  }

  await context.close();
  await browser.close();
}

run().catch((err) => {
  console.error('capture-dataset failed:', err);
  process.exitCode = 2;
});

