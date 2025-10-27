document.getElementById("copyright-year").textContent = new Date().getFullYear();

// // ===== LocalStorage helpers (no defaults) =====
// const STORAGE_KEYS = {
//   hist: "area51_hist_leaderboard",
//   today: "area51_today_leaderboard",
// };

// function save(key, value) {
//   localStorage.setItem(key, JSON.stringify(value));
// }

// function loadStrict(key) {
//   try {
//     const raw = localStorage.getItem(key);
//     if (!raw) return [];
//     const arr = JSON.parse(raw);
//     return Array.isArray(arr) ? arr : [];
//   } catch {
//     return [];
//   }
// }

// // ===== Live data (ALWAYS from Local Storage) =====
// const histData = loadStrict(STORAGE_KEYS.hist);
// const todayData = loadStrict(STORAGE_KEYS.today);

// ===== Remote storage via Supabase =====
const supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON);

/** Convert DB rows -> [{id,name,score}] */
function rowsFromDB(dbRows) {
  return dbRows
    .map(r => ({ id: r.id, name: (r.name || "").trim(), score: Number(r.score) || 0 }))
    .filter(r => r.name !== "");
}

/** Convert app rows -> DB payload (board tagged) */
function rowsToDB(board, rows) {
  return rows.map(r => ({
    id: Number.isInteger(r.id) ? r.id : undefined,
    board,
    name: (r.name || "").trim(),
    score: Math.round((Number(r.score) || 0) * 100) / 100
  }));
}

/** Load one board ("hist" | "today") from Supabase */
async function loadBoard(board) {
  const { data, error } = await supabase
    .from('leaderboard')
    .select('id, board, name, score')
    .eq('board', board)
    .order('score', { ascending: true })
    .limit(50);
  if (error) { console.warn('[remote] load error', error); return []; }
  return rowsFromDB(data || []);
}

/** Save a whole board: overwrite remote with current array.
 *  By default, refuses to clear remote data unless allowClear=true (for explicit resets).
 */
async function saveBoard(board, rows, opts = {}) {
  console.log("Start");
  const allowClear = !!opts.allowClear;

  // Safety: accidental empty writes are ignored unless explicitly allowed (Reset)
  if (!allowClear && (!rows || rows.length === 0)) {
    console.warn(`[remote] save skipped: ${board} rows empty (allowClear=false)`);
    return true; // treat as success, but do nothing
  }

  // Strategy: delete + insert (small dataset = simple & reliable)
  const del = await supabase.from('leaderboard').delete().eq('board', board);
  if (del.error) { console.warn('[remote] delete error', del.error); return false; }

  if (!rows.length) return true; // explicit clear (Reset) done

  const toInsert = rowsToDB(board, rows);
  const ins = await supabase.from('leaderboard').insert(toInsert).select('id');
  if (ins.error) { console.warn('[remote] insert error', ins.error); return false; }

  console.log("End");
  // backfill ids on the client for consistency
  const inserted = ins.data || [];
  rows.forEach((r, i) => { if (!Number.isInteger(r.id) && inserted[i]?.id) r.id = inserted[i].id; });
  return true;
  
}



// ===== Live data (now from SERVER) =====
const histData = [];
const todayData = [];

// Ensure ids stay unique across both arrays (you already have helpers that rely on this)
function hydrate(board, rows) {
  const target = board === 'hist' ? histData : todayData;
  target.splice(0, target.length, ...rows);
}

/** One-time bootstrap */
async function init() {
  // fetch both boards from server
  const [histRows, todayRows] = await Promise.all([loadBoard('hist'), loadBoard('today')]);
  hydrate('hist', histRows);
  hydrate('today', todayRows);

  const changed = ensureAllHaveIds();
  if (changed) { await saveBoard('hist', histData); await saveBoard('today', todayData); }


  // initial render (same render you already use)
  renderLeaderboard(histData, "#rank-table-hist");
  renderLeaderboard(todayData, "#rank-table-today");
  refreshEmptyState?.();
}

// kick off after script loads
init();


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

  applyMedals();

  showEmptyStateIfNeeded(document.getElementById("rank-table-today"));
  showEmptyStateIfNeeded(document.getElementById("rank-table-hist"));

  refreshEmptyState();
}


