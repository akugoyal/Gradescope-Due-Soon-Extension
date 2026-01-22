// Gradescope Due Soon - background service worker (MV3, ES module) v4
// Fix: Use /courses/<id> dashboard instead of /courses/<id>/assignments (often unauthorized for students)

const STORAGE_KEYS = {
  assignments: "gs_assignments",
  courses: "gs_courses",
  settings: "gs_settings",
  debug: "gs_debug"
};

const DEFAULT_SETTINGS = { windowDays: 14 };
const RATE_LIMIT_MS = 900;
const TAB_LOAD_TIMEOUT_MS = 20000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getFromStorage(key, fallback) {
  const obj = await chrome.storage.local.get([key]);
  return obj[key] ?? fallback;
}

async function setInStorage(obj) {
  await chrome.storage.local.set(obj);
}

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

  try {
    return await fn(tabId);
  } finally {
    try { await chrome.tabs.remove(tabId); } catch {}
  }
}

// --- Course discovery from homepage cards ---
async function discoverCoursesFromHomepage(openedUrls) {
  const dashboardUrl = "https://www.gradescope.com/";
  openedUrls.push(dashboardUrl);

  let found = [];
  await withTempTab(dashboardUrl, async (tabId) => {
    found = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        // Prefer course cards: anchors that contain a course tile with assignments count footer.
        const candidates = Array.from(document.querySelectorAll('a[href^="/courses/"]'));
        const out = [];
        for (const a of candidates) {
          const href = a.getAttribute("href") || "";
          const m = href.match(/\/courses\/(\d+)/);
          if (!m) continue;
          const id = m[1];

          // Heuristic: course cards usually contain a strong title area and an assignments count footer.
          const titleEl = a.querySelector("h3") || a.querySelector("h2") || a.querySelector("h1");
          const name = (titleEl?.textContent || a.textContent || "").replace(/\s+/g," ").trim();

          // Filter out weird sidebar links by requiring visible box size
          const rect = a.getBoundingClientRect();
          const looksLikeCard = rect.width > 200 && rect.height > 60;

          if (!looksLikeCard) continue;

          out.push({ id, name: name.slice(0, 120) || `Course ${id}`, url: new URL(href, location.origin).toString() });
        }
        const dedup = {};
        for (const c of out) dedup[c.id] = c;
        return Object.values(dedup);
      }
    }).then(r => r?.[0]?.result).catch(() => []);
  });

  return found;
}

function courseDashboardUrl(courseId) {
  return `https://www.gradescope.com/courses/${courseId}`;
}

// --- Due parsing ---
function parseDueDate({ dueIso, dueText }) {
  if (dueIso) {
    const d = new Date(dueIso);
    if (!isNaN(d.getTime())) return d;
  }
  if (!dueText) return null;

  let t = dueText.trim();
  const hasYear = /\b20\d{2}\b/.test(t);
  const year = new Date().getFullYear();
  if (!hasYear) t = `${t} ${year}`;
  t = t.replace(/\bat\b/i, " ");
  const d = new Date(t);
  if (!isNaN(d.getTime())) return d;
  return null;
}

