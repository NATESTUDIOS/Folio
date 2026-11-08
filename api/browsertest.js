
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export default async function handler(req, res) {
  const result = {
    runtime: process.version,
    envBefore: {
      VERCEL: process.env.VERCEL,
      AWS_LAMBDA_JS_RUNTIME: process.env.AWS_LAMBDA_JS_RUNTIME,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || null,
    },
  };

  try {
    const { default: puppeteer } = await import("puppeteer-core");
    const { default: chromium } = await import("@sparticuz/chromium-min");

    const packUrl =
      "https://github.com/Sparticuz/chromium/releases/download/v141.0.0/chromium-v141.0.0-pack.x64.tar";

    const executablePath = await chromium.executablePath(packUrl);

    // IMPORTANT:
    // Do not overwrite LD_LIBRARY_PATH.
    // Let @sparticuz/chromium configure its own library paths.

    const candidates = [
      "/tmp",
      "/tmp/al2023/lib",
      "/tmp/chromium-pack",
      "/tmp/chromium",
    ];

    const libraries = {};

    for (const dir of candidates) {
      if (existsSync(dir)) {
        try {
          libraries[dir] = readdirSync(dir).slice(0, 40);
        } catch (e) {
          libraries[dir] = e.message;
        }
      }
    }

    result.extraction = {
      executablePath,
      executableExists: existsSync(executablePath),
      envAfter: {
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || null,
        AWS_LAMBDA_JS_RUNTIME: process.env.AWS_LAMBDA_JS_RUNTIME,
        VERCEL: process.env.VERCEL,
      },
      libraries,
      required: {
        nspr: existsSync("/tmp/al2023/lib/libnspr4.so"),
        nss: existsSync("/tmp/al2023/lib/libnss3.so"),
        nsprTmp: existsSync("/tmp/libnspr4.so"),
      },
    };

    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: "shell",
      timeout: 15000,
    });

    try {
      const page = await browser.newPage();

      await page.setContent(
        "<html><head><title>Folio Browser Test</title></head></html>"
      );

      result.browser = {
        ok: true,
        title: await page.title(),
      };
    } finally {
      await browser.close();
    }
  } catch (err) {
    result.browser = {
      ok: false,
      error: err.message,
      stack: err.stack,
    };
  }

  return res.status(result.browser?.ok ? 200 : 500).json(result);
}

export const config = {
  runtime: "nodejs",
  memory: 1024,
  maxDuration: 30,
};
