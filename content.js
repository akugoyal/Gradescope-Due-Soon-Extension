// Gradescope Due Soon - content script (v3)
// Fix: Due column often includes "X days left" line above the actual due date.
// We pick the first line that looks like "Jan 27 at 11:59PM".

function text(el) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

function lines(el) {
  const t = (el?.innerText || el?.textContent || "");
  return t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function isAssignmentsPage() {
  return /\/courses\/\d+\/assignments/.test(location.pathname);
}

function pickDueLine(ls) {
  const re = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b\s+\d{1,2}\s+(?:at\s+)?\d{1,2}:\d{2}\s*(AM|PM)\b/i;
  for (const ln of ls) {
    if (re.test(ln)) return ln.replace(/\s+/g, " ").trim();
  }
  return null;
}

function scrapeAssignmentsFromDom() {
  const courseId = (location.pathname.match(/\/courses\/(\d+)/) || [])[1] || null;

  const header =
    document.querySelector("h1") ||
    document.querySelector(".courseHeader--title") ||
    document.querySelector("[data-testid='course-header-title']") ||
    document.querySelector(".courseHeader");
  const courseName = text(header) || null;

  const items = [];
  const rows = Array.from(document.querySelectorAll("table tbody tr"));

  for (const r of rows) {
    const a = r.querySelector('a[href*="/assignments/"]');
    if (!a) continue;

    const href = a.getAttribute("href") || "";
    const mA = href.match(/\/assignments\/(\d+)/);
    const assignmentId = mA ? mA[1] : null;
    const name = text(a) || "(untitled)";

    const tds = Array.from(r.querySelectorAll("td"));
    const dueCell = tds.length ? tds[tds.length - 1] : null;

    const timeEl = dueCell?.querySelector?.("time[datetime]") || r.querySelector("time[datetime]");
    const dueIso = timeEl ? timeEl.getAttribute("datetime") : null;

    let dueText = null;
    if (dueCell) dueText = pickDueLine(lines(dueCell));

    items.push({
      courseId,
      courseName,
      assignmentId,
      name,
      href: new URL(href, location.origin).toString(),
      dueIso,
      dueText
    });
  }

  return { courseId, courseName, items };
}

async function pushScrapeToBackground(scraped) {
  await chrome.runtime.sendMessage({ type: "SCRAPED_ASSIGNMENTS", scraped }).catch(() => {});
}

(async () => {
  if (isAssignmentsPage()) {
    await new Promise(r => setTimeout(r, 1000));
    const scraped = scrapeAssignmentsFromDom();
    if (scraped?.items?.length) await pushScrapeToBackground(scraped);
  }
})();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SCRAPE_ASSIGNMENTS") {
    sendResponse(scrapeAssignmentsFromDom());
    return true;
  }
});
