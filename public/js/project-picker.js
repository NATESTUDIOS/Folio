// public/js/project-picker.js
// ═══════════════════════════════════════════════════════════════════════
//  FOLIO — Project Picker
// ═══════════════════════════════════════════════════════════════════════

import {
  $, el, icon,
  toast, openSheet, closeSheet,
  relativeTime, esc, STORAGE_KEYS,
} from "./shared.js";

import { db } from "./db.js";


export async function renderProjectPicker ({ onSelect, excludePid } = {}) {
  const tpl = $("tpl-project-picker");
  if (!tpl) {
    toast("Project picker unavailable", { type: "error" });
    return;
  }

  openSheet({ title: "Choose a project", body: tpl.content.cloneNode(true) });

  const listEl = $("projectPickerList");
  if (!listEl) return;

  const allProjects = await db.listProjects();
  const projects = excludePid ? allProjects.filter(p => p.pid !== excludePid) : allProjects;

  listEl.innerHTML = "";

  if (projects.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
        </div>
        <div class="empty-state-title">No projects yet</div>
        <div class="empty-state-desc">Create your first project to start editing.</div>
      </div>
    `;
  } else {
    for (const p of projects) {
      const [files, versions] = await Promise.all([
        db.listFiles(p.pid),
        db.listVersions(p.pid),
      ]);

      const row = el("div", {
        class: "list-row",
        role: "button",
        tabindex: "0",
        style: "cursor:pointer",
        onclick: async () => {
          closeSheet();
          if (onSelect) {
            await onSelect(p);
          } else {
            try { localStorage.setItem(STORAGE_KEYS.lastProject, p.pid); } catch {}
            window.location.href = "/app";
          }
        },
        onkeydown: async (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            closeSheet();
            if (onSelect) await onSelect(p);
            else {
              try { localStorage.setItem(STORAGE_KEYS.lastProject, p.pid); } catch {}
              window.location.href = "/app";
            }
          }
        },
      },
        el("div", { style: "flex:1;min-width:0" },
          el("div", { class: "font-semibold" }, p.name),
          el("div", { class: "text-xs text-muted" },
            `${files.length} file${files.length === 1 ? "" : "s"} · ${versions.length} version${versions.length === 1 ? "" : "s"} · ${relativeTime(p.updatedAt)}`
          )
        ),
        icon("chevron-right", 16)
      );
      listEl.appendChild(row);
    }
  }

  const sheetBody = $("sheetBody");
  if (!sheetBody) return;

  sheetBody.querySelector("[data-action='create-project']")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const name = prompt("Project name:");
    if (!name) return;
    const cleaned = name.trim();
    if (!cleaned) return;

    btn.classList.add("loading");
    btn.disabled = true;

    try {
      const project = await createProject(cleaned);
      closeSheet();
      toast(`Created ${cleaned}`, { type: "success" });
      if (onSelect) await onSelect(project);
      else {
        try { localStorage.setItem(STORAGE_KEYS.lastProject, project.pid); } catch {}
        window.location.href = "/app";
      }
    } catch (err) {
      btn.classList.remove("loading");
      btn.disabled = false;
      toast(err.message || "Couldn't create project", { type: "error" });
    }
  });

  sheetBody.querySelector("[data-action='open-folder-picker']")?.addEventListener("click", () => {
    toast("Folder access requires Chrome Android 132+", { type: "info", duration: 4000 });
  });

  sheetBody.querySelector("[data-action='import-zip']")?.addEventListener("click", () => {
    toast("Backup import coming soon", { type: "info" });
  });
}


export async function createProject (name) {
  const cleaned = name.trim();
  if (!cleaned) throw new Error("Project name required");
  if (cleaned.length > 60) throw new Error("Name must be 60 characters or less");

  const pid = `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const slug = cleaned.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "project";

  const project = {
    pid,
    name: cleaned,
    slug,
    description: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await db.putProject(project);
  await db.putFile(pid, "index.html", `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(cleaned)}</title>
</head>
<body>
  <h1>${esc(cleaned)}</h1>
</body>
</html>`);

  return project;
}


export function wireEmptyState () {
  $("emptyPickProject")?.addEventListener("click", () => {
    renderProjectPicker({
      onSelect: async (project) => {
        const { workspace } = await import("./editor.js");
        await workspace.openProject(project);
      },
    });
  });
}