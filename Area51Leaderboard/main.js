document.getElementById("copyright-year").textContent = new Date().getFullYear();

// ===== LocalStorage helpers (no defaults) =====
const STORAGE_KEYS = {
  hist: "area51_hist_leaderboard",
  today: "area51_today_leaderboard",
};

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function loadStrict(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ===== Live data (ALWAYS from Local Storage) =====
const histData = loadStrict(STORAGE_KEYS.hist);
const todayData = loadStrict(STORAGE_KEYS.today);

// ===== Renderer =====
function renderLeaderboard(rows, tableSelector) {
  const tbody = document.querySelector(`${tableSelector} tbody`);
  if (!tbody) return;

  // ASC: lower time is better
  const sorted = [...rows].sort((a, b) => Number(a.score || 0) - Number(b.score || 0));

  tbody.innerHTML = sorted
    .map((row, i) => {
      const rank = i + 1;
      const time = Number(row.score) || 0;
      const name = (row.name ?? "").toString();
      const id   = Number.isInteger(row.id) ? row.id : "";
      return `<tr data-id="${id}">
        <td>${rank}</td>
        <td>${name}</td>
        <td>${time.toFixed(2)}</td>
      </tr>`;
    })
    .join("");

  // highlight fastest 3
  [...tbody.rows].forEach((tr, i) => {
    tr.style.background = "";
    if (i === 0) tr.style.background = "#fff4d6";
    if (i === 1) tr.style.background = "#f2f7ff";
    if (i === 2) tr.style.background = "#f3fff1";
  });

  // if you're in edit mode, reattach delete UI
  maybeReattachDeleteUI(tableSelector);
}


// Convert current table → array (used when finishing Edit)
function tableToArray(tableSelector) {
  const rows = [...document.querySelectorAll(`${tableSelector} tbody tr`)];
  return rows.map((tr) => {
    const idAttr = tr.getAttribute("data-id");
    const id = Number.parseInt(idAttr, 10);
    const tds = tr.querySelectorAll("td");
    const name  = (tds[1]?.textContent || "").trim();
    const score = parseFloat((tds[2]?.textContent || "").trim());
    return { id: Number.isFinite(id) ? id : undefined, name, score: isNaN(score) ? 0 : score };
  });
}

ensureAllHaveIds();

// ===== Initial render =====
renderLeaderboard(histData, "#rank-table-hist");
renderLeaderboard(todayData, "#rank-table-today");


// ===== Edit toggle: when turning OFF, read table → save =====
function toggleEditable(tableSelector, btnEl, which) {
  const tbody = document.querySelector(`${tableSelector} tbody`);
  const card = tbody.closest(".card");
  const on = tbody.getAttribute("contenteditable") === "true";

  if (on) {
    // === Turning OFF edit ===
    tbody.setAttribute("contenteditable", "false");
    btnEl.textContent = "Edit";
    btnEl.classList.remove("is-editing");
    card.classList.remove("editing");
    disableDeleteUI(tableSelector);  

    // Grab latest table → array
    const edited = tableToArray(tableSelector);
    const before = tbody._snapshot || [];

    // Only save if changed
    if (!isSameData(before, edited)) {
      const arr = normalizeRows(edited);
      if (which === "hist") {
        histData.splice(0, histData.length, ...arr);
        save(STORAGE_KEYS.hist, histData);
        renderLeaderboard(histData, "#rank-table-hist");  // re-sort & repaint
      } else {
        todayData.splice(0, todayData.length, ...arr);
        save(STORAGE_KEYS.today, todayData);
        renderLeaderboard(todayData, "#rank-table-today");
      }
    }

    // Cleanup listeners/flags + tip
    tbody.removeEventListener("input", tbody._markDirty);
    tbody.removeEventListener("keydown", tbody._finishOnEnter);
    delete tbody._markDirty;
    delete tbody._finishOnEnter;
    delete tbody._snapshot;
    delete tbody.dataset.dirty;
    card.querySelector(".edit-tip")?.remove();

  } else {
    // === Turning ON edit ===
    tbody.setAttribute("contenteditable", "true");
    btnEl.textContent = "Done (Save)";
    btnEl.classList.add("is-editing");
    card.classList.add("editing");
    enableDeleteUI(tableSelector);

    // Add a small tip below the buttons (once)
    if (!card.querySelector(".edit-tip")) {
      const tip = document.createElement("div");
      tip.className = "edit-tip";
      tip.textContent = "You’re in EDIT MODE — type directly in the table. Press Ctrl/Cmd+Enter or click Done (Save).";
      card.appendChild(tip);
    }

    // Take a snapshot for change detection
    tbody._snapshot = tableToArray(tableSelector);
    tbody.dataset.dirty = "0";

    // Mark dirty on any change
    tbody._markDirty = () => { tbody.dataset.dirty = "1"; };
    tbody.addEventListener("input", tbody._markDirty);

    // Convenience: Ctrl/Cmd+Enter finishes editing
    tbody._finishOnEnter = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        btnEl.click();
      }
    };
    tbody.addEventListener("keydown", tbody._finishOnEnter);
  }
}



