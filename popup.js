const $ = (id) => document.getElementById(id);

function parseIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function fmtDue(d) {
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function badgeFor(due, now) {
  if (!due) return { text: "no due date parsed", cls: "" };
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
  if (!resp?.ok) return { assignments: {}, courses: {}, settings: { windowDays: 14 }, debug: {}, bytesInUse: 0 };
  return resp;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function render(assignments, windowDays) {
  const list = $("list");
  list.innerHTML = "";

  const now = new Date();
  const cutoff = new Date(now.getTime() + windowDays * 24 * 3600 * 1000);

  const all = Object.values(assignments)
    .map(a => ({ ...a, due: parseIso(a.dueAt) }))
    .filter(a => a.due)
    .sort((a, b) => a.due - b.due);

  if (all.length === 0) {
    const empty = document.createElement("div");
    empty.className = "item";
    empty.innerHTML = `
      <div class="name">No due dates parsed yet</div>
      <div class="course">Your course page shows due dates like “Jan 27 at 11:59PM”. If this stays empty, open Debug and send me the log.</div>
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
    const b = badgeFor(a.due, now);
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <a class="link" href="${a.url}" target="_blank" rel="noreferrer">
        <div class="top">
          <div class="course">${escapeHtml(a.courseName || a.courseId)}</div>
          <div class="due">${fmtDue(a.due)}</div>
        </div>
        <div class="name">${escapeHtml(a.assignmentName)}</div>
      </a>
      <div><span class="badge ${b.cls}">${b.text}</span></div>
    `;
    list.appendChild(div);
  }
}

async function setStatus(text) {
  $("status").textContent = text || "";
}

function bytesToKB(n){ return `${Math.round((n||0)/1024)} KB`; }

function renderDebug(debug, bytesInUse, courses, assignments) {
  $("mem").textContent = `Storage: ${bytesToKB(bytesInUse)} • Courses: ${Object.keys(courses||{}).length} • Items: ${Object.keys(assignments||{}).length}`;
  const lines = [];
  if (debug?.lastRefreshAt) lines.push(`Last refresh: ${debug.lastRefreshAt}`);
  if (Array.isArray(debug?.lastOpenedUrls)) {
    lines.push(`Opened (${debug.lastOpenedUrls.length}):`);
    for (const u of debug.lastOpenedUrls) lines.push(`- ${u}`);
  }
  if (Array.isArray(debug?.courseIds)) {
    lines.push(`Course IDs: ${debug.courseIds.join(", ")}`);
  }
  if (debug?.notes) lines.push(`Notes: ${debug.notes}`);
  $("debugText").textContent = lines.join("\n") || "(no debug data yet)";
}

async function main() {
  const data = await loadData();
  const settings = data.settings || { windowDays: 14 };
  $("windowDays").value = settings.windowDays ?? 14;

  render(data.assignments || {}, settings.windowDays ?? 14);
  renderDebug(data.debug || {}, data.bytesInUse || 0, data.courses || {}, data.assignments || {});

  $("toggleDebug").addEventListener("click", async () => {
    const dbg = $("debug");
    const show = dbg.style.display === "none";
    dbg.style.display = show ? "block" : "none";
    $("toggleDebug").textContent = show ? "Hide debug" : "Show debug";
  });

  $("windowDays").addEventListener("change", async () => {
    const v = Math.max(1, Math.min(365, Number($("windowDays").value || 14)));
    $("windowDays").value = v;
    await send({ type: "SET_SETTINGS", settings: { windowDays: v } });
    const fresh = await loadData();
    render(fresh.assignments || {}, v);
    renderDebug(fresh.debug || {}, fresh.bytesInUse || 0, fresh.courses || {}, fresh.assignments || {});
  });

  $("refreshAll").addEventListener("click", async () => {
    await setStatus("Refreshing…");
    $("refreshAll").disabled = true;
    try {
      await send({ type: "REFRESH_ALL" });
      const fresh = await loadData();
      render(fresh.assignments || {}, (fresh.settings?.windowDays ?? 14));
      renderDebug(fresh.debug || {}, fresh.bytesInUse || 0, fresh.courses || {}, fresh.assignments || {});
      await setStatus("Updated");
    } catch (e) {
      await setStatus("Refresh failed");
    } finally {
      $("refreshAll").disabled = false;
      setTimeout(() => setStatus(""), 2000);
    }
  });

  $("clear").addEventListener("click", async () => {
    await send({ type: "CLEAR_CACHE" });
    const fresh = await loadData();
    render(fresh.assignments || {}, (fresh.settings?.windowDays ?? 14));
    renderDebug(fresh.debug || {}, fresh.bytesInUse || 0, fresh.courses || {}, fresh.assignments || {});
    await setStatus("Cleared");
    setTimeout(() => setStatus(""), 1500);
  });
}

main();
