import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { esc, showToast } from "./utils.js";
import {
  ACCENT,
  ACCENT_DIM,
  BORDER,
  BORDER_SOFT,
  DANGER,
  DANGER_DIM,
  FONT_MONO,
  FONT_UI,
  LD_ICONS,
  SURFACE,
  SURFACE_DEEP,
  SURFACE_RAISED,
  TEXT,
  TEXT_DIM,
  TEXT_FAINT,
  ensureTheme,
  isolateModalEvents,
} from "./livedev-theme.js";

let activeModal = null;
let projectCache = [];
let scanResultsMap = {}; // node_name -> report
let conflictLogMap = {}; // canonical_name -> snapshot entry
let activeFilter = "all"; // 'all', 'issues', 'clean', 'unscanned'
let searchQuery = "";
let expandedProjects = new Set();
let rollbackDrawerOpen = false;

export function closeDependenciesPopup() {
  if (activeModal) {
    try {
      activeModal.remove();
    } catch (e) {}
    activeModal = null;
  }
}

async function fetchConflictLog() {
  try {
    const res = await api.fetchApi("/livedev/deps/conflict_log");
    const data = await res.json();
    if (data.ok && data.log && typeof data.log === "object") {
      conflictLogMap = data.log;
    }
  } catch (e) {
    // Non-fatal: keep last known log
  }
}

async function rescanNodeReport(nodeName) {
  if (!nodeName) return;
  try {
    const res = await api.fetchApi("/livedev/deps/scan_node", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_name: nodeName }),
    });
    const report = await res.json();
    if (report.ok) {
      scanResultsMap[nodeName] = report;
    }
  } catch (e) {}
}

/**
 * Open the main Dependencies Hub Window.
 * Displays all projects collapsed by default, with per-project scan, full scan,
 * conflict install protection, and one-click rollback to prior versions.
 */