// ===== Actions (all persist) =====
function resetHistorical() {
  histData.splice(0, histData.length); // clear to empty
  save(STORAGE_KEYS.hist, histData);
  renderLeaderboard(histData, "#rank-table-hist");
}

// Replace the whole function with this:
function mergeTodayIntoHistorical() {
  // Make sure everything has ids (covers old data edited/added before migration)
  ensureAllHaveIds();

  // existing ids in Historical
  const existing = new Set(histData.filter(r => Number.isInteger(r.id)).map(r => r.id));

  // Append ONLY rows whose id is not already in Historical
  const toAdd = todayData.filter(r => !existing.has(r.id));
  histData.push(...toAdd);

  // Resort by least time and keep top 10 (if <=10, keeps all)
  keepTopNByTimeAsc(histData, 10);

  save(STORAGE_KEYS.hist, histData);
  renderLeaderboard(histData, "#rank-table-hist");
}


function normalizeRows(rows) {
  // keep id + clean name + round time
  return rows.map(r => ({
    id: Number.isInteger(r.id) ? r.id : undefined,
    name: (r.name || "").trim(),
    score: Math.round((Number(r.score) || 0) * 100) / 100,
  }));
}

function isSameData(a, b) {
  const A = normalizeRows(a);
  const B = normalizeRows(b);
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) {
    if ((A[i].id ?? -1) !== (B[i].id ?? -1)) return false;
    if (A[i].name !== B[i].name) return false;
    if (A[i].score !== B[i].score) return false;
  }
  return true;
}


function keepTopNByTimeAsc(arr, n = 10) {
  arr.sort((a, b) => Number(a.score || 0) - Number(b.score || 0)); // low → high
  if (arr.length > n) arr.length = n; // drop the slowest after sort
}

let _addTarget = null;      // "today" or "hist"
let _addOpener = null;

function openAddModal(target, openerEl) {
  _addTarget = target;
  _addOpener = openerEl || document.activeElement;

  const modal = document.getElementById("add-modal");
  modal.classList.remove("hidden");
  modal.removeAttribute("aria-hidden");
  modal.removeAttribute("inert");

  // optional: prevent page scroll while open
  document.body.style.overflow = "hidden";

  // reset fields + focus first field
  document.getElementById("add-name").value = "";
  document.getElementById("add-score").value = "";
  setTimeout(() => document.getElementById("add-name").focus(), 0);
}

function closeAddModal() {
  const modal = document.getElementById("add-modal");

  // 1) MOVE FOCUS OUT of the modal (back to the opener)
  if (_addOpener && typeof _addOpener.focus === "function") {
    _addOpener.focus();
  } else {
    // fallback to body if opener is gone
    document.body.focus?.();
  }

  // 2) Now it’s safe to hide the modal
  modal.setAttribute("aria-hidden", "true");
  modal.setAttribute("inert", "");          // blocks focus & interaction
  modal.classList.add("hidden");

  // 3) cleanup
  document.body.style.overflow = "";
  _addTarget = null;
  _addOpener = null;
}

