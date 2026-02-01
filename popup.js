
// Helper so the popup doesn't crash if an element id changes.
function $(...ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) return el;
  }
  return null;
}

function parseIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function fmtDue(d) {
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function badgeFor(due, now, submitted) {
  if (submitted) return { text: "submitted", cls: "submitted" };
  const ms = due - now;
  if (ms < 0) return { text: "overdue", cls: "overdue" };
  if (ms < 48 * 3600 * 1000) return { text: "soon", cls: "soon" };
  return { text: "upcoming", cls: "" };
}

async function send(msg) {
  return await chrome.runtime.sendMessage(msg);
}

async function loadData() {
  const resp = await send({ type: "GET_DATA" });
  if (!resp?.ok) return { assignments: {}, courses: {}, settings: { windowDays: 14, termFilter: "ALL", showPast: false, showSubmitted: false }, debug: {}, bytesInUse: 0 };
  return resp;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function bytesToKB(n) { return `${Math.round((n || 0) / 1024)} KB`; }

function render(assignments, courses, windowDays, termFilter, showPast, showSubmitted) {
  const list = $("list");
  list.innerHTML = "";

  const now = new Date();
  const cutoff = new Date(now.getTime() + windowDays * 24 * 3600 * 1000);

  const courseTerm = (cid) => (courses && courses[cid] && courses[cid].term) ? courses[cid].term : null;

  const all = Object.values(assignments)
    .map(a => ({ ...a, due: parseIso(a.dueAt), term: courseTerm(a.courseId), submitted: !!a.submitted }))
    .filter(a => a.due)
    .filter(a => (termFilter === "ALL" ? true : (a.term === termFilter)))
    .filter(a => (showSubmitted ? true : !a.submitted))
    .filter(a => (showPast ? true : a.due >= now))
    .sort((a, b) => a.due - b.due);

  if (all.length === 0) {
    const empty = document.createElement("div");
    empty.className = "item";
    empty.innerHTML = `
      <div class="name">No due dates found for your filters</div>
      <div class="course">Try switching term to “All terms”, or toggle “Include past / submitted”. If it stays empty, click into a course once and hit Refresh all.</div>
    `;
    list.appendChild(empty);
    return;
  }

  const inWindow = all.filter(a => a.due <= cutoff);
  const show = inWindow.length ? inWindow : all.slice(0, 10);

  if (!inWindow.length) {
    const note = document.createElement("div");
    note.className = "item";
    note.innerHTML = `
      <div class="name">Nothing due in the next ${windowDays} days</div>
      <div class="course">Showing your next upcoming assignments instead.</div>
    `;
    list.appendChild(note);
  }

  for (const a of show) {
    const b = badgeFor(a.due, now, a.submitted);
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <a class="link" href="${a.url}" target="_blank" rel="noreferrer">
        <div class="top">
          <div class="course">${escapeHtml(a.courseName || a.courseId)}${a.term ? " • " + escapeHtml(a.term) : ""}</div>
          <div class="due">${fmtDue(a.due)}</div>
        </div>
        <div class="name">${escapeHtml(a.assignmentName)}</div>
      </a>
      <div><span class="badge ${b.cls}">${b.text}</span></div>
    `;
    list.appendChild(div);
  }
}

function renderDebug(debug, bytesInUse, courses, assignments) {
  $("mem").textContent = `Storage: ${bytesToKB(bytesInUse)} • Courses: ${Object.keys(courses || {}).length} • Items: ${Object.keys(assignments || {}).length}`;
  const lines = [];
  if (debug?.lastRefreshAt) lines.push(`Last refresh: ${debug.lastRefreshAt}`);
  if (Array.isArray(debug?.lastOpenedUrls)) {
    lines.push(`Opened (${debug.lastOpenedUrls.length}):`);
    for (const u of debug.lastOpenedUrls) lines.push(`- ${u}`);
  }
  if (Array.isArray(debug?.results)) {
    lines.push("");
    lines.push("Per-course scrape results:");
    for (const r of debug.results) {
      const bits = [];
      if (r.error) bits.push(`error=${r.error}`);
      else bits.push(`itemsFound=${r.itemsFound}`, `dueFields=${r.parsedDueCount}`, `notAuthorized=${r.notAuthorized}`);
      lines.push(`- ${r.id} (${r.name || "?"})${r.term ? " [" + r.term + "]" : ""}: ${bits.join(" • ")}`);
    }
  }
  if (Array.isArray(debug?.discoveredTerms)) {
    lines.push("");
    lines.push(`Discovered terms: ${debug.discoveredTerms.join(", ")}`);
  }
  if (debug?.notes) lines.push(`Notes: ${debug.notes}`);
  $("debugText").textContent = lines.join("\n") || "(no debug data yet)";
}

function fillTermSelect(courses, selected) {
  const sel = $("termSelect");
  if (!sel) return;
  const terms = Array.from(new Set(Object.values(courses || {}).map(c => c.term).filter(Boolean)));
  sel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "ALL";
  optAll.textContent = "All terms";
  sel.appendChild(optAll);
  for (const t of terms) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    sel.appendChild(opt);
  }
  sel.value = terms.includes(selected) ? selected : "ALL";
}

async function refreshUI() {
  const data = await loadData();
  const settings = data.settings || { windowDays: 14, termFilter: "ALL", showPast: false, showSubmitted: false };

  const wd = $("windowDays");
  if (wd) wd.value = settings.windowDays ?? 14;
  fillTermSelect(data.courses || {}, settings.termFilter ?? "ALL");
  const sp = $("showPast");
  if (sp) sp.checked = settings.showPast ?? false;
  const ss = $("showSubmitted");
  if (ss) ss.checked = settings.showSubmitted ?? false;

  render(data.assignments || {}, data.courses || {}, settings.windowDays ?? 14, settings.termFilter ?? "ALL", settings.showPast ?? false, settings.showSubmitted ?? false);
  renderDebug(data.debug || {}, data.bytesInUse || 0, data.courses || {}, data.assignments || {});
}

async function main() {
  await refreshUI();

  $("toggleDebug")?.addEventListener("click", async () => {
    const dbg = $("debug");
    const show = dbg.style.display === "none";
    dbg.style.display = show ? "block" : "none";
    $("toggleDebug").textContent = show ? "Hide debug" : "Show debug";
  });

  $("windowDays")?.addEventListener("change", async () => {
    const v = Math.max(1, Math.min(365, Number($("windowDays").value || 14)));
    $("windowDays").value = v;
    await send({ type: "SET_SETTINGS", settings: { windowDays: v } });
    await refreshUI();
  });

  $("termSelect")?.addEventListener("change", async () => {
    const termFilter = $("termSelect").value || "ALL";
    await send({ type: "SET_SETTINGS", settings: { termFilter } });
    await refreshUI();
  });

  $("showPast")?.addEventListener("change", async () => {
    const showPast = $("showPast").checked;
    await send({ type: "SET_SETTINGS", settings: { showPast } });
    await refreshUI();
  });

  $("showSubmitted")?.addEventListener("change", async () => {
    const showSubmitted = $("showSubmitted").checked;
    await send({ type: "SET_SETTINGS", settings: { showSubmitted } });
    await refreshUI();
  });

  $("refreshAll")?.addEventListener("click", async () => {
    await send({ type: "REFRESH_ALL" });
    await refreshUI();
  });

  $("clearCache", "clear")?.addEventListener("click", async () => {
    await send({ type: "CLEAR_CACHE" });
    await refreshUI();
  });
}

document.addEventListener("DOMContentLoaded", main);