// Convert current table → array (used when finishing Edit)
function tableToArray(tableSelector) {
  const rows = [...document.querySelectorAll(`${tableSelector} tbody tr`)];

  return rows
    .filter(tr => !tr.classList.contains("table-empty"))    // ← ignore placeholder
    .filter(tr => tr.cells.length >= 3)                     // ← need Rank, Name, Time
    .map((tr) => {
      const idAttr = tr.getAttribute("data-id");
      const id = Number.parseInt(idAttr, 10);
      const tds = tr.querySelectorAll("td");
      const name  = (tds[1]?.textContent || "").trim();
      const score = parseFloat((tds[2]?.textContent || "").trim());
      return {
        id: Number.isFinite(id) ? id : undefined,
        name,
        score: Number.isFinite(score) ? score : 0
      };
    })
    .filter(r => r.name !== "");                            // ← drop blank lines
}


// ===== Edit toggle: when turning OFF, read table → save =====
async function toggleEditable(tableSelector, btnEl, which) {
  const tbody = document.querySelector(`${tableSelector} tbody`);
  const card = tbody.closest(".card");
  const on = tbody.getAttribute("contenteditable") === "true";

  if (on) {
    // === Turning OFF edit ===
    tbody.setAttribute("contenteditable", "false");
    btnEl.textContent = "Edit";
    btnEl.classList.remove("is-editing");
    card.classList.remove("editing");
    document.querySelector(tableSelector).dataset.wantDeleteCol = "0";
    disableDeleteUI(tableSelector);  

    // Grab latest table → array
    const edited = tableToArray(tableSelector);
    const before = tbody._snapshot || [];

    // Only save if changed
    if (!isSameData(before, edited)) {
      const arr = normalizeRows(edited);
      if (which === "hist") {
        histData.splice(0, histData.length, ...arr);
        await saveBoard('hist', histData);
        renderLeaderboard(histData, "#rank-table-hist");
      } else {
        todayData.splice(0, todayData.length, ...arr);
        await saveBoard('today', todayData);
        renderLeaderboard(todayData, "#rank-table-today");
      }
    }

    showEmptyStateIfNeeded(document.getElementById("rank-table-hist"));
    showEmptyStateIfNeeded(document.getElementById("rank-table-today"));
    refreshEmptyState();

    // Cleanup listeners/flags + tip
    tbody.removeEventListener("input", tbody._markDirty);
    tbody.removeEventListener("keydown", tbody._finishOnEnter);
    if (tbody._timeHandler) {
      tbody.removeEventListener("click", tbody._timeHandler, true);
      tbody.removeEventListener("focusin", tbody._timeHandler, true);
      delete tbody._timeHandler;
    }
    delete tbody._markDirty;
    delete tbody._finishOnEnter;
    delete tbody._snapshot;
    delete tbody.dataset.dirty;
    card.querySelector(".edit-tip")?.remove();

  } else {
    // === Turning ON edit ===
    tbody.setAttribute("contenteditable", "true");
    // Keep the empty-state placeholder non-editable even in edit mode
    tbody.querySelectorAll("tr.table-empty, tr.table-empty > td").forEach(el => {
    el.setAttribute("contenteditable", "false");
    el.style.userSelect = "none";
    });

    [...tbody.rows].forEach(tr => tr.cells[0]?.setAttribute("contenteditable", "false"));

    // 🆕 Open numpad when the 3rd cell (Time) is focused/clicked
    const isTimeCell = (td) => td && td.cellIndex === 2 && !td.classList.contains("del-col");

    tbody._timeHandler = (e) => {
      const td = e.target.closest?.("td");
      if (!td || !isTimeCell(td)) return;
      // prevent typing chaos; rely on keypad
      e.preventDefault();
      openNumPadForCell(td);
    };

    tbody.addEventListener("click", tbody._timeHandler, true);
    tbody.addEventListener("focusin", tbody._timeHandler, true);

    btnEl.textContent = "Done (Save)";
    btnEl.classList.add("is-editing");
    card.classList.add("editing");
    document.querySelector(tableSelector).dataset.wantDeleteCol = "1";
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

// // ===== Actions (all persist) =====
// function resetHistorical() {
//   histData.splice(0, histData.length); // clear to empty
//   save(STORAGE_KEYS.hist, histData);
//   renderLeaderboard(histData, "#rank-table-hist");
// }

// // Replace the whole function with this:
// function mergeTodayIntoHistorical() {
//   // Make sure everything has ids (covers old data edited/added before migration)
//   ensureAllHaveIds();

//   // existing ids in Historical
//   const existing = new Set(histData.filter(r => Number.isInteger(r.id)).map(r => r.id));

//   // Append ONLY rows whose id is not already in Historical
//   const toAdd = todayData.filter(r => !existing.has(r.id));
//   histData.push(...toAdd);

//   // Resort by least time and keep top 10 (if <=10, keeps all)
//   keepTopNByTimeAsc(histData, 10);

//   save(STORAGE_KEYS.hist, histData);
//   renderLeaderboard(histData, "#rank-table-hist");
// }

async function resetHistorical() {
  histData.splice(0, histData.length);
  await saveBoard('hist', histData, { allowClear: true }); // ← explicit clear
  renderLeaderboard(histData, "#rank-table-hist");
}

async function confirmFromModal() {
  if (!_delContext) return;
  const { action } = _delContext;

  // ...delete branch unchanged...

  if (action === "reset-hist") {
    histData.splice(0, histData.length);
    await saveBoard('hist', histData, { allowClear: true }); // ← explicit clear
    renderLeaderboard(histData, "#rank-table-hist");
  }

  if (action === "reset-today") {
    todayData.splice(0, todayData.length);
    await saveBoard('today', todayData, { allowClear: true }); // ← explicit clear
    renderLeaderboard(todayData, "#rank-table-today");
  }

  closeConfirmModal();
}


async function mergeTodayIntoHistorical() {
  ensureAllHaveIds();
  const existing = new Set(histData.filter(r => Number.isInteger(r.id)).map(r => r.id));
  const toAdd = todayData.filter(r => !existing.has(r.id));
  histData.push(...toAdd);
  keepTopNByTimeAsc(histData, 10);
  await saveBoard('hist', histData);
  renderLeaderboard(histData, "#rank-table-hist");
}

function normalizeRows(rows) {
  return rows
    .map(r => ({
      id: Number.isInteger(r.id) ? r.id : undefined,
      name: (r.name || "").trim(),
      score: Math.round((Number(r.score) || 0) * 100) / 100,
    }))
    .filter(r => r.name !== "");  // ← do not keep empty-name rows
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
  modal.classList.add("modal--under-topbar");   // <<< pin panel under topbar
  modal.classList.remove("hidden");
  modal.removeAttribute("aria-hidden");
  modal.removeAttribute("inert");

  document.body.style.overflow = "hidden";

  document.getElementById("add-name").value = "";
  document.getElementById("add-score").value = "";
  setTimeout(() => document.getElementById("add-name").focus(), 0);
}

function closeAddModal() {
  const modal = document.getElementById("add-modal");

  if (_addOpener && typeof _addOpener.focus === "function") {
    _addOpener.focus();
  } else {
    document.body.focus?.();
  }

  // ALSO close the keypad if it is open
  closeNumPad();  // ← added

  modal.setAttribute("aria-hidden", "true");
  modal.setAttribute("inert", "");
  modal.classList.add("hidden");
  modal.classList.remove("modal--under-topbar");

  document.body.style.overflow = "";
  _addTarget = null;
  _addOpener = null;
}

async function confirmAddFromModal() {
  const name = (document.getElementById("add-name").value || "").trim();
  const scoreStr = (document.getElementById("add-score").value || "").trim();

  // --- validations ---
  if (!name) { alert("Please enter a name."); return; }
  if (scoreStr === "") { alert("Please enter a time."); return; }

  const scoreNum = Number(scoreStr);
  if (!Number.isFinite(scoreNum)) { alert("Please enter a valid time (e.g., 5.35)."); return; }
  if (scoreNum <= 0) { alert("Time must be greater than 0."); return; }

  const score = Math.round(scoreNum * 100) / 100;

  if (_addTarget === "today") {
    todayData.push({ id: nextGlobalId(), name, score });
    keepTopNByTimeAsc(todayData, 10);
    await saveBoard('today', todayData);
    renderLeaderboard(todayData, "#rank-table-today");
  } else if (_addTarget === "hist") {
    histData.push({ id: nextGlobalId(), name, score });
    keepTopNByTimeAsc(histData, 10);
    await saveBoard('hist', histData);
    renderLeaderboard(histData, "#rank-table-hist");
  }
  closeAddModal();
}


// function confirmAddFromModal() {
//   const name = (document.getElementById("add-name").value || "").trim();

//   // Raw string from the read-only time input (filled via keypad)
//   const scoreStr = (document.getElementById("add-score").value || "").trim();

//   // --- validations ---
//   if (!name) {
//     alert("Please enter a name.");
//     return;
//   }
//   if (scoreStr === "") {
//     alert("Please enter a time.");
//     return;
//   }
//   // Must be a finite number > 0
//   const scoreNum = Number(scoreStr);
//   if (!Number.isFinite(scoreNum)) {
//     alert("Please enter a valid time (e.g., 5.35).");
//     return;
//   }
//   if (scoreNum <= 0) {
//     alert("Time must be greater than 0.");
//     return;
//   }

//   // Normalize to 2 decimals after validation
//   const score = Math.round(scoreNum * 100) / 100;

//   if (_addTarget === "today") {
//     todayData.push({ id: nextGlobalId(), name, score });
//     keepTopNByTimeAsc(todayData, 10);
//     save(STORAGE_KEYS.today, todayData);
//     renderLeaderboard(todayData, "#rank-table-today");
//   } else if (_addTarget === "hist") {
//     histData.push({ id: nextGlobalId(), name, score });
//     keepTopNByTimeAsc(histData, 10);
//     save(STORAGE_KEYS.hist, histData);
//     renderLeaderboard(histData, "#rank-table-hist");
//   }

//   closeAddModal();
// }


// Add a "Delete" column with × buttons (only in edit mode)
// Add a "Delete" column with × buttons (only in edit mode)
function enableDeleteUI(tableSelector) {
  const table = document.querySelector(tableSelector);
  if (!table) return;

  const tbody = table.tBodies?.[0];
  const hasRows = !!tbody && tbody.rows.length > 0;

  // If empty, ensure the delete column is NOT shown at all
  if (!hasRows) {
    disableDeleteUI(tableSelector);
    table.dataset.showDelete = "1"; // remember we're in edit mode, but no delete column
    return;
  }

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
  [...tbody.rows].forEach((tr) => {
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
  if (!table) return;
  const tbody = table.tBodies?.[0];
  const editing = tbody?.getAttribute("contenteditable") === "true";
  const want = table.dataset.wantDeleteCol === "1";
  const hasRows = countRows(tbody) > 0;

  if (editing && want && hasRows) {
    enableDeleteUI(tableSelector);
  } else {
    // If empty (or not editing), make sure the column is gone
    disableDeleteUI(tableSelector);
  }
}


function applyTop3MedalsToTable(table) {
  if (!table || !table.tBodies || !table.tBodies[0]) return;
  const rows = Array.from(table.tBodies[0].rows);

  // Clear any previous medals
  rows.forEach(tr => {
    const last = tr.lastElementChild;
    if (last) {
      last.classList.remove('has-medal');
      last.removeAttribute('data-medal');
    }
  });

  // Add medals to top 3 rows (0,1,2)
  const medals = ['gold', 'silver', 'bronze'];
  rows.slice(0, 3).forEach((tr, i) => {
    const last = tr.lastElementChild;  // assume last column is Time
    if (!last) return;
    last.classList.add('has-medal');
    last.setAttribute('data-medal', medals[i]);
  });
}

// Apply to whichever tables you have
function applyMedals() {
  const tables = document.querySelectorAll('#rank-table, #rank-table-today, #rank-table-hist');
  tables.forEach(applyTop3MedalsToTable);
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
    msg.textContent   = "Clear all data from Historical Leaderboard on the server?";
    confirmBtn.textContent = "Reset";
    confirmBtn.classList.add("btn--danger");
  } else if (ctx.action === "reset-today") {
    title.textContent = "Confirm Reset";
    msg.textContent   = "Clear all data from Today's Leaderboard on the server?";
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


// function confirmFromModal() {
//   if (!_delContext) return;
//   const { action } = _delContext;

//   if (action === "delete") {
//     const { which, id, name, timeNum } = _delContext;
//     const arr = which === "hist" ? histData : todayData;

//     let rmIndex = -1;
//     if (Number.isInteger(id)) {
//       rmIndex = arr.findIndex(r => r.id === id);        // primary: by id
//     }
//     if (rmIndex < 0) {
//       // fallback: by (name + time)
//       const exact = arr.findIndex(r =>
//         (r.name || "").trim() === name &&
//         Math.abs(Number(r.score || 0) - timeNum) < 1e-9
//       );
//       rmIndex = exact >= 0 ? exact : arr.findIndex(r => (r.name || "").trim() === name);
//     }

//     if (rmIndex >= 0) arr.splice(rmIndex, 1);

//     if (which === "hist") {
//       save(STORAGE_KEYS.hist, arr);
//       renderLeaderboard(histData, "#rank-table-hist");
//       refreshEmptyState();
//       maybeReattachDeleteUI("#rank-table-hist");
//     } else {
//       save(STORAGE_KEYS.today, arr);
//       renderLeaderboard(todayData, "#rank-table-today");
//       refreshEmptyState();
//       maybeReattachDeleteUI("#rank-table-today");
//     }
//   }

//   if (action === "reset-hist") {
//     // clear data + remove LS key
//     histData.splice(0, histData.length);
//     save(STORAGE_KEYS.hist, histData); // when histData is empty
//     renderLeaderboard(histData, "#rank-table-hist");
//     // if in edit mode, keep the delete column visible
//     maybeReattachDeleteUI("#rank-table-hist");
//   }

//   if (action === "reset-today") {
//     todayData.splice(0, todayData.length);
//     save(STORAGE_KEYS.today, todayData);
//     renderLeaderboard(todayData, "#rank-table-today");
//     maybeReattachDeleteUI("#rank-table-today");
//   }

//   closeConfirmModal();
// }

// ===== ID helpers =====

async function confirmFromModal() {
  if (!_delContext) return;
  const { action } = _delContext;

  if (action === "delete") {
    const { which, id, name, timeNum } = _delContext;
    const arr = which === "hist" ? histData : todayData;

    // 1) try by id
    let rmIndex = Number.isInteger(id) ? arr.findIndex(r => r.id === id) : -1;

    // 2) fallback: exact (name + time)
    if (rmIndex < 0) {
      rmIndex = arr.findIndex(r =>
        (r.name || "").trim() === name &&
        Math.abs(Number(r.score || 0) - Number(timeNum)) < 1e-9
      );
    }

    // 3) final fallback: first by name
    if (rmIndex < 0) {
      rmIndex = arr.findIndex(r => (r.name || "").trim() === name);
    }

    if (rmIndex >= 0) arr.splice(rmIndex, 1);

    if (which === "hist") {
      await saveBoard('hist', arr);
      renderLeaderboard(histData, "#rank-table-hist");
    } else {
      await saveBoard('today', arr);
      renderLeaderboard(todayData, "#rank-table-today");
    }
  }

  if (action === "reset-hist") {
    histData.splice(0, histData.length);
    await saveBoard('hist', histData, { allowClear: true }); // ← explicit clear
    renderLeaderboard(histData, "#rank-table-hist");
  }

  if (action === "reset-today") {
    todayData.splice(0, todayData.length);
    await saveBoard('today', todayData, { allowClear: true }); // ← explicit clear
    renderLeaderboard(todayData, "#rank-table-today");
  }

  closeConfirmModal();
}


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
// function ensureAllHaveIds() {
//   let changed = false;
//   let nextId = nextGlobalId();
//   for (const arr of [histData, todayData]) {
//     for (const r of arr) {
//       if (!Number.isInteger(r.id)) {
//         r.id = nextId++;
//         changed = true;
//       }
//     }
//   }
//   if (changed) {
//     save(STORAGE_KEYS.hist, histData);
//     save(STORAGE_KEYS.today, todayData);
//   }
// }

function ensureAllHaveIds() {
  let changed = false;
  let nextId = nextGlobalId();
  for (const arr of [histData, todayData]) {
    for (const r of arr) {
      if (!Number.isInteger(r.id)) { r.id = nextId++; changed = true; }
    }
  }
  return changed; // let the caller decide whether to saveBoard(...)
}


let _numpadTarget = null;
let _repositionPadHandler = null;

/** Position keypad under the input, but never overlapping the modal panel */
function positionNumpadUnder(targetInput) {
  const pad   = document.getElementById("numpad");
  const panel = pad?.querySelector(".numpad__panel");
  const modalPanel = document.querySelector("#add-modal .modal__panel");
  if (!pad || !panel || !targetInput) return;

  pad.classList.add("numpad--anchored");

  // where the input sits
  const inputRect = targetInput.getBoundingClientRect();
  // where the modal panel ends (so we don't overlap it)
  const modalRect = modalPanel?.getBoundingClientRect();

  const gap = 16;     // space under input
  const guard = 8;    // extra space under modal panel

  // ideal position just under the input
  let top = inputRect.bottom + gap;

  // SAFETY: never overlap the modal panel — push below it if needed
  if (modalRect) top = Math.max(top, modalRect.bottom + guard);

  // Horizontal centering is handled by CSS (left:50% + translateX)
  panel.style.top = `${Math.round(top)}px`;
}

/** Open keypad and anchor it */
function openNumPadFor(inputSelector) {
  const input = document.querySelector(inputSelector);
  if (!input) return;
  _numpadTarget = input;

  const pad  = document.getElementById("numpad");
  const disp = document.getElementById("numpad-display");
  disp.value = (input.value || "").toString();

  pad.classList.remove("hidden");
  pad.removeAttribute("aria-hidden");
  document.body.style.overflow = "hidden";

  // wait a frame so layout is correct, then position
  requestAnimationFrame(() => positionNumpadUnder(input));

  // keep it attached on viewport changes
  _repositionPadHandler = () => positionNumpadUnder(input);
  window.addEventListener("resize", _repositionPadHandler, { passive: true });
  window.addEventListener("scroll", _repositionPadHandler, { passive: true });
  window.addEventListener("orientationchange", _repositionPadHandler, { passive: true });
}

/** Close keypad and clean up */
function closeNumPad() {
  const pad = document.getElementById("numpad");
  const disp = document.getElementById("numpad-display");
  pad.classList.add("hidden");
  pad.setAttribute("aria-hidden", "true");
  pad.classList.remove("numpad--anchored");
  document.body.style.overflow = "";
  _numpadTarget = null;

  if (_repositionPadHandler) {
    window.removeEventListener("resize", _repositionPadHandler);
    window.removeEventListener("scroll", _repositionPadHandler);
    window.removeEventListener("orientationchange", _repositionPadHandler);
    _repositionPadHandler = null;
  }
  delete pad.dataset.mode;
  delete pad.dataset.prev;
  disp.placeholder = "";
}


function applyNumPadValue() {
  const disp = document.getElementById("numpad-display");
  if (_numpadTarget) {
    const raw = disp.value;
    if (_numpadTarget.tagName === "INPUT") {
      _numpadTarget.value = raw;
    } else {
      if (raw.trim() === "") { closeNumPad(); return; } // ← keep old value
      const num = Number(raw);
      if (!Number.isFinite(num)) { closeNumPad(); return; } // ← ignore bad input
      const n2 = Math.round(num * 100) / 100;
      _numpadTarget.textContent = n2.toFixed(2);
      const tbody = _numpadTarget.closest("tbody");
      if (tbody && typeof tbody._markDirty === "function") tbody._markDirty();
    }
  }
  closeNumPad();
}



function showEmptyStateIfNeeded(table, message = "There are no records yet.") {
  if (!table || !table.tBodies || !table.tBodies[0]) return;
  const tbody = table.tBodies[0];

  // Remove any previous empty-state row
  tbody.querySelectorAll("tr.table-empty").forEach(tr => tr.remove());

  // If there are **no data rows**, insert an empty-state row
  if (tbody.rows.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "table-empty";
    tr.setAttribute("contenteditable", "false");   // ← block editing of this row

    const td = document.createElement("td");

    // Use header length if available; fallback to current column count or 3
    const colCount =
      (table.tHead && table.tHead.rows[0]?.cells.length) ||
      (table.rows[0]?.cells.length) ||
      3;

    td.colSpan = colCount;
    td.textContent = message;

    // Optional UX polish: don’t allow caret or selection on the text itself
    td.setAttribute("contenteditable", "false");   // ← block editing of the cell too
    td.style.userSelect = "none";                  // ← avoid text selection while editing

    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

function openNumPadForCell(td) {
  if (!td) return;
  _numpadTarget = td;

  const pad  = document.getElementById("numpad");
  const disp = document.getElementById("numpad-display");

  // Remember the previous value (for reference) but start BLANK for quick typing
  const prev = (td.textContent || "").trim();
  pad.dataset.mode = "cell";
  pad.dataset.prev = prev;

  disp.value = "";                 // ← clear automatically
  disp.placeholder = prev || "";   // ← optional: show old value as a hint

  pad.classList.remove("hidden");
  pad.removeAttribute("aria-hidden");
  document.body.style.overflow = "hidden";

  requestAnimationFrame(() => positionNumpadUnder(td));
  _repositionPadHandler = () => positionNumpadUnder(td);
  window.addEventListener("resize", _repositionPadHandler, { passive: true });
  window.addEventListener("scroll", _repositionPadHandler, { passive: true });
  window.addEventListener("orientationchange", _repositionPadHandler, { passive: true });

  // Put cursor in the display so typing starts immediately
  disp.focus();
}



// Button clicks
document.getElementById("numpad")?.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;

  // backdrop close
  if (e.target.id === "numpad") { closeNumPad(); return; }

  const k = e.target.getAttribute("data-k");
  if (!k && e.target.id !== "numpad-ok" && e.target.id !== "numpad-cancel") return;

  const disp = document.getElementById("numpad-display");

  if (k === "del") {
    disp.value = disp.value.slice(0, -1);
  } else if (k === ".") {
    if (!disp.value.includes(".")) {
      disp.value = disp.value ? disp.value + "." : "0.";
    }
  } else if (k) {
    // digits 0-9
    disp.value += k;
  } else if (e.target.id === "numpad-ok") {
    applyNumPadValue();
  } else if (e.target.id === "numpad-cancel") {
    closeNumPad();
  }
});

// Keyboard support for desktop (optional)
document.getElementById("numpad")?.addEventListener("keydown", (e) => {
  const disp = document.getElementById("numpad-display");
  if (e.key >= "0" && e.key <= "9") { disp.value += e.key; e.preventDefault(); }
  if (e.key === "." && !disp.value.includes(".")) { disp.value += "."; e.preventDefault(); }
  if (e.key === "Backspace") { disp.value = disp.value.slice(0, -1); e.preventDefault(); }
  if (e.key === "Enter") { applyNumPadValue(); e.preventDefault(); }
  if (e.key === "Escape") { closeNumPad(); e.preventDefault(); }
});

// Prevent typing directly in #add-score (we use the keypad)
document.getElementById("add-score")?.addEventListener("keydown", (e) => e.preventDefault());


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

  
  // remove from the correct array; prefer match by (name + time) to avoid removing other duplicates
  const arr = which === "hist" ? histData : todayData;
  const idx = arr.findIndex(r => (r.name || "").trim() === name && Math.abs(Number(r.score||0) - timeNum) < 1e-9);
  const idxFallback = arr.findIndex(r => (r.name || "").trim() === name); // fallback if rounding differs
  const rmIndex = idx >= 0 ? idx : idxFallback;
  if (rmIndex >= 0) arr.splice(rmIndex, 1);

  // persist + re-render (ascending = least time first)
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
// document.getElementById('dump-storage')?.addEventListener('click', () => {
//   const hist = JSON.parse(localStorage.getItem(STORAGE_KEYS.hist) || '[]');
//   const today = JSON.parse(localStorage.getItem(STORAGE_KEYS.today) || '[]');
//   console.log('Historical:', hist);
//   console.table(hist);
//   console.log("Today's:", today);
//   console.table(today);
//   alert('Opened console with Local Storage contents.');
// });
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

// Show custom keypad when Time input is clicked/focused
document.getElementById("add-score")?.addEventListener("click", () => openNumPadFor("#add-score"));
document.getElementById("add-score")?.addEventListener("focus", () => openNumPadFor("#add-score"));

// Close keypad when clicking anywhere that's NOT inside the keypad panel or the Add modal panel
document.addEventListener("click", (e) => {
  const pad = document.getElementById("numpad");
  if (!pad || pad.classList.contains("hidden")) return;

  const kpPanel = document.querySelector("#numpad .numpad__panel");
  const modalPanel = document.querySelector("#add-modal .modal__panel");
  const t = e.target;

  const clickedInsideKeypad = kpPanel?.contains(t);
  const clickedInsideAddModal = modalPanel?.contains(t);

  if (!clickedInsideKeypad && !clickedInsideAddModal) {
    closeNumPad();
  }
}, true); // capture phase helps with nested elements

// Close keypad on Escape even if focus isn't inside it
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const pad = document.getElementById("numpad");
    if (pad && !pad.classList.contains("hidden")) closeNumPad();
  }
});

// if ("serviceWorker" in navigator) {
//   navigator.serviceWorker.register("./service-worker.js");

//   // Auto-reload once when a new SW activates
//   navigator.serviceWorker.addEventListener("controllerchange", () => {
//     // Prevent reload loops
//     if (!window.__reloadedAfterSW) {
//       window.__reloadedAfterSW = true;
//       window.location.reload();
//     }
//   });
// }

// ===== Empty-state helpers =====
function ensureEmptyLabel(container, id, text) {
  if (!container) return null;
  let msg = container.querySelector(`#${id}`);
  if (!msg) {
    msg = document.createElement("div");
    msg.id = id;
    msg.textContent = text || "There are no records yet";
    msg.style.cssText = "margin:8px 0; font-size:12px; color:#333;";
    container.appendChild(msg);
  }
  return msg;
}

function countRows(tbody) {
  if (!tbody) return 0;
  return [...tbody.querySelectorAll("tr")]
    .filter(tr => !tr.hidden && !tr.classList.contains("table-empty")) // ← ignore placeholder row
    .length;
}


function refreshEmptyState() {
  // Use your real table IDs
  const histTable  = document.getElementById("rank-table-hist");
  const todayTable = document.getElementById("rank-table-today");

  const histTbody  = histTable?.querySelector("tbody");
  const todayTbody = todayTable?.querySelector("tbody");

  // Toggle inline “There are no records yet” <tr>
  showEmptyStateIfNeeded(histTable,  "There are no records yet.");
  showEmptyStateIfNeeded(todayTable, "There are no records yet.");

  const histCount  = countRows(histTbody);
  const todayCount = countRows(todayTbody);

  // If a table is empty, strip the Delete column entirely (even in edit mode)
  if (histCount === 0)  disableDeleteUI("#rank-table-hist");
  if (todayCount === 0) disableDeleteUI("#rank-table-today");

  // Disable any delete buttons when there are no rows in either table
  const anyRows = (histCount + todayCount) > 0;
  document.querySelectorAll('[data-action="delete"], .btn-delete-row, .row-del').forEach(btn => {
    btn.disabled = !anyRows;
    btn.setAttribute("aria-disabled", !anyRows ? "true" : "false");
  });
}



// Observe DOM changes to keep the empty-state in sync automatically
function setupEmptyStateObservers() {
  const histTbody  = document.querySelector("#rank-table-hist tbody");
  const todayTbody = document.querySelector("#rank-table-today tbody");

  const obs = new MutationObserver(() => refreshEmptyState());
  if (histTbody)  obs.observe(histTbody,  { childList: true, subtree: false });
  if (todayTbody) obs.observe(todayTbody, { childList: true, subtree: false });
}

document.getElementById("add-score")
  ?.addEventListener("click", () => openNumPadFor("#add-score"));


// Prevent pointless delete actions when there's nothing to delete.
// Handles toolbar delete/reset buttons and per-row ".row-del" buttons.
document.addEventListener("click", (e) => {
  const btn = e.target.closest('[data-action="delete"], .btn-delete-row, .row-del');
  if (!btn) return;

  // If already disabled by UI, just swallow.
  if (btn.matches('[disabled], [aria-disabled="true"]')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }

  // Row delete buttons only render when a row exists -> allow.
  if (btn.classList.contains("row-del")) return;

  // For toolbar delete buttons, prefer a specific target table via data-target
  // e.g. <button data-action="delete" data-target="#rank-table-hist">Reset</button>
  const targetSel = btn.getAttribute("data-target");
  const tbody = targetSel ? document.querySelector(`${targetSel} tbody`) : null;

  // If no explicit target, fall back to sum of both tables
  const count = tbody
    ? countRows(tbody)
    : (countRows(document.querySelector("#rank-table-hist tbody")) +
       countRows(document.querySelector("#rank-table-today tbody")));

  if (count === 0) {
    e.preventDefault();
    e.stopImmediatePropagation();
    alert("No records to delete.");
  }
}, true);




// Author: Gama
// Surfers Paradise, QLD
// 18/10/25
// 位卑未敢忘忧国，哪怕无人知我