function confirmAddFromModal() {
  const name = (document.getElementById("add-name").value || "").trim();
  const scoreRaw = document.getElementById("add-score").value;
  const score = Math.round((parseFloat(scoreRaw) || 0) * 100) / 100;

  if (!name) { alert("Please enter a name."); return; }
  if (isNaN(score)) { alert("Please enter a valid score."); return; }

  if (_addTarget === "today") {
    todayData.push({ id: nextGlobalId(), name, score });
    keepTopNByTimeAsc(todayData, 10);
    save(STORAGE_KEYS.today, todayData);
    renderLeaderboard(todayData, "#rank-table-today");
  } 
  else if (_addTarget === "hist") {
    histData.push({ id: nextGlobalId(), name, score });
    keepTopNByTimeAsc(histData, 10);
    save(STORAGE_KEYS.hist, histData);
    renderLeaderboard(histData, "#rank-table-hist");
  }
  closeAddModal();
}
// Add a "Delete" column with × buttons (only in edit mode)
function enableDeleteUI(tableSelector) {
  const table = document.querySelector(tableSelector);
  if (!table) return;

  // mark so we know it's active
  table.dataset.showDelete = "1";

  // 1) header: add "Delete" th if missing
  const theadRow = table.tHead?.rows?.[0];
  if (theadRow && !theadRow.querySelector("th.del-col")) {
    const th = document.createElement("th");
    th.textContent = "Delete";
    th.className = "del-col";
    theadRow.appendChild(th);
  }

  // 2) body: append a delete cell to each row if missing
  [...table.tBodies[0].rows].forEach((tr) => {
    if (!tr.querySelector("td.del-col")) {
      const td = document.createElement("td");
      td.className = "del-col";
      td.innerHTML = `<button class="row-del" title="Delete this row">×</button>`;
      tr.appendChild(td);
    }
  });
}

// Remove the extra "Delete" column when exiting edit mode
function disableDeleteUI(tableSelector) {
  const table = document.querySelector(tableSelector);
  if (!table) return;

  delete table.dataset.showDelete;

  // remove last TH if it’s the delete column
  const theadRow = table.tHead?.rows?.[0];
  if (theadRow && theadRow.lastElementChild?.classList.contains("del-col")) {
    theadRow.removeChild(theadRow.lastElementChild);
  }

  // remove last TD in each row if it’s the delete column
  [...table.tBodies[0].rows].forEach((tr) => {
    const last = tr.lastElementChild;
    if (last?.classList.contains("del-col")) tr.removeChild(last);
  });
}

// After we re-render during Edit mode, we need to re-attach the delete column
function maybeReattachDeleteUI(tableSelector) {
  const table = document.querySelector(tableSelector);
  if (table?.dataset.showDelete === "1") {
    enableDeleteUI(tableSelector);
  }
}

// ==== Generic Confirm Modal (reuses #delete-modal HTML) ====
// _delContext now carries an action: "delete" | "reset-hist" | "reset-today"
let _delContext = null; // { action, which, name?, timeNum?, timeStr?, opener, tableSelector? }

// Utility: focus something safely
function safeFocus(el) {
  if (!el) return;
  // blur the currently focused element first
  document.activeElement?.blur?.();
  // queue the focus so it happens before we hide the modal
  requestAnimationFrame(() => el.focus?.());
}

// keep using the same global
// let _delContext = { action, which, id?, name?, timeNum?, timeStr?, opener, ... };

function openConfirmModal(ctx) {
  _delContext = ctx;

  const modal = document.getElementById("delete-modal");
  const title = document.getElementById("del-title");
  const msg   = document.getElementById("del-msg");
  const confirmBtn = document.getElementById("del-confirm");

  if (ctx.action === "delete") {
    title.textContent = "Confirm Delete";
    msg.textContent   = `Delete ${ctx.name}'s time ${ctx.timeStr}?`;
    confirmBtn.textContent = "Delete";
    confirmBtn.classList.add("btn--danger");
  } else if (ctx.action === "reset-hist") {
    title.textContent = "Confirm Reset";
    msg.textContent   = "Clear all data from Historical Leaderboard? This also removes Local Storage for it.";
    confirmBtn.textContent = "Reset";
    confirmBtn.classList.add("btn--danger");
  } else if (ctx.action === "reset-today") {
    title.textContent = "Confirm Reset";
    msg.textContent   = "Clear all data from Today's Leaderboard? This also removes Local Storage for it.";
    confirmBtn.textContent = "Reset";
    confirmBtn.classList.add("btn--danger");
  }

  modal.classList.remove("hidden");
  modal.removeAttribute("aria-hidden");
  modal.removeAttribute("inert");
  document.body.style.overflow = "hidden";

  // focus primary action
  safeFocus(confirmBtn);
}

