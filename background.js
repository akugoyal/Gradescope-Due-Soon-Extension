
// Gradescope Due Soon - background service worker (MV3, ES module) v6.1

const STORAGE_KEYS = {
  assignments: "gs_assignments",
  courses: "gs_courses",
  settings: "gs_settings",
  debug: "gs_debug"
};

const DEFAULT_SETTINGS = { windowDays: 14, termFilter: "ALL", showOverdue: true };
const RATE_LIMIT_MS = 900;
const TAB_LOAD_TIMEOUT_MS = 20000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getFromStorage(key, fallback) {
  const obj = await chrome.storage.local.get([key]);
  return obj[key] ?? fallback;
}
async function setInStorage(obj) { await chrome.storage.local.set(obj); }
function nowIso() { return new Date().toISOString(); }

async function withTempTab(url, fn) {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;

  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, TAB_LOAD_TIMEOUT_MS);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });

  try { return await fn(tabId); }
  finally { try { await chrome.tabs.remove(tabId); } catch {} }
}

function courseDashboardUrl(courseId) {
  return `https://www.gradescope.com/courses/${courseId}`;
}

// --- Discovery: robust term detection by walking DOM around each course card ---
async function discoverCoursesFromHomepage(openedUrls) {
  const dashboardUrl = "https://www.gradescope.com/";
  openedUrls.push(dashboardUrl);

  let found = [];
  await withTempTab(dashboardUrl, async (tabId) => {
    found = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        function norm(s){ return (s||"").replace(/\s+/g," ").trim(); }
        function findTermNear(el){
          // Look at previous siblings / ancestors for a term label like "Spring 2026"
          const termRe = /\b(Spring|Summer|Fall|Winter)\s+20\d{2}\b/i;
          let cur = el;
          for (let depth=0; depth<6 && cur; depth++) {
            // scan previous siblings
            let sib = cur.previousElementSibling;
            let steps = 0;
            while (sib && steps < 8) {
              const t = norm(sib.textContent);
              const m = t.match(termRe);
              if (m) return m[0];
              sib = sib.previousElementSibling;
              steps++;
            }
            cur = cur.parentElement;
          }
          // fallback: scan page for term blocks and pick closest above
          const terms = Array.from(document.querySelectorAll("body *"))
            .map(e => ({ el:e, text:norm(e.textContent), top:e.getBoundingClientRect().top + window.scrollY }))
            .filter(x => termRe.test(x.text) && x.el.childElementCount <= 2);
          const y = el.getBoundingClientRect().top + window.scrollY;
          let best = null;
          for (const t of terms) {
            if (t.top <= y + 5) best = t;
          }
          return best ? best.text.match(termRe)[0] : null;
        }

        const candidates = Array.from(document.querySelectorAll('a[href^="/courses/"]'));
        const out = [];
        for (const a of candidates) {
          const href = a.getAttribute("href") || "";
          const m = href.match(/\/courses\/(\d+)/);
          if (!m) continue;
          const id = m[1];

          const rect = a.getBoundingClientRect();
          const looksLikeCard = rect.width > 200 && rect.height > 60;
          if (!looksLikeCard) continue;

          const titleEl = a.querySelector("h3,h2,h1,strong");
          const name = norm(titleEl?.textContent || a.textContent);

          const term = findTermNear(a);

          out.push({ id, name: name.slice(0, 120) || `Course ${id}`, url: new URL(href, location.origin).toString(), term });
        }
        const dedup = {};
        for (const c of out) dedup[c.id] = c;
        return Object.values(dedup);
      }
    }).then(r => r?.[0]?.result).catch(() => []);
  });

  return found;
}

