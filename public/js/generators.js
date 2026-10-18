// public/js/generators.js
// ═══════════════════════════════════════════════════════════════════════
//  FOLIO — Dev Tools
//
//  Six client-side tools:
//    1. Picsum         — placeholder image URL generator
//    2. Color          — picker, presets, formats
//    3. Font           — system font stacks with preview
//    4. JSON           — formatter + tree + minifier
//    5. API tester     — client fetch for CORS-friendly endpoints
//    6. OCR            — tesseract.js screenshot → text
//
//  Every tool accepts { onInsert } so it works on /app (inserts into
//  editor) or /tools (copies to clipboard).
// ═══════════════════════════════════════════════════════════════════════

import { $, el, icon, toast, esc, closeSheet } from "./shared.js";


/* ═══════════════════════════════════════════════════════════════════════
   PICSUM
   ═══════════════════════════════════════════════════════════════════════ */

export const picsum = {
  generate (width = 800, height = 600, opts = {}) {
    let url = `https://picsum.photos/${width}/${height}`;
    const params = [];
    if (opts.seed) params.push(`seed=${opts.seed}`);
    if (opts.grayscale) params.push("grayscale");
    if (opts.blur) params.push(`blur=${opts.blur}`);
    if (params.length) url += `?${params.join("&")}`;
    return url;
  },

  render (container, { onInsert } = {}) {
    container.innerHTML = `
      <div class="panel">
        <div class="panel-section">
          <div class="flex gap-2">
            <input type="number" class="input" id="picsumW" placeholder="Width" value="800" min="16" max="4000" style="flex:1">
            <input type="number" class="input" id="picsumH" placeholder="Height" value="600" min="16" max="4000" style="flex:1">
          </div>
          <div class="flex gap-2">
            <input type="text" class="input" id="picsumSeed" placeholder="Seed (optional)" style="flex:1">
            <input type="number" class="input" id="picsumBlur" placeholder="Blur" value="0" min="0" max="10" style="width:100px">
          </div>
          <label class="toggle">
            <input type="checkbox" id="picsumGray">
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="text-sm">Grayscale</span>
          </label>
          <div class="picsum-preview" id="picsumPreview">
            <img id="picsumImg" alt="Picsum preview">
          </div>
          <div class="share-url-row">
            <span class="share-url-text" id="picsumUrl" style="font-family:var(--font-mono)">—</span>
            <button class="btn btn-ghost btn-sm btn-icon" id="picsumCopy" aria-label="Copy">
              <svg><use href="#icon-copy"/></svg>
            </button>
          </div>
          <button class="btn btn-primary btn-block" id="picsumInsert">
            <svg><use href="#icon-plus"/></svg>
            ${onInsert ? "Insert into editor" : "Copy image tag"}
          </button>
        </div>
      </div>
    `;

    const update = () => {
      const w = parseInt($("picsumW").value) || 800;
      const h = parseInt($("picsumH").value) || 600;
      const seed = $("picsumSeed").value.trim();
      const gray = $("picsumGray").checked;
      const blur = parseInt($("picsumBlur").value) || 0;
      const url = this.generate(w, h, { seed, grayscale: gray, blur });
      $("picsumUrl").textContent = url;
      const img = $("picsumImg");
      img.classList.remove("loaded");
      img.onload = () => img.classList.add("loaded");
      img.src = url;
    };

    ["picsumW", "picsumH", "picsumSeed", "picsumGray", "picsumBlur"].forEach(id => {
      $(id)?.addEventListener("input", update);
    });

    $("picsumCopy")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("picsumUrl").textContent);
        toast("URL copied", { type: "success" });
      } catch {
        toast("Couldn't copy", { type: "error" });
      }
    });

    $("picsumInsert")?.addEventListener("click", () => {
      const tag = `<img src="${$("picsumUrl").textContent}" alt="">`;
      if (onInsert) {
        onInsert(tag);
        closeSheet();
      } else {
        navigator.clipboard.writeText(tag).then(() => {
          toast("Image tag copied", { type: "success" });
        }).catch(() => {
          toast("Couldn't copy", { type: "error" });
        });
      }
    });

    update();
  },
};


/* ═══════════════════════════════════════════════════════════════════════
   COLOR
   ═══════════════════════════════════════════════════════════════════════ */