function closeConfirmModal() {
  const modal = document.getElementById("delete-modal");
  const confirmBtn = document.getElementById("del-confirm");

  // choose a safe place to return focus:
  // 1) the button that opened the modal (if it still exists)
  // 2) the current card's Edit/Done button
  // 3) a global fallback (today-edit or hist-edit) or body
  let fallback =
    _delContext?.opener ||
    document.querySelector(".card.editing .btn.is-editing") ||
    document.getElementById("today-edit") ||
    document.getElementById("hist-edit") ||
    document.body;

  // Move focus OUT of the modal BEFORE hiding it
  safeFocus(fallback);

  // Now it's safe to hide
  modal.setAttribute("aria-hidden", "true");
  modal.setAttribute("inert", "");
  modal.classList.add("hidden");
  document.body.style.overflow = "";

  // cleanup styling/state
  confirmBtn.classList.remove("btn--danger");
  _delContext = null;
}


function confirmFromModal() {
  if (!_delContext) return;
  const { action } = _delContext;

  if (action === "delete") {
    const { which, id, name, timeNum } = _delContext;
    const arr = which === "hist" ? histData : todayData;

    let rmIndex = -1;
    if (Number.isInteger(id)) {
      rmIndex = arr.findIndex(r => r.id === id);        // primary: by id
    }
    if (rmIndex < 0) {
      // fallback: by (name + time)
      const exact = arr.findIndex(r =>
        (r.name || "").trim() === name &&
        Math.abs(Number(r.score || 0) - timeNum) < 1e-9
      );
      rmIndex = exact >= 0 ? exact : arr.findIndex(r => (r.name || "").trim() === name);
    }

    if (rmIndex >= 0) arr.splice(rmIndex, 1);

    if (which === "hist") {
      save(STORAGE_KEYS.hist, arr);
      renderLeaderboard(histData, "#rank-table-hist");
      maybeReattachDeleteUI("#rank-table-hist");
    } else {
      save(STORAGE_KEYS.today, arr);
      renderLeaderboard(todayData, "#rank-table-today");
      maybeReattachDeleteUI("#rank-table-today");
    }
  }

  if (action === "reset-hist") {
    // clear data + remove LS key
    histData.splice(0, histData.length);
    save(STORAGE_KEYS.hist, histData); // when histData is empty
    renderLeaderboard(histData, "#rank-table-hist");
    // if in edit mode, keep the delete column visible
    maybeReattachDeleteUI("#rank-table-hist");
  }

  if (action === "reset-today") {
    todayData.splice(0, todayData.length);
    save(STORAGE_KEYS.today, todayData);
    renderLeaderboard(todayData, "#rank-table-today");
    maybeReattachDeleteUI("#rank-table-today");
  }

  closeConfirmModal();
}

// ===== ID helpers =====
function collectIds() {
  return [...histData, ...todayData]
    .map(r => r?.id)
    .filter(id => Number.isInteger(id));
}
function nextGlobalId() {
  const ids = collectIds();
  return ids.length ? Math.max(...ids) + 1 : 0;
}
// Ensure BOTH arrays have unique ids; assign sequentially starting at nextGlobalId()
function ensureAllHaveIds() {
  let changed = false;
  let nextId = nextGlobalId();
  for (const arr of [histData, todayData]) {
    for (const r of arr) {
      if (!Number.isInteger(r.id)) {
        r.id = nextId++;
        changed = true;
      }
    }
  }
  if (changed) {
    save(STORAGE_KEYS.hist, histData);
    save(STORAGE_KEYS.today, todayData);
  }
}

