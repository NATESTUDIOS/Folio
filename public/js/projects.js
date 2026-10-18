// public/js/projects.js
// ═══════════════════════════════════════════════════════════════════════
//  FOLIO — Project Metadata Helpers
// ═══════════════════════════════════════════════════════════════════════

import { toast, confirm, relativeTime, formatBytes, esc, icon, el, STORAGE_KEYS } from "./shared.js";
import { db } from "./db.js";


export async function listProjectsWithCounts () {
  const projects = await db.listProjects();
  const results = [];
  for (const p of projects) {
    const [files, versions] = await Promise.all([
      db.listFiles(p.pid),
      db.listVersions(p.pid),
    ]);
    let totalBytes = 0;
    for (const f of files) totalBytes += f.content.length;
    results.push({
      ...p,
      fileCount: files.length,
      versionCount: versions.length,
      totalBytes,
    });
  }
  return results;
}


export async function renameProject (pid, newName) {
  if (!pid) throw new Error("Project ID required");
  const cleaned = String(newName || "").trim();
  if (!cleaned) throw new Error("Name required");
  if (cleaned.length > 60) throw new Error("Name must be 60 characters or less");
  const project = await db.getProject(pid);
  if (!project) throw new Error("Project not found");
  const oldName = project.name;
  project.name = cleaned;
  project.updatedAt = Date.now();
  await db.putProject(project);
  return { ...project, oldName };
}


export async function deleteProjectWithConfirm (pid) {
  const project = await db.getProject(pid);
  if (!project) return false;
  const files = await db.listFiles(pid);
  const versions = await db.listVersions(pid);
  const ok = await confirm({
    title: `Delete "${project.name}"?`,
    message: `This will permanently delete ${files.length} file${files.length === 1 ? "" : "s"} and ${versions.length} version${versions.length === 1 ? "" : "s"}. This cannot be undone.`,
    confirmLabel: "Delete project",
    danger: true,
  });
  if (!ok) return false;
  await db.deleteProject(pid);
  try {
    const lastPid = localStorage.getItem(STORAGE_KEYS.lastProject);
    if (lastPid === pid) {
      localStorage.removeItem(STORAGE_KEYS.lastProject);
      localStorage.removeItem(STORAGE_KEYS.lastFile);
    }
  } catch {}
  return true;
}


export async function duplicateProject (pid) {
  const project = await db.getProject(pid);
  if (!project) throw new Error("Project not found");
  const newPid = `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const newName = `${project.name} (copy)`;
  const newSlug = `${project.slug || "project"}-copy`;
  const newProject = {
    ...project,
    pid: newPid,
    name: newName,
    slug: newSlug,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.putProject(newProject);
  const files = await db.listFiles(pid);
  for (const f of files) {
    await db.putFile(newPid, f.path, f.content, { isPublic: f.isPublic });
  }
  return newProject;
}


export async function exportProjectAsFile (pid) {
  const { transfer } = await import("./db.js");
  const ok = await transfer.exportProject(pid);
  if (ok) {
    const project = await db.getProject(pid);
    toast(`Exported ${project?.name || "project"}`, { type: "success" });
  }
  return ok;
}


export function renderProjectCard (project, opts = {}) {
  const { isActive, onOpen, onRename, onDelete, onDuplicate, onExport } = opts;

  const card = el("div", {
    class: `project-card${isActive ? " active" : ""}`,
    style: isActive ? "border-color:var(--accent);background:var(--accent-soft);" : "",
  },
    el("div", {
      class: "project-card-main",
      role: "button",
      tabindex: "0",
      style: "cursor:pointer;flex:1;min-width:0;display:flex;align-items:center;gap:var(--space-3);",
      onclick: () => onOpen?.(project),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.(project);
        }
      },
    },
      el("div", { class: "project-card-icon" }, icon("folder", 20)),
      el("div", { style: "flex:1;min-width:0" },
        el("div", { class: "project-card-name", style: isActive ? "color:var(--accent)" : "" },
          isActive ? "● " : "",
          project.name
        ),
        el("div", { class: "project-card-meta" },
          `${project.fileCount} file${project.fileCount === 1 ? "" : "s"} · ${project.versionCount} version${project.versionCount === 1 ? "" : "s"} · ${formatBytes(project.totalBytes)} · ${relativeTime(project.updatedAt)}`
        )
      )
    ),
    el("div", { class: "project-card-actions" },
      el("button", {
        class: "btn btn-ghost btn-sm btn-icon",
        type: "button",
        "aria-label": "Rename",
        title: "Rename",
        onclick: (e) => { e.stopPropagation(); onRename?.(project); },
      }, icon("edit", 14)),
      el("button", {
        class: "btn btn-ghost btn-sm btn-icon",
        type: "button",
        "aria-label": "Duplicate",
        title: "Duplicate",
        onclick: (e) => { e.stopPropagation(); onDuplicate?.(project); },
      }, icon("copy", 14)),
      el("button", {
        class: "btn btn-ghost btn-sm btn-icon",
        type: "button",
        "aria-label": "Export",
        title: "Export",
        onclick: (e) => { e.stopPropagation(); onExport?.(project); },
      }, icon("download", 14)),
      el("button", {
        class: "btn btn-ghost btn-sm btn-icon",
        type: "button",
        "aria-label": "Delete",
        title: "Delete",
        style: "color:var(--danger)",
        onclick: (e) => { e.stopPropagation(); onDelete?.(project); },
      }, icon("trash", 14))
    )
  );

  return card;
}