export const color = {
  PRESETS: [
    "#F59E0B", "#EF4444", "#10B981", "#3B82F6", "#8B5CF6", "#EC4899",
    "#F97316", "#14B8A6", "#6366F1", "#84CC16", "#D946EF", "#0EA5E9",
  ],

  hexToRgb (hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16),
    } : { r: 0, g: 0, b: 0 };
  },

  rgbToHsl (r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  },

  renderFormats (container, hex) {
    const rgb = this.hexToRgb(hex);
    const hsl = this.rgbToHsl(rgb.r, rgb.g, rgb.b);
    const formats = [
      { label: "HEX", value: hex.toUpperCase() },
      { label: "RGB", value: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` },
      { label: "HSL", value: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)` },
      { label: "CSS", value: `--color: ${hex};` },
    ];

    container.innerHTML = "";
    formats.forEach(f => {
      container.appendChild(el("div", { class: "share-url-row" },
        el("span", { class: "text-xs text-muted", style: "min-width:50px;flex-shrink:0" }, f.label),
        el("span", { class: "share-url-text", style: "font-family:var(--font-mono)" }, f.value),
        el("button", {
          class: "btn btn-ghost btn-sm btn-icon",
          type: "button",
          "aria-label": "Copy",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(f.value);
              toast("Copied", { type: "success", duration: 1200 });
            } catch {
              toast("Couldn't copy", { type: "error" });
            }
          },
        }, icon("copy", 14))
      ));
    });
  },

  render (container, { onInsert } = {}) {
    container.innerHTML = `
      <div class="panel">
        <div class="panel-section">
          <div class="panel-section-header">
            <span class="panel-section-title">Pick a color</span>
          </div>
          <div class="flex gap-2 items-center">
            <input type="color" id="colorPicker" value="#F59E0B" style="width:64px;height:44px;border-radius:10px;border:1px solid var(--border);cursor:pointer;">
            <input type="text" class="input" id="colorHex" value="#F59E0B" style="flex:1" maxlength="9">
          </div>
        </div>
        <div class="panel-section">
          <div class="panel-section-header">
            <span class="panel-section-title">Formats</span>
          </div>
          <div id="colorFormats" class="flex flex-col gap-2"></div>
        </div>
        <div class="panel-section">
          <div class="panel-section-header">
            <span class="panel-section-title">Presets</span>
          </div>
          <div class="color-grid" id="colorPresets"></div>
        </div>
      </div>
    `;

    const update = () => {
      const hex = $("colorPicker").value;
      $("colorHex").value = hex.toUpperCase();
      this.renderFormats($("colorFormats"), hex);
    };

    const presets = $("colorPresets");
    this.PRESETS.forEach(c => {
      presets.appendChild(el("div", {
        class: "color-swatch",
        style: `background:${c}`,
        title: c,
        onclick: () => {
          $("colorPicker").value = c;
          update();
        },
      }));
    });

    $("colorPicker").addEventListener("input", update);
    $("colorHex").addEventListener("input", (e) => {
      const v = e.target.value.trim();
      if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
        $("colorPicker").value = v;
        update();
      }
    });

    update();
  },
};


/* ═══════════════════════════════════════════════════════════════════════
   FONT
   ═══════════════════════════════════════════════════════════════════════ */

export const font = {
  STACKS: [
    { name: "System", value: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' },
    { name: "Inter", value: '"Inter", system-ui, sans-serif' },
    { name: "Serif", value: 'Georgia, "Times New Roman", serif' },
    { name: "Mono", value: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace' },
    { name: "Rounded", value: '"SF Pro Rounded", "Nunito", system-ui, sans-serif' },
    { name: "Handwriting", value: '"Caveat", "Comic Sans MS", cursive' },
  ],

  render (container, { onInsert } = {}) {
    container.innerHTML = `
      <div class="panel">
        <div class="panel-section">
          <div class="panel-section-header">
            <span class="panel-section-title">Font stacks</span>
          </div>
          <div class="flex flex-col gap-2" id="fontList"></div>
        </div>
        <div class="panel-section">
          <div class="panel-section-header">
            <span class="panel-section-title">Preview</span>
          </div>
          <div class="card">
            <div id="fontPreview" style="font-size:16px;line-height:1.5">
              The quick brown fox jumps over the lazy dog.
            </div>
          </div>
        </div>
      </div>
    `;

    const listEl = $("fontList");
    this.STACKS.forEach(stack => {
      listEl.appendChild(el("div", { class: "share-url-row" },
        el("span", { class: "text-sm", style: `font-family:${stack.value};flex:1;min-width:0` }, stack.name),
        el("button", {
          class: "btn btn-ghost btn-sm btn-icon",
          type: "button",
          "aria-label": "Copy",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(stack.value);
              toast(`${stack.name} copied`, { type: "success", duration: 1200 });
              $("fontPreview").style.fontFamily = stack.value;
            } catch {
              toast("Couldn't copy", { type: "error" });
            }
          },
        }, icon("copy", 14))
      ));
    });
  },
};