// Force the Time field to accept only digits and a single dot on all platforms
(function lockScoreField() {
  const el = document.getElementById("add-score");
  if (!el) return;

  // Block characters often allowed by <input type="number"> on desktop browsers
  el.addEventListener("keydown", (e) => {
    const bad = ["e", "E", "+", "-"];
    if (bad.includes(e.key)) e.preventDefault();
  });

  // Sanitize on input/paste: keep only digits and ONE dot
  el.addEventListener("input", () => {
    let v = el.value.replace(/[^\d.]/g, "");
    const firstDot = v.indexOf(".");
    if (firstDot !== -1) {
      v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, "");
    }
    el.value = v;
  });
})();


// ===== Wire buttons (ids from your HTML) =====
document.getElementById("hist-edit")?.addEventListener("click", (e) => {
  toggleEditable("#rank-table-hist", e.currentTarget, "hist");
});
// Historical Reset -> modal confirm
document.getElementById("hist-reset")?.addEventListener("click", (e) => {
  openConfirmModal({ action: "reset-hist", opener: e.currentTarget });
});

// Today's Reset -> modal confirm
document.getElementById("today-reset")?.addEventListener("click", (e) => {
  openConfirmModal({ action: "reset-today", opener: e.currentTarget });
});


document.getElementById("today-merge")?.addEventListener("click", () => {
  mergeTodayIntoHistorical();
});
document.getElementById("today-edit")?.addEventListener("click", (e) => {
  toggleEditable("#rank-table-today", e.currentTarget, "today");
});

document.getElementById("today-add")?.addEventListener("click", (e) => {
  openAddModal("today", e.currentTarget);
});
document.getElementById("hist-add")?.addEventListener("click", (e) => {
  openAddModal("hist", e.currentTarget);
});
// Delegated click handlers for row delete (both tables)
document.querySelector("#rank-table-hist tbody")?.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  if (!e.target.classList.contains("row-del")) return;
  handleRowDelete(e, "hist", "#rank-table-hist");
});

document.querySelector("#rank-table-today tbody")?.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  if (!e.target.classList.contains("row-del")) return;
  handleRowDelete(e, "today", "#rank-table-today");
});

// Delete implementation
function handleRowDelete(e, which, tableSelector) {
  const btn = e.target;
  const tr = btn.closest("tr");
  if (!tr) return;

  const idAttr = tr.getAttribute("data-id");
  const rowId  = Number.parseInt(idAttr, 10);
  const name   = (tr.cells[1]?.textContent || "").trim();
  const timeStr = (tr.cells[2]?.textContent || "").trim();
  const timeNum = Number(timeStr);

  if (!name) return;

  openConfirmModal({
    action: "delete",
    which,
    id: Number.isFinite(rowId) ? rowId : undefined, // <— pass id if present
    name,
    timeStr,
    timeNum,
    opener: e.target,
    tableSelector
  });
  return;
}


// Modal controls
document.getElementById("add-cancel")?.addEventListener("click", closeAddModal);
document.getElementById("add-confirm")?.addEventListener("click", confirmAddFromModal);

// Close on Escape, Confirm on Enter
document.getElementById("add-modal")?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAddModal();
  if (e.key === "Enter") {
    // avoid submitting when focus is on Cancel
    const active = document.activeElement;
    if (active?.id !== "add-cancel") confirmAddFromModal();
  }
});

// Close when clicking the shaded backdrop (not the panel)
document.getElementById("add-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "add-modal") closeAddModal();
});


// (Optional) storage dump button you already added
document.getElementById('dump-storage')?.addEventListener('click', () => {
  const hist = JSON.parse(localStorage.getItem(STORAGE_KEYS.hist) || '[]');
  const today = JSON.parse(localStorage.getItem(STORAGE_KEYS.today) || '[]');
  console.log('Historical:', hist);
  console.table(hist);
  console.log("Today's:", today);
  console.table(today);
  alert('Opened console with Local Storage contents.');
});
// Confirm/Cancel for the generic confirm modal
document.getElementById("del-cancel")?.addEventListener("click", closeConfirmModal);
document.getElementById("del-confirm")?.addEventListener("click", confirmFromModal);

// Keyboard + backdrop for the same modal
document.getElementById("delete-modal")?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeConfirmModal();
  if (e.key === "Enter") {
    const active = document.activeElement;
    if (active?.id !== "del-cancel") confirmFromModal();
  }
});
document.getElementById("delete-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "delete-modal") closeConfirmModal();
});

