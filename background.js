// Gradescope Due Soon - background service worker (MV3, ES module) v3 with debug

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
async function ensureCoursesList() {
  let courses = await getFromStorage(STORAGE_KEYS.courses, {});
  if (Object.keys(courses).length) return courses;

  const dashboardUrl = "https://www.gradescope.com/";
  await withTempTab(dashboardUrl, async (tabId) => {
    const found = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const out = [];
        // Course cards are anchors to /courses/<id>
        const anchors = Array.from(document.querySelectorAll('a[href^="/courses/"]'));
        for (const a of anchors) {
          const href = a.getAttribute("href") || "";
          const m = href.match(/\/courses\/(\d+)/);
          if (!m) continue;
          const id = m[1];
          // Use card title text, not nested "assignments" count
          const card = a.closest("a") || a;
          const name = (a.querySelector("h3")?.textContent || a.textContent || "").trim() || `Course ${id}`;
          out.push({ id, name: name.slice(0, 80), url: new URL(href, location.origin).toString() });
        }
        const dedup = {};
        for (const c of out) dedup[c.id] = c;
        return Object.values(dedup);
      }
    }).then(r => r?.[0]?.result).catch(() => null);

    if (Array.isArray(found) && found.length) {
      const next = {};
      for (const c of found) next[c.id] = { ...c, lastSeen: new Date().toISOString() };
      courses = next;
      await setInStorage({ [STORAGE_KEYS.courses]: courses });
    }
  });

  return courses;
}

function courseAssignmentsUrl(courseId) {
  return `https://www.gradescope.com/courses/${courseId}/assignments`;
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
  if (!scraped || !Array.isArray(scraped.items)) return;

  const assignments = await getFromStorage(STORAGE_KEYS.assignments, {});
  const courses = await getFromStorage(STORAGE_KEYS.courses, {});

  const courseId = scraped.courseId || null;
  const courseName = scraped.courseName || (courseId && courses[courseId]?.name) || null;

  if (courseId) {
    courses[courseId] = courses[courseId] || { id: courseId, name: courseName || `Course ${courseId}`, url: `https://www.gradescope.com/courses/${courseId}` };
    if (courseName) courses[courseId].name = courseName;
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

// --- Refresh one course ---
async function refreshCourse(course, openedUrls) {
  const url = courseAssignmentsUrl(course.id);
  openedUrls.push(url);

  let scraped = null;
  await withTempTab(url, async (tabId) => {
    scraped = await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_ASSIGNMENTS" }).catch(() => null);

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

          const courseId = (location.pathname.match(/\/courses\/(\d+)/)||[])[1] || null;
          const header = document.querySelector("h1, .courseHeader--title, .courseHeader");
          const courseName = text(header) || null;

          const items=[];
          const rows=Array.from(document.querySelectorAll("table tbody tr"));
          for (const r of rows){
            const a=r.querySelector('a[href*="/assignments/"]');
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
          return { courseId, courseName, items };
        }
      }).then(r => r?.[0]?.result).catch(() => null);
    }
  });

  return scraped;
}

async function refreshAll() {
  const openedUrls = [];
  const courses = await ensureCoursesList();
  const list = Object.values(courses);

  // record which course IDs we think exist
  const courseIds = list.map(c => c.id);

  for (const course of list) {
    try {
      const scraped = await refreshCourse(course, openedUrls);
      await mergeScraped(scraped);
    } catch (e) {
      console.warn("refreshCourse failed", course, e);
    }
    await sleep(RATE_LIMIT_MS);
  }

  await setInStorage({
    [STORAGE_KEYS.debug]: {
      lastRefreshAt: nowIso(),
      lastOpenedUrls: openedUrls,
      courseIds,
      notes: "Chrome extensions cannot read true process memory usage; this shows storage size instead."
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
