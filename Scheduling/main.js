// TODO: set these to your Supabase project credentials
const SUPABASE_URL = window.SUPABASE_URL || "https://rhgfzhmessbxoesqkixr.supabase.co";
const SUPABASE_ANON_KEY =
  window.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJoZ2Z6aG1lc3NieG9lc3FraXhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEzNzIzNjYsImV4cCI6MjA3Njk0ODM2Nn0.auo5AOo3iV4j1pZIFYQSBfYUrKOIH8_mz0k4F56VkkY";
const TABLE_NAME = "Employee";

let employees = [];

const listEl = document.getElementById("name-list");
const windowEl = document.getElementById("name-window");
const hintEl = document.getElementById("load-hint");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const suggestionsEl = document.getElementById("suggestions");
const detailName = document.getElementById("detail-name");
const detailVenue = document.getElementById("detail-venue");
const detailPosition = document.getElementById("detail-position");
const detailType = document.getElementById("detail-type");
const copyrightYear = document.getElementById("copyright-year");

function renderList(rows) {
  employees = rows || [];
  listEl.innerHTML = "";
  if (!employees.length) {
    const empty = document.createElement("li");
    empty.textContent = "No employees found.";
    listEl.appendChild(empty);
    return;
  }
  employees.forEach((row, idx) => {
    const li = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = idx + 1;

    const text = document.createElement("span");
    text.textContent = row.name || "Unnamed";

    li.appendChild(badge);
    li.appendChild(text);
    listEl.appendChild(li);
  });
}

function renderDetail(row) {
  if (!row) {
    detailName.textContent = "—";
    detailVenue.textContent = "—";
    detailPosition.textContent = "—";
    detailType.textContent = "—";
    return;
  }
  detailName.textContent = row.name || "Unnamed";
  detailVenue.textContent = row.venue || "—";
  detailPosition.textContent = row.position || "—";
  detailType.textContent = row.type || "—";
}

function handleSearch(term) {
  const query = term.trim().toLowerCase();
  if (!query) {
    renderDetail(null);
    hideSuggestions();
    return;
  }
  const match = employees.find((emp) => (emp.name || "").toLowerCase().includes(query));
  renderDetail(match || null);
}

function showSuggestions(term) {
  if (!suggestionsEl) return;
  const q = term.trim().toLowerCase();
  suggestionsEl.innerHTML = "";
  if (!q) {
    hideSuggestions();
    return;
  }
  const matches = employees.filter((emp) => (emp.name || "").toLowerCase().startsWith(q));
  if (!matches.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No results";
    suggestionsEl.appendChild(li);
    suggestionsEl.classList.add("open");
    return;
  }
  matches.forEach((emp) => {
    const li = document.createElement("li");
    li.textContent = emp.name || "Unnamed";
    li.setAttribute("role", "option");
    li.addEventListener("click", () => {
      searchInput.value = emp.name || "";
      renderDetail(emp);
      hideSuggestions();
    });
    suggestionsEl.appendChild(li);
  });
  suggestionsEl.classList.add("open");
}

function hideSuggestions() {
  if (suggestionsEl) {
    suggestionsEl.classList.remove("open");
  }
}

async function fetchEmployees() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes("your-project-ref")) {
    hintEl.textContent = "Set your Supabase URL and anon key to load employees.";
    return;
  }
  if (typeof supabase === "undefined") {
    hintEl.textContent = "Supabase client failed to load.";
    return;
  }
  try {
    hintEl.textContent = "Loading employees…";
    const { createClient } = supabase;
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await client
      .from(TABLE_NAME)
      .select("id, name, venue, position, type")
      .order("id", { ascending: true });
    if (error) throw error;
    renderList(data);
    hintEl.textContent = `Showing ${data.length} employee${data.length === 1 ? "" : "s"}.`;
    renderDetail(data[0] || null);
  } catch (err) {
    console.error("Error loading employees", err);
    const message = err?.message || "Failed to load employees.";
    hintEl.textContent = message;
    renderList([]);
  }
}

if (copyrightYear) {
  copyrightYear.textContent = new Date().getFullYear();
}

if (searchForm) {
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    handleSearch(searchInput.value || "");
    hideSuggestions();
  });
}

if (searchInput) {
  searchInput.addEventListener("input", (e) => {
    const term = e.target.value || "";
    showSuggestions(term);
  });
  // allow click on suggestions before closing
  searchInput.addEventListener("blur", () => {
    setTimeout(() => hideSuggestions(), 120);
  });
}

if (suggestionsEl) {
  suggestionsEl.addEventListener("mousedown", (e) => {
    // prevent blur from hiding before click
    e.preventDefault();
  });
}

// Buttons under detail card: placeholder hooks
document.querySelectorAll(".detail-actions button").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.textContent === "Reset") {
      searchInput.value = "";
      renderDetail(null);
      hideSuggestions();
      return;
    }
    console.log(`${btn.textContent} clicked`);
  });
});

fetchEmployees();
