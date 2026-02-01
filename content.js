
// Gradescope Due Soon - content script (v6.1)

function text(el) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}
function lines(el) {
  const t = (el?.innerText || el?.textContent || "");
  return t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function isCoursePage() {
  return /\/courses\/\d+\/?$/.test(location.pathname) || /\/courses\/\d+\/assignments\/?$/.test(location.pathname);
}
function pickDueLine(ls) {
  // Match: "Jan 27 at 11:59PM" or "Jan 27 11:59PM"
  const re = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b\s+\d{1,2}\s+(?:at\s+)?\d{1,2}:\d{2}\s*(AM|PM)\b/i;
  for (const ln of ls) if (re.test(ln)) return ln.replace(/\s+/g, " ").trim();
  return null;
}
function pageNotAuthorized() {
  return /not authorized to access/i.test(document.body?.innerText || "");
}

// Gradescope often uses datetime attributes like "2026-01-27 23:59:00 -0500".
// Normalize to RFC3339 ("2026-01-27T23:59:00-05:00") so Date parsing is reliable.
function normalizeDatetimeAttr(dt) {
  if (!dt) return null;
  const s = String(dt).trim();
  // Already RFC3339/ISO
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) return s;
  // "YYYY-MM-DD HH:MM:SS -0500" -> "YYYY-MM-DDTHH:MM:SS-05:00"
  const m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-])(\d{2})(\d{2})$/);
  if (m) {
    const [, d, t, sign, hh, mm] = m;
    return `${d}T${t}${sign}${hh}:${mm}`;
  }
  // Best-effort fallback
  return s;
}

function pickBestDueTimeEl(dueCell) {
  if (!dueCell) return null;
  const times = Array.from(dueCell.querySelectorAll("time[datetime]"));
  if (!times.length) return null;
  // Prefer a time element explicitly labelled as the due date.
  const byAria = times.find(t => /^Due at/i.test(t.getAttribute("aria-label") || ""));
  if (byAria) return byAria;
  // Otherwise pick a "dueDate" element that is NOT the late due date.
  const dueDates = times.filter(t => (t.classList?.contains("submissionTimeChart--dueDate")));
  const nonLate = dueDates.find(t => !/Late Due Date/i.test(t.getAttribute("aria-label") || "") && !/Late Due Date/i.test(t.textContent || ""));
  if (nonLate) return nonLate;
  // Fall back to the last time on the row (often the due date even when labels differ).
  return times[times.length - 1];
}

function scrapeFromTable(courseId, courseName) {
  const items = [];
  const table = document.querySelector("#assignments-student-table") || document.querySelector("table");
  const rows = Array.from((table || document).querySelectorAll("tbody tr"));
  for (const r of rows) {
    // Newer Gradescope layouts use a <button class="js-submitAssignment" data-assignment-id="..."> as the primary link.
    const btn = r.querySelector("button.js-submitAssignment[data-assignment-id]");
    const link = r.querySelector('a[href*="/assignments/"]') || r.querySelector("a");
    const assignmentId = btn?.getAttribute("data-assignment-id") || (link?.getAttribute("href")?.match(/\/assignments\/(\d+)/) || [])[1] || null;
    const name = text(btn) || text(link) || "(untitled)";
    if (!assignmentId) continue;

    const href = `/courses/${courseId}/assignments/${assignmentId}`;

    const tds = Array.from(r.querySelectorAll("td"));

    // Status column (Submitted / No Submission / etc.)
    const statusCell = tds.length >= 1 ? tds[0] : null;
    const statusText = text(statusCell?.querySelector?.(".submissionStatus--text") || statusCell);
    const submitted = /submitted/i.test(statusText) && !/no submission/i.test(statusText);

    const dueCell = tds.length ? tds[tds.length - 1] : null;

    // IMPORTANT: Only look for <time> INSIDE dueCell; never fall back to row-wide <time>.
    // Prefer the element whose aria-label starts with "Due at" (and not "Late Due Date").
    const timeEls = Array.from(dueCell?.querySelectorAll?.("time[datetime]") || []);
    const dueTime =
      timeEls.find(t => /^Due at/i.test(t.getAttribute("aria-label") || "")) ||
      timeEls.find(t => {
        const aria = (t.getAttribute("aria-label") || "").toLowerCase();
        return aria.includes("due") && !aria.includes("late due");
      }) ||
      timeEls.find(t => (t.classList?.contains("submissionTimeChart--dueDate") || false)) ||
      null;

    const dueIso = normalizeDatetimeAttr(dueTime?.getAttribute("datetime"));
    const dueText = dueTime ? text(dueTime) : (dueCell ? pickDueLine(lines(dueCell)) : null);

    items.push({
      courseId, courseName,
      assignmentId,
      name,
      href: new URL(href, location.origin).toString(),
      dueIso, dueText,
      submitted, statusText
    });
  }
  return items;
}

function scrapeByLinkScan(courseId, courseName) {
  const items = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/assignments/"]'));
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    const mA = href.match(/\/assignments\/(\d+)/);
    if (!mA) continue;
    const assignmentId = mA[1];
    if (seen.has(assignmentId)) continue;
    seen.add(assignmentId);

    const container = a.closest("tr, li, div") || a.parentElement;

    // Try to find a sibling-ish block that contains due line text; do not use arbitrary time tags.
    let dueText = null;
    if (container) dueText = pickDueLine(lines(container));

    const dueTime = container?.querySelector?.("time.submissionTimeChart--dueDate[datetime][aria-label^='Due at'], time[datetime][aria-label^='Due at']")
      || container?.querySelector?.("time.submissionTimeChart--dueDate[datetime]")
      || container?.querySelector?.("time[datetime]");
    const dueIso = normalizeDatetimeAttr(dueTime?.getAttribute("datetime"));

    items.push({
      courseId, courseName,
      assignmentId,
      name: text(a) || "(untitled)",
      href: new URL(href, location.origin).toString(),
      dueIso, dueText,
      submitted, statusText
    });
  }
  return items;
}

function scrapeAssignmentsFromDom() {
  const courseId = (location.pathname.match(/\/courses\/(\d+)/) || [])[1] || null;

  const header =
    document.querySelector("h1") ||
    document.querySelector(".courseHeader--title") ||
    document.querySelector("[data-testid='course-header-title']") ||
    document.querySelector(".courseHeader");
  const courseName = text(header) || null;

  if (pageNotAuthorized()) {
    return { courseId, courseName, items: [], notAuthorized: true };
  }

  let items = scrapeFromTable(courseId, courseName);

  if (!items.length) {
    items = scrapeByLinkScan(courseId, courseName);
  }

  return { courseId, courseName, items, notAuthorized: false };
}

async function pushScrapeToBackground(scraped) {
  await chrome.runtime.sendMessage({ type: "SCRAPED_ASSIGNMENTS", scraped }).catch(() => {});
}

(async () => {
  if (isCoursePage()) {
    await new Promise(r => setTimeout(r, 1400));
    const scraped = scrapeAssignmentsFromDom();
    if (scraped?.items?.length || scraped?.notAuthorized) await pushScrapeToBackground(scraped);
  }
})();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SCRAPE_ASSIGNMENTS") {
    sendResponse(scrapeAssignmentsFromDom());
    return true;
  }
});