/* ═══════════════════════════════════════════════════════════════════════
   JSON
   ═══════════════════════════════════════════════════════════════════════ */

export const json = {
  render (container, { onInsert } = {}) {
    container.innerHTML = `
      <div class="panel">
        <div class="panel-section">
          <div class="panel-section-header">
            <span class="panel-section-title">JSON</span>
            <div class="flex gap-2">
              <button class="btn btn-secondary btn-sm" id="jsonFormat">Format</button>
              <button class="btn btn-secondary btn-sm" id="jsonMinify">Minify</button>
            </div>
          </div>
          <textarea class="textarea" id="jsonInput" placeholder='{"hello": "world"}' style="min-height:200px"></textarea>
          <div class="flex gap-2 mt-2">
            <button class="btn btn-primary btn-block" id="jsonInsert">
              <svg><use href="#icon-plus"/></svg>
              ${onInsert ? "Insert" : "Copy"}
            </button>
            <button class="btn btn-secondary btn-block" id="jsonCopy">Copy</button>
          </div>
        </div>
      </div>
    `;

    $("jsonFormat")?.addEventListener("click", () => {
      try {
        const parsed = JSON.parse($("jsonInput").value);
        $("jsonInput").value = JSON.stringify(parsed, null, 2);
      } catch (err) {
        toast("Invalid JSON: " + err.message.split(" ")[0], { type: "error" });
      }
    });

    $("jsonMinify")?.addEventListener("click", () => {
      try {
        const parsed = JSON.parse($("jsonInput").value);
        $("jsonInput").value = JSON.stringify(parsed);
      } catch {
        toast("Invalid JSON", { type: "error" });
      }
    });

    $("jsonInsert")?.addEventListener("click", () => {
      const val = $("jsonInput").value;
      if (onInsert) {
        onInsert(val);
        closeSheet();
      } else {
        navigator.clipboard.writeText(val).then(() => {
          toast("Copied", { type: "success" });
        }).catch(() => {
          toast("Couldn't copy", { type: "error" });
        });
      }
    });

    $("jsonCopy")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("jsonInput").value);
        toast("Copied", { type: "success" });
      } catch {
        toast("Couldn't copy", { type: "error" });
      }
    });
  },
};


/* ═══════════════════════════════════════════════════════════════════════
   API TESTER
   ═══════════════════════════════════════════════════════════════════════ */

export const api = {
  render (container) {
    container.innerHTML = `
      <div class="panel">
        <div class="panel-section">
          <div class="flex gap-2">
            <select class="select" id="apiMethod" style="width:100px">
              <option>GET</option>
              <option>POST</option>
              <option>PUT</option>
              <option>DELETE</option>
            </select>
            <input type="url" class="input" id="apiUrl" placeholder="https://api.example.com/endpoint" style="flex:1">
          </div>
          <textarea class="textarea" id="apiBody" placeholder="Request body (JSON, POST/PUT only)" style="min-height:80px"></textarea>
          <button class="btn btn-primary btn-block" id="apiSend">Send request</button>
        </div>
        <div class="panel-section">
          <div class="panel-section-header">
            <span class="panel-section-title">Response</span>
          </div>
          <div id="apiResponse"></div>
        </div>
        <div class="alert alert-info">
          <svg><use href="#icon-info"/></svg>
          <div>Only APIs that allow cross-origin requests will work. This runs entirely in your browser.</div>
        </div>
      </div>
    `;

    $("apiSend")?.addEventListener("click", async () => {
      const method = $("apiMethod").value;
      const url = $("apiUrl").value.trim();
      const body = $("apiBody").value.trim();

      if (!url) {
        toast("Enter a URL", { type: "warning" });
        return;
      }

      const respEl = $("apiResponse");
      respEl.innerHTML = `<div class="api-status-badge pending">Sending…</div>`;

      const start = performance.now();
      try {
        const options = { method };
        if (method !== "GET" && body) {
          options.body = body;
          options.headers = { "content-type": "application/json" };
        }

        const res = await fetch(url, options);
        const elapsed = Math.round(performance.now() - start);
        const text = await res.text();

        let formatted = text;
        try {
          formatted = JSON.stringify(JSON.parse(text), null, 2);
        } catch {}

        respEl.innerHTML = `
          <div class="api-status-badge ${res.ok ? "ok" : "err"}">${res.status} ${res.statusText} · ${elapsed}ms</div>
          <pre class="api-response">${esc(formatted.slice(0, 5000))}</pre>
        `;
      } catch (err) {
        const elapsed = Math.round(performance.now() - start);
        respEl.innerHTML = `
          <div class="api-status-badge err">Failed · ${elapsed}ms</div>
          <div class="api-response">${esc(err.message || "Network error")}</div>
        `;
      }
    });
  },
};