// --- Merge scraped into cache ---
async function mergeScraped(scraped) {
  if (!scraped) return;

  const assignments = await getFromStorage(STORAGE_KEYS.assignments, {});
  const courses = await getFromStorage(STORAGE_KEYS.courses, {});

  if (scraped.notAuthorized) {
    // Still record the course as inaccessible if we know the id
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

    const dueDate = parseDueDate({ dueIso: it.dueIso, dueText: it.dueText });

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

// --- Refresh one course (open dashboard, scrape) ---
async function refreshCourse(course, openedUrls, results) {
  const url = courseDashboardUrl(course.id);
  openedUrls.push(url);

  let scraped = null;
  await withTempTab(url, async (tabId) => {
    scraped = await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_ASSIGNMENTS" }).catch(() => null);

    // Inline fallback if messaging fails
    if (!scraped) {
      scraped = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          function text(el){ return (el?.textContent || "").replace(/\s+/g," ").trim(); }
          function lines(el){
            const t=(el?.innerText || el?.textContent || "");
            return t.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
          }
          function pickDue(ls){
            const re=/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b\s+\d{1,2}\s+(?:at\s+)?\d{1,2}:\d{2}\s*(AM|PM)\b/i;
            for (const ln of ls){ if (re.test(ln)) return ln.replace(/\s+/g," ").trim(); }
            return null;
          }
          const notAuthorized = /not authorized to access/i.test(document.body?.innerText || "");
          const courseId = (location.pathname.match(/\/courses\/(\d+)/)||[])[1] || null;
          const header = document.querySelector("h1, .courseHeader--title, .courseHeader");
          const courseName = text(header) || null;

          const items=[];
          const rows=Array.from(document.querySelectorAll("table tbody tr"));
          for (const r of rows){
            const a=r.querySelector('a[href*="/assignments/"]') || r.querySelector("a");
            if(!a) continue;
            const href=a.getAttribute("href")||"";
            const m=href.match(/\/assignments\/(\d+)/);
            const assignmentId=m?m[1]:null;
            const name=text(a)||"(untitled)";
            const tds=Array.from(r.querySelectorAll("td"));
            const dueCell=tds.length?tds[tds.length-1]:null;
            const timeEl = dueCell?.querySelector?.("time[datetime]") || r.querySelector("time[datetime]");
            const dueIso = timeEl ? timeEl.getAttribute("datetime") : null;
            const dueText = dueCell ? pickDue(lines(dueCell)) : null;
            items.push({ courseId, courseName, assignmentId, name, href: new URL(href, location.origin).toString(), dueIso, dueText });
          }
          return { courseId, courseName, items, notAuthorized };
        }
      }).then(r => r?.[0]?.result).catch(() => null);
    }
  });

  // Record per-course result for debug
  results.push({
    id: course.id,
    name: course.name,
    url,
    notAuthorized: !!scraped?.notAuthorized,
    itemsFound: scraped?.items?.length ?? 0,
    parsedDueCount: (scraped?.items || []).filter(i => i.dueText || i.dueIso).length
  });

  return scraped;
}

// --- Refresh all ---
async function refreshAll() {
  const openedUrls = [];
  const results = [];

  const discovered = await discoverCoursesFromHomepage(openedUrls);

  // Store discovered courses
  const coursesMap = {};
  for (const c of discovered) coursesMap[c.id] = { ...c, lastSeen: nowIso() };
  await setInStorage({ [STORAGE_KEYS.courses]: coursesMap });

  // Refresh each discovered course
  for (const course of discovered) {
    try {
      const scraped = await refreshCourse(course, openedUrls, results);
      await mergeScraped(scraped);
    } catch (e) {
      results.push({ id: course.id, name: course.name, url: courseDashboardUrl(course.id), error: String(e) });
    }
    await sleep(RATE_LIMIT_MS);
  }

  await setInStorage({
    [STORAGE_KEYS.debug]: {
      lastRefreshAt: nowIso(),
      lastOpenedUrls: openedUrls,
      discoveredCourseIds: discovered.map(c => c.id),
      results,
      notes: "If a course shows notAuthorized=true, Gradescope blocked that page. We now use /courses/<id> dashboards instead of /assignments."
    }
  });
}

// --- Message handling ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "REFRESH_ALL") {
      await refreshAll();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "CLEAR_CACHE") {
      await chrome.storage.local.remove([STORAGE_KEYS.assignments, STORAGE_KEYS.courses, STORAGE_KEYS.debug]);
      sendResponse({ ok: true });
      return;
    }
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
      const next = { ...DEFAULT_SETTINGS, ...(msg.settings || {}) };
      await setInStorage({ [STORAGE_KEYS.settings]: next });
      sendResponse({ ok: true, settings: next });
      return;
    }
    if (msg?.type === "SCRAPED_ASSIGNMENTS") {
      await mergeScraped(msg.scraped);
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "unknown_message" });
  })();
  return true;
});
