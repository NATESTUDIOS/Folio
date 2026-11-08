// api/browser-test.js
// Standalone test endpoint. Tries multiple Chromium launch strategies
// and reports which one works on the current Vercel runtime.

import path from "node:path";

export default async function handler(req, res) {
  const results = {
    runtime: process.version,
    env: {
      AWS_LAMBDA_JS_RUNTIME: process.env.AWS_LAMBDA_JS_RUNTIME || null,
      VERCEL: process.env.VERCEL || null,
      VERCEL_REGION: process.env.VERCEL_REGION || null,
    },
    stacks: {},
  };

  const testHtml = `<!DOCTYPE html>
<html><head><title>Folio Browser Test</title></head>
<body><h1 id="status">Launched</h1></body></html>`;

  // ── Stack A: Puppeteer + chromium-min with explicit pack URL ──
  try {
    const { default: puppeteer } = await import("puppeteer-core");
    const { default: chromium } = await import("@sparticuz/chromium-min");

    const packUrl =
      "https://github.com/Sparticuz/chromium/releases/download/v141.0.0/chromium-v141.0.0-pack.x64.tar";

    const executablePath = await chromium.executablePath(packUrl);
    const execDir = path.dirname(executablePath);
    process.env.LD_LIBRARY_PATH = execDir;

    const browser = await puppeteer.launch({
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      executablePath,
      headless: "shell",
      timeout: 10000,
    });

    const page = await browser.newPage();
    await page.setContent(testHtml, { waitUntil: "domcontentloaded", timeout: 5000 });
    const title = await page.title();
    await browser.close();

    results.stacks.puppeteer_chromium_min = { ok: true, executablePath, title };
  } catch (err) {
    results.stacks.puppeteer_chromium_min = { ok: false, error: err.message };
  }

  // ── Stack B: Playwright + full chromium ──
  try {
    const { chromium: playwright } = await import("playwright-core");
    const { default: chromium } = await import("@sparticuz/chromium");

    const executablePath = await chromium.executablePath();
    const execDir = path.dirname(executablePath);
    process.env.LD_LIBRARY_PATH = execDir;

    const browser = await playwright.launch({
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      executablePath,
      headless: true,
      timeout: 10000,
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(testHtml, { waitUntil: "domcontentloaded", timeout: 5000 });
    const title = await page.title();
    await browser.close();

    results.stacks.playwright_chromium = { ok: true, executablePath, title };
  } catch (err) {
    results.stacks.playwright_chromium = { ok: false, error: err.message };
  }

  const anyOk = Object.values(results.stacks).some((s) => s.ok);
  return res.status(anyOk ? 200 : 500).json(results);
}

export const config = { runtime: "nodejs", memory: 1024, maxDuration: 30 };