/* ═══════════════════════════════════════════════════════════════════════
   OCR
   ═══════════════════════════════════════════════════════════════════════ */

export const ocr = {
  render (container, { onInsert } = {}) {
    container.innerHTML = `
      <div class="panel">
        <div class="panel-section">
          <div class="panel-section-header">
            <span class="panel-section-title">Screenshot to text</span>
          </div>
          <div class="alert alert-info">
            <svg><use href="#icon-info"/></svg>
            <div>OCR loads the Tesseract.js WASM engine (~2 MB, one-time). Text extraction runs entirely on your device.</div>
          </div>
          <input type="file" id="ocrFile" accept="image/*" class="input">
          <div id="ocrProgress" class="hidden">
            <div class="text-sm text-muted" id="ocrStatus">Loading engine…</div>
          </div>
          <div id="ocrOutput" class="hidden">
            <div class="panel-section-header">
              <span class="panel-section-title">Extracted text</span>
            </div>
            <textarea class="textarea" id="ocrText" placeholder="Extracted text appears here" style="min-height:160px"></textarea>
            <button class="btn btn-primary btn-block" id="ocrInsert">
              <svg><use href="#icon-plus"/></svg>
              ${onInsert ? "Insert into editor" : "Copy text"}
            </button>
          </div>
        </div>
      </div>
    `;

    $("ocrFile")?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      $("ocrProgress").classList.remove("hidden");
      $("ocrStatus").textContent = "Loading engine…";

      try {
        const tesseract = await import("https://esm.sh/tesseract.js@5.0.4");
        $("ocrStatus").textContent = "Recognizing text…";

        const { data } = await tesseract.recognize(file, "eng", {
          logger: (m) => {
            if (m.status === "recognizing text") {
              $("ocrStatus").textContent = `Recognizing… ${Math.round(m.progress * 100)}%`;
            }
          },
        });

        $("ocrProgress").classList.add("hidden");
        $("ocrOutput").classList.remove("hidden");
        $("ocrText").value = data.text || "(No text detected)";
      } catch {
        $("ocrProgress").classList.add("hidden");
        toast("OCR failed. Try a clearer image.", { type: "error" });
      }
    });

    $("ocrInsert")?.addEventListener("click", () => {
      const text = $("ocrText").value;
      if (onInsert) {
        onInsert(text);
        closeSheet();
      } else {
        navigator.clipboard.writeText(text).then(() => {
          toast("Copied", { type: "success" });
        }).catch(() => {
          toast("Couldn't copy", { type: "error" });
        });
      }
    });
  },
};


/* ═══════════════════════════════════════════════════════════════════════
   REGISTRY
   ═══════════════════════════════════════════════════════════════════════ */

export const generators = {
  picsum,
  color,
  font,
  json,
  api,
  ocr,
};

export const TOOL_META = [
  { id: "picsum", name: "Picsum",   desc: "Placeholder images",     icon: "image"   },
  { id: "color",  name: "Colors",   desc: "Palettes and formats",   icon: "palette" },
  { id: "font",   name: "Fonts",    desc: "System font stacks",     icon: "type"    },
  { id: "json",   name: "JSON",     desc: "Format and minify",      icon: "braces"  },
  { id: "api",    name: "API",      desc: "Test CORS endpoints",    icon: "send"    },
  { id: "ocr",    name: "OCR",      desc: "Screenshot to text",     icon: "scan"    },
];