export async function openDependenciesHub(targetNode = null, initialReport = null) {
  closeDependenciesPopup();
  ensureTheme();

  if (targetNode && initialReport) {
    scanResultsMap[targetNode] = initialReport;
    expandedProjects.add(targetNode);
  }

  const overlay = document.createElement("div");
  overlay.className = "livedev-deps-overlay ld-overlay";
  overlay.style.cssText = "direction:ltr;text-align:left;";
  isolateModalEvents(overlay);

  const onEsc = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener("keydown", onEsc, true);
      closeDependenciesPopup();
    }
  };
  document.addEventListener("keydown", onEsc, true);
  const closeAll = () => {
    document.removeEventListener("keydown", onEsc, true);
    closeDependenciesPopup();
  };

  overlay.onclick = (e) => {
    e.stopPropagation();
    if (e.target === overlay) closeAll();
  };

  const modal = document.createElement("div");
  modal.className = "livedev-deps-modal ld-modal";
  modal.style.cssText = "width:960px;height:88vh;";
  modal.onclick = (e) => e.stopPropagation();

  // 1. Header
  const header = document.createElement("div");
  header.className = "ld-modal-head";

  const titleBox = document.createElement("div");
  titleBox.className = "ld-modal-title-wrap";
  const title = document.createElement("h3");
  title.className = "ld-modal-title";
  title.innerHTML = `<span class="ld-modal-title-ico">${LD_ICONS.box}</span><span>LiveDev Dependencies Hub</span>`;

  const subtitle = document.createElement("div");
  subtitle.className = "ld-modal-sub";
  subtitle.textContent =
    "Scan custom_nodes dependencies, detect version conflicts, install safely, and roll back any changed package.";

  titleBox.appendChild(title);
  titleBox.appendChild(subtitle);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ld-modal-close";
  closeBtn.textContent = "\u2715";
  closeBtn.title = "Close (Esc)";
  closeBtn.onclick = closeAll;

  header.appendChild(titleBox);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // 2. Control Toolbar
  const toolbar = document.createElement("div");
  toolbar.style.cssText =
    "padding:12px 18px;background:rgba(0,0,0,0.22);border-bottom:1px solid rgba(255,255,255,0.07);display:flex;flex-direction:column;gap:10px;flex-shrink:0;";

  const toolRow1 = document.createElement("div");
  toolRow1.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;";

  const leftActions = document.createElement("div");
  leftActions.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";

  const scanAllBtn = document.createElement("button");
  scanAllBtn.type = "button";
  scanAllBtn.className = "ld-btn ld-btn-primary";
  scanAllBtn.innerHTML = LD_ICONS.search + "<span>Scan All Projects</span>";

  const rollbackToggleBtn = document.createElement("button");
  rollbackToggleBtn.type = "button";
  rollbackToggleBtn.className = "ld-btn";
  rollbackToggleBtn.style.display = "none";
  rollbackToggleBtn.onclick = () => {
    rollbackDrawerOpen = !rollbackDrawerOpen;
    renderRollbackDrawer();
  };

  leftActions.appendChild(scanAllBtn);
  leftActions.appendChild(rollbackToggleBtn);

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "ld-input";
  searchInput.placeholder = "Search project by name...";
  searchInput.value = searchQuery;
  searchInput.style.cssText = "flex:1;min-width:200px;max-width:320px;";

  searchInput.oninput = (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderProjectList();
  };

  toolRow1.appendChild(leftActions);
  toolRow1.appendChild(searchInput);
  toolbar.appendChild(toolRow1);

  // Filter Pills & Summary Row
  const toolRow2 = document.createElement("div");
  toolRow2.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12px;";

  const pillsContainer = document.createElement("div");
  pillsContainer.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";

  const filters = [
    { id: "all", label: "All Projects" },
    { id: "issues", label: "Issues & Conflicts" },
    { id: "clean", label: "Clean & Satisfied" },
    { id: "unscanned", label: "Unscanned" },
  ];

  function updatePills() {
    pillsContainer.innerHTML = "";
    filters.forEach((f) => {
      const pill = document.createElement("button");
      pill.type = "button";
      const isSelected = activeFilter === f.id;
      pill.style.cssText =
        "padding:3px 10px;border-radius:14px;font-size:11.5px;cursor:pointer;border:1px solid " +
        (isSelected ? ACCENT : BORDER_SOFT) +
        ";background:" +
        (isSelected ? ACCENT_DIM : SURFACE) +
        ";color:" +
        (isSelected ? "#fff" : TEXT_DIM) +
        ";transition:0.15s;font-family:" +
        FONT_UI +
        ";";
      pill.textContent = f.label;
      pill.onclick = () => {
        activeFilter = f.id;
        updatePills();
        renderProjectList();
      };
      pillsContainer.appendChild(pill);
    });
  }
  updatePills();

  const statsText = document.createElement("div");
  statsText.style.cssText = "color:" + TEXT_FAINT + ";font-size:11.5px;";

  toolRow2.appendChild(pillsContainer);
  toolRow2.appendChild(statsText);
  toolbar.appendChild(toolRow2);
  modal.appendChild(toolbar);

  // 2b. Rollback Snapshots Drawer (shown when toggled and entries exist)
  const rollbackDrawer = document.createElement("div");
  rollbackDrawer.style.cssText =
    "display:none;max-height:210px;overflow-y:auto;padding:10px 20px;background:" +
    SURFACE +
    ";border-bottom:1px solid " +
    BORDER_SOFT +
    ";flex-shrink:0;";
  modal.appendChild(rollbackDrawer);

  // 3. Scrollable Project List Container (block flow prevents flex height compression/overlap)
  const listContainer = document.createElement("div");
  listContainer.style.cssText =
    "flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:14px 20px;display:block;box-sizing:border-box;";
  modal.appendChild(listContainer);

  // 4. Footer
  const footer = document.createElement("div");
  footer.className = "ld-modal-foot";
  footer.style.justifyContent = "space-between";

  const footerInfo = document.createElement("span");
  footerInfo.style.cssText = "color:" + TEXT_DIM + ";font-size:11.5px;";
  footerInfo.textContent =
    "Every install records its previous version so you can roll back safely without leaving duplicate versions.";

  const footerCloseBtn = document.createElement("button");
  footerCloseBtn.type = "button";
  footerCloseBtn.className = "ld-btn ld-btn-primary";
  footerCloseBtn.textContent = "Done";
  footerCloseBtn.onclick = closeAll;

  footer.appendChild(footerInfo);
  footer.appendChild(footerCloseBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  activeModal = overlay;

  async function runRollback(canonicalName, affectedNode, triggerBtn) {
    const snap = conflictLogMap[canonicalName];
    if (!snap) return;
    const isUninstall = snap.old_version === "__none__";
    const promptMsg = isUninstall
      ? `Undo installation of '${canonicalName}'?\n\nThis will uninstall '${canonicalName}' since it was not installed previously.`
      : `Roll back '${canonicalName}' to previous version '${snap.old_version}'?\n\nCurrent spec installed: ${snap.new_spec}\nThis cleanly restores version ${snap.old_version} without duplicate copies.`;
    if (!confirm(promptMsg)) return;

    const origText = triggerBtn.textContent;
    triggerBtn.disabled = true;
    triggerBtn.textContent = "Rolling back...";
    triggerBtn.style.opacity = "0.7";

    try {
      const res = await api.fetchApi("/livedev/deps/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonical_name: canonicalName }),
      });
      const d = await res.json();
      if (d.ok) {
        showToast(`[LiveDev] ${d.message || "Rolled back " + canonicalName}`);
        await fetchConflictLog();
        const nodeToRefresh = affectedNode || snap.node_name;
        if (nodeToRefresh && scanResultsMap[nodeToRefresh]) {
          await rescanNodeReport(nodeToRefresh);
        }
        renderRollbackDrawer();
        renderProjectList();
      } else {
        triggerBtn.disabled = false;
        triggerBtn.textContent = origText;
        triggerBtn.style.opacity = "1";
        showToast(`[LiveDev] Rollback failed: ${d.error || "unknown error"}`);
      }
    } catch (err) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = origText;
      triggerBtn.style.opacity = "1";
      showToast(`[LiveDev] Rollback error: ${err.message}`);
    }
  }

  function renderRollbackDrawer() {
    const entries = Object.values(conflictLogMap || {});
    if (entries.length === 0) {
      rollbackToggleBtn.style.display = "none";
      rollbackDrawer.style.display = "none";
      rollbackDrawerOpen = false;
      return;
    }

    const conflictCount = entries.filter((e) => e.was_conflict).length;
    rollbackToggleBtn.style.display = "inline-flex";
    rollbackToggleBtn.style.borderColor = conflictCount > 0 ? DANGER : ACCENT_DIM;
    rollbackToggleBtn.style.color = conflictCount > 0 ? DANGER : ACCENT;
    rollbackToggleBtn.textContent =
      `${rollbackDrawerOpen ? "\u25BC" : "\u25B6"} Rollback History (${entries.length}` +
      (conflictCount > 0 ? ` | ${conflictCount} conflicts` : "") +
      ")";

    if (!rollbackDrawerOpen) {
      rollbackDrawer.style.display = "none";
      return;
    }

    rollbackDrawer.style.display = "block";
    rollbackDrawer.innerHTML = "";

    const heading = document.createElement("div");
    heading.style.cssText =
      "font-size:11.5px;color:" + TEXT_DIM + ";margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;";
    heading.textContent = "Recorded package install snapshots (click Rollback to restore previous version):";
    rollbackDrawer.appendChild(heading);

    entries.forEach((snap) => {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 10px;margin-bottom:6px;border-radius:6px;background:" +
        SURFACE_RAISED +
        ";border:1px solid " +
        (snap.was_conflict ? DANGER_DIM : BORDER_SOFT) +
        ";flex-wrap:wrap;";

      const info = document.createElement("div");
      info.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-family:" + FONT_MONO + ";font-size:12px;";

      const nameEl = document.createElement("strong");
      nameEl.style.color = "#fff";
      nameEl.textContent = snap.canonical_name;

      const badge = document.createElement("span");
      badge.style.cssText =
        "font-size:10.5px;padding:1px 6px;border-radius:10px;font-family:" +
        FONT_UI +
        ";background:" +
        (snap.was_conflict ? DANGER_DIM : ACCENT_DIM) +
        ";color:#fff;";
      badge.textContent = snap.was_conflict ? "Conflict Override" : "New Install";

      const detail = document.createElement("span");
      detail.style.cssText = "font-size:11.5px;color:" + TEXT_DIM + ";";
      const fromStr = snap.old_version === "__none__" ? "not installed" : `v${snap.old_version}`;
      detail.textContent = `${fromStr} \u2192 ${snap.new_spec}` + (snap.node_name ? ` (${snap.node_name})` : "");

      info.appendChild(nameEl);
      info.appendChild(badge);
      info.appendChild(detail);

      const rbBtn = document.createElement("button");
      rbBtn.type = "button";
      rbBtn.style.cssText =
        "padding:4px 10px;border-radius:5px;font-size:11.5px;cursor:pointer;font-weight:600;background:" +
        DANGER_DIM +
        ";color:" +
        DANGER +
        ";border:1px solid " +
        DANGER +
        ";font-family:" +
        FONT_UI +
        ";";
      rbBtn.textContent =
        snap.old_version === "__none__" ? "\u21A9 Uninstall" : `\u21A9 Restore ${snap.old_version}`;
      rbBtn.onclick = () => runRollback(snap.canonical_name, snap.node_name, rbBtn);

      row.appendChild(info);
      row.appendChild(rbBtn);
      rollbackDrawer.appendChild(row);
    });
  }

  async function loadProjects() {
    listContainer.innerHTML = `<div style="text-align:center;padding:40px;color:${TEXT_DIM};">Loading custom_nodes projects...</div>`;
    try {
      await fetchConflictLog();
      renderRollbackDrawer();
      const res = await api.fetchApi("/livedev/deps/list_projects");
      const data = await res.json();
      if (data.ok) {
        projectCache = data.projects || [];
        renderProjectList();
      } else {
        listContainer.innerHTML = `<div style="color:${DANGER};padding:20px;">Failed to load projects: ${esc(data.error)}</div>`;
      }
    } catch (e) {
      listContainer.innerHTML = `<div style="color:${DANGER};padding:20px;">Error: ${esc(e.message)}</div>`;
    }
  }

  function renderProjectList() {
    listContainer.innerHTML = "";

    const totalProjects = projectCache.length;
    let issuesCount = 0;
    let unscannedCount = 0;

    projectCache.forEach((p) => {
      const rep = scanResultsMap[p.name];
      if (!rep) {
        unscannedCount++;
      } else if (rep.missing_count > 0 || rep.conflict_count > 0) {
        issuesCount++;
      }
    });

    statsText.innerHTML =
      `Total: <strong>${totalProjects}</strong> | Scanned: <strong>${totalProjects - unscannedCount}</strong> | ` +
      `Issues: <strong style="color:${issuesCount > 0 ? DANGER : ACCENT};">${issuesCount}</strong>`;

    const filtered = projectCache.filter((p) => {
      if (searchQuery && !p.name.toLowerCase().includes(searchQuery)) return false;
      const rep = scanResultsMap[p.name];
      if (activeFilter === "issues") return rep && (rep.missing_count > 0 || rep.conflict_count > 0);
      if (activeFilter === "clean") return rep && rep.missing_count === 0 && rep.conflict_count === 0;
      if (activeFilter === "unscanned") return !rep;
      return true;
    });

    if (filtered.length === 0) {
      listContainer.innerHTML = `<div style="text-align:center;padding:40px;color:${TEXT_FAINT};">No projects match the search filter.</div>`;
      return;
    }

    filtered.forEach((p) => {
      const rep = scanResultsMap[p.name];
      const isExpanded = expandedProjects.has(p.name);
      const hasIssues = rep && (rep.missing_count > 0 || rep.conflict_count > 0);
      const isTarget = targetNode === p.name;

      const card = document.createElement("div");
      card.className = "livedev-project-card";
      card.style.cssText =
        "display:block;width:100%;margin-bottom:8px;background:" +
        SURFACE_RAISED +
        ";border:1px solid " +
        (hasIssues ? DANGER_DIM : isTarget ? ACCENT : BORDER_SOFT) +
        ";border-radius:8px;overflow:hidden;box-sizing:border-box;";

      // Clickable Header Row (Collapsed by default)
      const headerRow = document.createElement("div");
      headerRow.style.cssText =
        "padding:10px 14px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;user-select:none;min-height:44px;box-sizing:border-box;background:" +
        (isExpanded ? SURFACE : "transparent") +
        ";";

      const leftSide = document.createElement("div");
      leftSide.style.cssText = "display:flex;align-items:center;gap:10px;flex:1;min-width:0;";

      const arrowIcon = document.createElement("span");
      arrowIcon.textContent = isExpanded ? "\u25BC" : "\u25B6";
      arrowIcon.style.cssText = "font-size:10px;color:" + TEXT_DIM + ";width:12px;display:inline-block;flex-shrink:0;";

      const nameSpan = document.createElement("span");
      nameSpan.textContent = p.name;
      nameSpan.style.cssText =
        "font-weight:700;font-size:13px;color:#fff;font-family:" +
        FONT_MONO +
        ";overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

      const reqBadge = document.createElement("span");
      reqBadge.style.cssText =
        "font-size:11px;color:" + TEXT_FAINT + ";padding:1px 6px;border-radius:4px;background:" + SURFACE_DEEP + ";flex-shrink:0;";
      reqBadge.textContent = p.req_type ? p.req_type : "No requirements file";

      leftSide.appendChild(arrowIcon);
      leftSide.appendChild(nameSpan);
      leftSide.appendChild(reqBadge);

      const rightSide = document.createElement("div");
      rightSide.style.cssText = "display:flex;align-items:center;gap:8px;flex-shrink:0;";

      const statusBadge = document.createElement("span");
      statusBadge.style.cssText = "font-size:11.5px;padding:3px 9px;border-radius:12px;white-space:nowrap;";

      if (!rep) {
        statusBadge.style.background = SURFACE;
        statusBadge.style.color = TEXT_DIM;
        statusBadge.style.border = "1px solid " + BORDER_SOFT;
        statusBadge.textContent = "Unscanned";
      } else if (rep.missing_count > 0 || rep.conflict_count > 0) {
        statusBadge.style.background = "rgba(229, 115, 115, 0.14)";
        statusBadge.style.color = DANGER;
        statusBadge.style.border = "1px solid " + DANGER_DIM;
        statusBadge.textContent = `Missing: ${rep.missing_count} | Conflicts: ${rep.conflict_count}`;
      } else {
        statusBadge.style.background = "rgba(56, 192, 196, 0.14)";
        statusBadge.style.color = ACCENT;
        statusBadge.style.border = "1px solid " + ACCENT_DIM;
        statusBadge.textContent = "\u2713 Satisfied";
      }

      const scanBtn = document.createElement("button");
      scanBtn.type = "button";
      scanBtn.style.cssText =
        "padding:4px 12px;border-radius:5px;font-size:12px;cursor:pointer;font-weight:600;background:" +
        SURFACE +
        ";color:" +
        ACCENT +
        ";border:1px solid " +
        ACCENT_DIM +
        ";font-family:" +
        FONT_UI +
        ";";
      scanBtn.textContent = "Scan Project";

      scanBtn.onclick = async (e) => {
        e.stopPropagation();
        scanBtn.disabled = true;
        scanBtn.textContent = "Scanning...";
        try {
          const res = await api.fetchApi("/livedev/deps/scan_node", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ node_name: p.name }),
          });
          const report = await res.json();
          if (report.ok) {
            scanResultsMap[p.name] = report;
            expandedProjects.add(p.name);
            renderProjectList();
            showToast(`[LiveDev] Scanned ${p.name}`);
          } else {
            showToast(`[LiveDev] Scan failed for ${p.name}: ${report.error}`);
            scanBtn.disabled = false;
            scanBtn.textContent = "Scan Project";
          }
        } catch (err) {
          showToast(`[LiveDev] Error: ${err.message}`);
          scanBtn.disabled = false;
          scanBtn.textContent = "Scan Project";
        }
      };

      const reloadBtn = document.createElement("button");
      reloadBtn.type = "button";
      reloadBtn.style.cssText =
        "padding:4px 9px;border-radius:5px;font-size:12px;cursor:pointer;background:" +
        SURFACE_DEEP +
        ";color:" +
        TEXT_DIM +
        ";border:1px solid " +
        BORDER +
        ";font-family:" +
        FONT_UI +
        ";";
      reloadBtn.title = "Reload custom node module";
      reloadBtn.textContent = "\u21BB";
      reloadBtn.onclick = async (e) => {
        e.stopPropagation();
        reloadBtn.disabled = true;
        showToast(`[LiveDev] Reloading ${p.name}...`);
        try {
          const r = await api.fetchApi("/livedev/reload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ module: p.name }),
          });
          const txt = await r.text();
          if (txt === "OK") showToast(`[LiveDev] Successfully reloaded ${p.name}!`);
          else showToast(`[LiveDev] Failed to reload ${p.name}`);
        } catch (err) {
          showToast(`[LiveDev] Error: ${err.message}`);
        } finally {
          reloadBtn.disabled = false;
        }
      };

      rightSide.appendChild(statusBadge);
      rightSide.appendChild(scanBtn);
      rightSide.appendChild(reloadBtn);

      headerRow.appendChild(leftSide);
      headerRow.appendChild(rightSide);

      headerRow.onclick = () => {
        if (expandedProjects.has(p.name)) {
          expandedProjects.delete(p.name);
        } else {
          expandedProjects.add(p.name);
        }
        renderProjectList();
      };

      card.appendChild(headerRow);

      // Collapsible Details Area
      if (isExpanded) {
        const detailsArea = document.createElement("div");
        detailsArea.style.cssText =
          "border-top:1px solid " +
          BORDER_SOFT +
          ";padding:12px 16px;background:" +
          SURFACE_DEEP +
          ";display:block;box-sizing:border-box;";

        if (!rep) {
          detailsArea.innerHTML =
            `<div style="font-size:12px;color:${TEXT_DIM};">` +
            `This project has not been scanned yet. Click <strong style="color:${ACCENT};">Scan Project</strong> to check its dependencies.` +
            `</div>`;
        } else if (!rep.has_requirements && rep.packages.length === 0) {
          detailsArea.innerHTML = `<div style="font-size:12px;color:${TEXT_FAINT};">No requirements.txt or pyproject.toml found in this project.</div>`;
        } else if (rep.packages.length === 0) {
          detailsArea.innerHTML = `<div style="font-size:12px;color:${ACCENT};">\u2713 Requirements file is empty or all packages satisfied.</div>`;
        } else {
          rep.packages.forEach((pkg) => {
            const cName = pkg.canonical_name || pkg.name.toLowerCase();
            const snapshot = conflictLogMap[cName];

            const pkgRow = document.createElement("div");
            pkgRow.style.cssText =
              "background:" +
              SURFACE_RAISED +
              ";border:1px solid " +
              (pkg.status === "conflict" ? (pkg.is_critical ? DANGER : DANGER_DIM) : BORDER_SOFT) +
              ";border-radius:6px;padding:8px 12px;margin-bottom:8px;display:block;box-sizing:border-box;";

            const pkgTop = document.createElement("div");
            pkgTop.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;";

            const pkgMeta = document.createElement("div");
            pkgMeta.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-family:" + FONT_MONO + ";";

            const pName = document.createElement("span");
            pName.textContent = pkg.name;
            pName.style.cssText = "font-weight:700;font-size:13px;color:#fff;";

            const pSpec = document.createElement("span");
            pSpec.textContent = pkg.specifier ? `(${pkg.specifier})` : "(any version)";
            pSpec.style.cssText = "font-size:11.5px;color:" + TEXT_DIM + ";";

            const pBadge = document.createElement("span");
            pBadge.style.cssText = "font-size:11px;padding:1px 7px;border-radius:10px;font-family:" + FONT_UI + ";";

            if (pkg.status === "satisfied") {
              pBadge.style.background = "rgba(56, 192, 196, 0.14)";
              pBadge.style.color = ACCENT;
              pBadge.textContent = "\u2713 Satisfied";
            } else if (pkg.status === "missing") {
              pBadge.style.background = pkg.is_critical ? "rgba(229, 115, 115, 0.18)" : "rgba(56, 192, 196, 0.16)";
              pBadge.style.color = pkg.is_critical ? DANGER : ACCENT;
              pBadge.textContent = pkg.is_critical ? "\u2715 Missing (Core)" : "\u2715 Missing";
            } else if (pkg.status === "conflict") {
              pBadge.style.background = "rgba(229, 115, 115, 0.18)";
              pBadge.style.color = DANGER;
              pBadge.textContent = pkg.is_critical ? "Critical Core Conflict" : "Version Conflict";
            }

            pkgMeta.appendChild(pName);
            pkgMeta.appendChild(pSpec);
            pkgMeta.appendChild(pBadge);

            const pkgAction = document.createElement("div");
            pkgAction.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";

            if (pkg.installed_version) {
              const instV = document.createElement("span");
              instV.textContent = `Installed: ${pkg.installed_version}`;
              instV.style.cssText = "font-size:11px;color:" + TEXT_FAINT + ";font-family:" + FONT_MONO + ";";
              pkgAction.appendChild(instV);
            }

            // Rollback button if this package has a saved pre-install snapshot
            if (snapshot) {
              const rbBtn = document.createElement("button");
              rbBtn.type = "button";
              rbBtn.style.cssText =
                "padding:4px 10px;border-radius:5px;font-size:11.5px;cursor:pointer;font-weight:600;background:" +
                DANGER_DIM +
                ";color:" +
                DANGER +
                ";border:1px solid " +
                DANGER +
                ";font-family:" +
                FONT_UI +
                ";";
              rbBtn.textContent =
                snapshot.old_version === "__none__"
                  ? "\u21A9 Undo Install"
                  : `\u21A9 Rollback (${snapshot.old_version})`;
              rbBtn.title =
                snapshot.old_version === "__none__"
                  ? "Uninstall this package (was not installed previously)"
                  : `Restore previous version ${snapshot.old_version}`;
              rbBtn.onclick = () => runRollback(cName, p.name, rbBtn);
              pkgAction.appendChild(rbBtn);
            }

            const pInstallBtn = document.createElement("button");
            pInstallBtn.type = "button";
            pInstallBtn.style.cssText =
              "padding:4px 12px;border-radius:5px;font-size:11.5px;cursor:pointer;font-weight:600;font-family:" +
              FONT_UI +
              ";display:inline-flex;align-items:center;gap:4px;";

            if (pkg.status === "satisfied") {
              pInstallBtn.textContent = "Installed \u2713";
              pInstallBtn.disabled = true;
              pInstallBtn.style.background = "rgba(56, 192, 196, 0.12)";
              pInstallBtn.style.color = ACCENT;
              pInstallBtn.style.border = "1px solid " + ACCENT_DIM;
              pInstallBtn.style.cursor = "default";
            } else {
              pInstallBtn.textContent = pkg.status === "conflict" ? "Replace (Protected)" : "Install";
              if (pkg.status === "conflict") {
                pInstallBtn.style.background = "rgba(229, 115, 115, 0.18)";
                pInstallBtn.style.color = DANGER;
                pInstallBtn.style.border = "1px solid " + DANGER;
              } else {
                pInstallBtn.style.background = ACCENT_DIM;
                pInstallBtn.style.color = "#fff";
                pInstallBtn.style.border = "1px solid " + ACCENT;
              }

              pInstallBtn.onclick = async () => {
                if (pkg.is_critical && pkg.status === "conflict") {
                  const ok = confirm(
                    `Critical Core Conflict Warning:\n\nPackage '${pkg.name}' is a ComfyUI core package (${pkg.installed_version}). Installing '${pkg.specifier}' may break CUDA acceleration or crash ComfyUI.\n\nA rollback snapshot will be saved before replacing. Force install anyway?`
                  );
                  if (!ok) return;
                } else if (pkg.status === "conflict") {
                  const ok = confirm(
                    `Version Conflict Notice:\n\nPackage '${pkg.name}' is currently '${pkg.installed_version}', while this project requests '${pkg.specifier}'.\n\nLiveDev will snapshot '${pkg.installed_version}' first so you can roll back cleanly if needed. Proceed?`
                  );
                  if (!ok) return;
                }

                pInstallBtn.disabled = true;
                pInstallBtn.textContent = "Installing...";
                pInstallBtn.style.opacity = "0.7";

                try {
                  const rawPkg = pkg.raw_spec || pkg.name + (pkg.specifier || "");
                  const res = await api.fetchApi("/livedev/deps/install", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      package: rawPkg,
                      node_name: p.name,
                      force: pkg.is_critical,
                    }),
                  });
                  const d = await res.json();
                  if (d.ok) {
                    showToast(`[LiveDev] Successfully installed ${pkg.name} (rollback snapshot saved)`);
                    await fetchConflictLog();
                    await rescanNodeReport(p.name);
                    renderRollbackDrawer();
                    renderProjectList();
                  } else {
                    pInstallBtn.disabled = false;
                    pInstallBtn.style.opacity = "1";
                    pInstallBtn.textContent = "Retry Install";
                    pInstallBtn.style.background = "rgba(229, 115, 115, 0.25)";
                    pInstallBtn.style.color = DANGER;
                    showToast(`[LiveDev] Failed to install ${pkg.name}: ${d.error || ""}`);
                  }
                } catch (err) {
                  pInstallBtn.disabled = false;
                  pInstallBtn.style.opacity = "1";
                  pInstallBtn.textContent = "Retry Install";
                  showToast(`[LiveDev] Error: ${err.message}`);
                }
              };
            }

            pkgAction.appendChild(pInstallBtn);
            pkgTop.appendChild(pkgMeta);
            pkgTop.appendChild(pkgAction);
            pkgRow.appendChild(pkgTop);

            if (pkg.warning) {
              const pkgWarn = document.createElement("div");
              pkgWarn.style.cssText =
                "margin-top:6px;padding:6px 10px;background:rgba(229, 115, 115, 0.08);border-left:3px solid " +
                (pkg.is_critical ? DANGER : DANGER_DIM) +
                ";border-radius:4px;font-size:11.5px;color:" +
                (pkg.is_critical ? DANGER : TEXT_DIM) +
                ";line-height:1.4;";
              pkgWarn.textContent = pkg.warning;
              pkgRow.appendChild(pkgWarn);
            }

            detailsArea.appendChild(pkgRow);
          });
        }

        card.appendChild(detailsArea);
      }

      listContainer.appendChild(card);
    });
  }

  scanAllBtn.onclick = async () => {
    scanAllBtn.disabled = true;
    scanAllBtn.textContent = "Scanning all projects...";
    showToast("[LiveDev] Scanning dependencies for all custom_nodes projects...");

    try {
      const res = await api.fetchApi("/livedev/deps/scan_all?include_clean=true");
      const data = await res.json();
      if (data.ok) {
        const reports = data.results || [];
        reports.forEach((rep) => {
          scanResultsMap[rep.node_name] = rep;
        });
        await fetchConflictLog();
        renderRollbackDrawer();
        renderProjectList();
        showToast(`[LiveDev] Full scan completed for ${reports.length} projects!`);
      } else {
        showToast(`[LiveDev] Scan failed: ${data.error}`);
      }
    } catch (e) {
      showToast(`[LiveDev] Error: ${e.message}`);
    } finally {
      scanAllBtn.disabled = false;
      scanAllBtn.innerHTML = LD_ICONS.search + "<span>Scan All Projects</span>";
    }
  };

  await loadProjects();
}

app.registerExtension({
  name: "LiveDev.Dependencies",
  async setup() {
    window.openLiveDevDepsHub = openDependenciesHub;
    window.scanAllLiveDevDeps = openDependenciesHub;

    api.addEventListener("livedev_missing_deps", (event) => {
      const report = event.detail;
      if (report && (report.missing_count > 0 || report.conflict_count > 0)) {
        openDependenciesHub(report.node_name, report);
      }
    });
  },
});