// --- Due parsing (prefer dueText; dueIso is optional and can be misleading if it came from Released) ---
function parseDueDate({ dueText, dueIso }) {
  if (dueText) {
    let t = dueText.trim();
    const hasYear = /\b20\d{2}\b/.test(t);
    const year = new Date().getFullYear();
    if (!hasYear) t = `${t} ${year}`;
    t = t.replace(/\bat\b/i, " ");
    const d = new Date(t);
    if (!isNaN(d.getTime())) return d;
  }
  if (dueIso) {
    const d = new Date(dueIso);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

async function mergeScraped(scraped) {
  if (!scraped) return;

  const assignments = await getFromStorage(STORAGE_KEYS.assignments, {});
  const courses = await getFromStorage(STORAGE_KEYS.courses, {});

  if (scraped.notAuthorized) {
    if (scraped.courseId) {
      courses[scraped.courseId] = courses[scraped.courseId] || { id: scraped.courseId, name: scraped.courseName || `Course ${scraped.courseId}`, url: courseDashboardUrl(scraped.courseId) };
      courses[scraped.courseId].access = "denied";
      courses[scraped.courseId].lastSeen = nowIso();
      await setInStorage({ [STORAGE_KEYS.courses]: courses });
    }
    return;
  }

  if (!Array.isArray(scraped.items)) return;

  const courseId = scraped.courseId || null;
  const courseName = scraped.courseName || (courseId && courses[courseId]?.name) || null;

  if (courseId) {
    courses[courseId] = courses[courseId] || { id: courseId, name: courseName || `Course ${courseId}`, url: courseDashboardUrl(courseId) };
    if (courseName) courses[courseId].name = courseName;
    courses[courseId].access = "ok";
    courses[courseId].lastSeen = nowIso();
  }

  for (const it of scraped.items) {
    const cid = it.courseId || courseId || "unknown";
    const aid = it.assignmentId || it.href;
    const key = `${cid}|${aid}`;

    const dueDate = parseDueDate({ dueText: it.dueText, dueIso: it.dueIso });

    assignments[key] = {
      key,
      courseId: cid,
      courseName: it.courseName || courseName || courses[cid]?.name || `Course ${cid}`,
      assignmentId: it.assignmentId || null,
      assignmentName: it.name || "(untitled)",
      url: it.href,
      dueAt: dueDate ? dueDate.toISOString() : null,
      dueText: it.dueText || null,
      lastUpdated: nowIso()
    };
  }

  await setInStorage({ [STORAGE_KEYS.assignments]: assignments, [STORAGE_KEYS.courses]: courses });
}

async function refreshCourse(course, openedUrls, results) {
  const url = courseDashboardUrl(course.id);
  openedUrls.push(url);

  let scraped = null;
  await withTempTab(url, async (tabId) => {
    scraped = await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_ASSIGNMENTS" }).catch(() => null);
    if (!scraped) scraped = { courseId: course.id, courseName: course.name, items: [], notAuthorized: false };
  });

  results.push({
    id: course.id,
    name: course.name,
    term: course.term || null,
    url,
    notAuthorized: !!scraped?.notAuthorized,
    itemsFound: scraped?.items?.length ?? 0,
    parsedDueCount: (scraped?.items || []).filter(i => i.dueText || i.dueIso).length
  });

  return scraped;
}

async function refreshAll() {
  const openedUrls = [];
  const results = [];

  const discovered = await discoverCoursesFromHomepage(openedUrls);

  const coursesMap = {};
  for (const c of discovered) coursesMap[c.id] = { ...c, lastSeen: nowIso() };
  await setInStorage({ [STORAGE_KEYS.courses]: coursesMap });

  const termsInOrder = [];
  for (const c of discovered) if (c.term && !termsInOrder.includes(c.term)) termsInOrder.push(c.term);

  // If termFilter is ALL, default to newest term (top-of-page) if we found one.
  const currentSettings = await getFromStorage(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  if ((currentSettings.termFilter === "ALL" || !currentSettings.termFilter) && termsInOrder.length) {
    await setInStorage({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS, ...currentSettings, termFilter: termsInOrder[0], showOverdue: true } });
  }

  for (const course of discovered) {
    try {
      const scraped = await refreshCourse(course, openedUrls, results);
      await mergeScraped(scraped);
    } catch (e) {
      results.push({ id: course.id, name: course.name, term: course.term || null, url: courseDashboardUrl(course.id), error: String(e) });
    }
    await sleep(RATE_LIMIT_MS);
  }

  await setInStorage({
    [STORAGE_KEYS.debug]: {
      lastRefreshAt: nowIso(),
      lastOpenedUrls: openedUrls,
      discoveredCourseIds: discovered.map(c => c.id),
      discoveredTerms: termsInOrder,
      results,
      notes: "Term is inferred from the homepage layout near each course card."
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "REFRESH_ALL") { await refreshAll(); sendResponse({ ok: true }); return; }
    if (msg?.type === "CLEAR_CACHE") { await chrome.storage.local.remove([STORAGE_KEYS.assignments, STORAGE_KEYS.courses, STORAGE_KEYS.debug]); sendResponse({ ok: true }); return; }
    if (msg?.type === "GET_DATA") {
      const assignments = await getFromStorage(STORAGE_KEYS.assignments, {});
      const courses = await getFromStorage(STORAGE_KEYS.courses, {});
      const settings = await getFromStorage(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
      const debug = await getFromStorage(STORAGE_KEYS.debug, {});
      const bytesInUse = await chrome.storage.local.getBytesInUse(null);
      sendResponse({ ok: true, assignments, courses, settings, debug, bytesInUse });
      return;
    }
    if (msg?.type === "SET_SETTINGS") {
      const current = await getFromStorage(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
      const next = { ...DEFAULT_SETTINGS, ...current, ...(msg.settings || {}) };
      await setInStorage({ [STORAGE_KEYS.settings]: next });
      sendResponse({ ok: true, settings: next });
      return;
    }
    if (msg?.type === "SCRAPED_ASSIGNMENTS") { await mergeScraped(msg.scraped); sendResponse({ ok: true }); return; }
    sendResponse({ ok: false, error: "unknown_message" });
  })();
  return true;
});
