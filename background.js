// ============================================================
// BAUKO SPX BRIDGE v2.4.0 - service worker (Dispatch Checker + Rider OnHold Checker)
// Same pipeline SPX's own Export button uses (and the BADOC bridge copies):
//   1) POST export request  -> task_id
//   2) poll list_for_portal -> export_status 2 (done)
//   3) get_signed_download_url -> download CSV
//   4) send the CSV text to the BAUKO page
// The fetches run here in the service worker; host_permissions attach your SPX
// login cookies. No SPX tab, no page hooks, no request-signing tricks.
// ============================================================

const SPX_ORIGIN = "https://spx.shopee.ph";
// No fixed station: SPX scopes every export to the station of the logged-in SPX account.
// The station is read from the finished export task and reported to the page (stationId).
const VERSION = "2.4.0";

const EXPORT_PATH = "/api/admin/tracking/am_hub/forward/export";
const TASK_LIST_PATH = "/spxdata/api/export_platform/export_task/list_for_portal";
const SIGNED_URL_PATH = "/spxdata/api/export_platform/export_task/get_signed_download_url";
const EXPORT_NAME = "export_forward_order";
const BIZ_NAME = "fleet_order";

const POLL_MS = 3000;
const MAX_WAIT_MS = 25 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30000;
const LOOKBACK_DAYS = 14;                // Created Date window, same as the SPX UI default
const PH_OFFSET_SEC = 8 * 3600;          // Asia/Manila, no DST

// Request shapes captured from SPX Order Tracking -> Export.
const JOBS = {
  inventory: {
    label: "Inventory",
    ids: [50, 49, 1],
    names: ["LMHub_Assigned", "LMHub_Assigning", "LMHub_Received"],
    outType: "BAUKO_INVENTORY_DATA"
  },
  delivering: {
    label: "Delivering",
    ids: [2],
    names: ["Delivering"],
    outType: "BAUKO_DELIVERING_DATA"
  },
  // Rider OnHold Checker: Status Log = OnHold (tracking_status 5), Created Date window only.
  onhold: {
    label: "OnHold",
    ids: [5],
    names: ["OnHold"],
    outType: "BAUKO_ONHOLD_DATA"
  }
};

// One entry per connected BAUKO page (Dispatch Checker, OnHold Checker, ...).
// Older versions kept a SINGLE port and disconnected the previous one whenever a new page
// connected, so two open pages kicked each other out forever ("Bridge connection closed" / "Reconnecting...").
const ports = new Set();         // every live page port
const jobs = new Map();          // tabKey -> running sync { startedAt, cancelled, tabKey }
let portSeq = 0;

// ---------- reuse one SPX order tab ----------
// Clicking an Order ID in the checker sends it here. If an SPX order-detail tab is already
// open we point it at the new order and focus it; otherwise we open one (later clicks reuse it).
const ORDER_RE = /^[A-Za-z0-9_-]{4,64}$/;
const RELOAD_ON_SWITCH = true;   // force a fresh load when only the #/orderDetail/<id> part changes
async function openOrder(orderId, run) {
  if (!ORDER_RE.test(orderId)) { sendToPage("BAUKO_BRIDGE_ERROR", { message: "Invalid Order ID: " + orderId }, run); return; }
  const url = SPX_ORIGIN + "/#/orderDetail/" + encodeURIComponent(orderId) + "/proof_of_onhold";
  try {
    const tabs = await chrome.tabs.query({ url: SPX_ORIGIN + "/*" });
    const viewers = tabs.filter((t) => /#\/orderDetail\//.test(t.url || ""));
    viewers.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const tab = viewers[0];
    if (tab) {
      const same = (tab.url || "") === url;
      await chrome.tabs.update(tab.id, { url, active: true });
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
      if (RELOAD_ON_SWITCH || same) { await sleep(150); try { await chrome.tabs.reload(tab.id); } catch (_) {} }
    } else {
      await chrome.tabs.create({ url, active: true });
    }
    sendToPage("BAUKO_ORDER_OPENED", { orderId }, run);
  } catch (e) {
    sendToPage("BAUKO_BRIDGE_ERROR", { message: "Could not open the SPX tab: " + ((e && e.message) || e) }, run);
  }
}
let keepAliveTimer = null;

// MV3 service workers are stopped by Chrome after ~30s without extension activity,
// and fetch()/setTimeout waits do not count. While a sync runs, ping an extension API
// and push a message down the port every 20s so the worker (and the port) stay alive.
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; }); } catch (_) {}
    sendToPage("BAUKO_BRIDGE_PING", { t: Date.now() });
  }, 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// run given -> only the page (tab) that started it; no run -> every connected page.
function sendToPage(type, data = {}, run = null) {
  let sent = false;
  for (const p of Array.from(ports)) {
    if (run && p.__tabKey !== run.tabKey) continue;
    try { p.postMessage({ type, ...data }); sent = true; } catch (_) { ports.delete(p); }
  }
  return sent;
}
const progress = (message, run = null) => sendToPage("BAUKO_BRIDGE_PROGRESS", { message }, run);

// ---------- dates (Philippine calendar) ----------
function todayManila() {
  return new Date(Date.now() + PH_OFFSET_SEC * 1000).toISOString().slice(0, 10);
}
function dayStartSec(date) {
  return Math.floor(Date.parse(date + "T00:00:00Z") / 1000) - PH_OFFSET_SEC;
}
function shiftDate(date, days) {
  const d = new Date(Date.parse(date + "T00:00:00Z"));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- export request bodies ----------
function buildBody(kind, date, stationId) {
  const job = JOBS[kind];
  const start = dayStartSec(date);
  const endSec = start + 86400 - 1;                     // 23:59:59 of the dispatch date
  const fromDate = shiftDate(date, -LOOKBACK_DAYS);
  const fromSec = start - LOOKBACK_DAYS * 86400;

  const body = {
    tracking_status: job.ids.join(","),
    bulky_type: "1,0,2",
    ctime: fromSec + "," + endSec
  };
  if (stationId) body.current_station_ids = [stationId];   // blank = SPX uses the logged-in account's own station
  let assigned = "";
  if (kind === "delivering") {
    body.pick_up_time = start + "," + endSec;           // Assigned Time = dispatch date
    assigned = "Assigned Time= " + date + " 00:00:00," + date + " 23:59:59; ";
  }
  body.format_condition =
    "Status Log= " + job.names.join(",") + "; " +
    "Bulky Type= Bulky,N/A,Non-Bulky; " +
    "Created Date= " + fromDate + " 00:00:00," + date + " 23:59:59; " +
    assigned + "Driver= All";
  return body;
}

// ---------- network helpers ----------
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out after " + Math.round(ms / 1000) + " seconds.")), ms);
      })
    ]);
  } finally { clearTimeout(timer); }
}

async function spxFetch(url, init = {}) {
  const response = await withTimeout(
    fetch(url, {
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      ...init,
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        ...(init.headers || {})
      }
    }),
    FETCH_TIMEOUT_MS,
    "SPX request"
  );
  const text = await response.text();
  return { status: response.status, ok: response.ok, contentType: response.headers.get("content-type") || "", text };
}

function parseJson(label, response) {
  const raw = String(response.text || "");
  try { return JSON.parse(raw); } catch (_) {
    const preview = raw.replace(/\s+/g, " ").slice(0, 200);
    if (/<!doctype|<html/i.test(preview)) {
      throw new Error(label + ": SPX returned the web page instead of JSON (HTTP " + response.status + "). Log in to SPX and try again.");
    }
    throw new Error(label + ": SPX returned non-JSON data (HTTP " + response.status + ").");
  }
}

async function submitExport(kind, date, run) {
  const job = JOBS[kind];
  const body = buildBody(kind, date, run.stationId);
  progress(job.label + ": submitting SPX export for " + date + "...", run);
  const res = await spxFetch(SPX_ORIGIN + EXPORT_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = parseJson(job.label + " export", res);
  if (!res.ok || Number(json && json.retcode) !== 0) {
    throw new Error((json && json.message) || (job.label + " export request failed (HTTP " + res.status + ")."));
  }
  const taskId = Number((json.data && json.data.task_id) || json.task_id || 0);
  if (!taskId) throw new Error(job.label + ": SPX accepted the export but returned no task ID.");
  progress(job.label + ": export task " + taskId + " created.", run);
  return taskId;
}

async function listTasks(startSec) {
  const url = SPX_ORIGIN + TASK_LIST_PATH + "?start_time=" + encodeURIComponent(startSec) + "&count=100&pageno=1";
  const res = await spxFetch(url);
  const json = parseJson("SPX export task list", res);
  if (Number(json && json.retcode) !== 0) throw new Error((json && json.message) || "SPX task list request failed.");
  return Array.isArray(json && json.data && json.data.task_list) ? json.data.task_list : [];
}

async function waitForCompletion(taskId, startSec, run, label) {
  const deadline = Date.now() + MAX_WAIT_MS;
  let lastStatus = null, lastQueue = null, lastAt = 0;
  while (Date.now() < deadline) {
    if (run.cancelled) throw new Error("Sync cancelled.");
    const tasks = await listTasks(startSec);
    const task = tasks.find((t) => Number(t && t.task_id || 0) === taskId);
    if (task) {
      const status = Number(task.export_status ?? -1);
      const queue = String(task.queue_position || "");
      if (status === 2) return task;
      if (status === 3 || task.failed_reason) throw new Error(task.failed_reason || "SPX export failed.");
      const now = Date.now();
      if (status !== lastStatus || queue !== lastQueue || now - lastAt >= 10000) {
        const el = Math.floor((now - run.startedAt) / 1000);
        progress(label + ": export processing" + (queue ? " (queue " + queue + ")" : "") + " - " +
          String(Math.floor(el / 60)).padStart(2, "0") + ":" + String(el % 60).padStart(2, "0"), run);
        lastStatus = status; lastQueue = queue; lastAt = now;
      }
    }
    await sleep(POLL_MS);
  }
  throw new Error(label + ": SPX export still queued after 25 minutes.");
}

async function getSignedDownloadUrl(taskId) {
  const url = SPX_ORIGIN + SIGNED_URL_PATH + "?source=fms&task_id=" + encodeURIComponent(taskId);
  const res = await spxFetch(url);
  const json = parseJson("SPX signed download URL", res);
  if (Number(json && json.retcode) !== 0) throw new Error((json && json.message) || "SPX did not return a signed download URL.");
  const signed = String((json.data && json.data.download_url) || "");
  if (!signed) throw new Error("SPX returned no signed download URL.");
  return signed;
}

function fileNameFromSignedUrl(signedUrl, fallback) {
  try {
    const u = new URL(signedUrl);
    const disp = u.searchParams.get("response-content-disposition") || "";
    const m = disp.match(/filename(?:\*)?=(?:UTF-8''|"?)([^;\r\n"]+)/i);
    if (m && m[1]) return decodeURIComponent(m[1].trim());
  } catch (_) {}
  return fallback;
}

async function downloadCsv(signedUrl, fallbackName) {
  let res;
  try {
    res = await spxFetch(signedUrl, { headers: { "Accept": "text/csv,text/plain,*/*" } });
  } catch (e) {
    throw new Error("CSV download blocked (" + ((e && e.message) || e) + "). Check the susercontent.com host permissions in manifest.json.");
  }
  if (!res.ok) throw new Error("CSV download failed (HTTP " + res.status + ").");
  const text = String(res.text || "").replace(/^\uFEFF/, "");
  if (!text.trim()) throw new Error("SPX returned an empty CSV file.");
  return { text, fileName: fileNameFromSignedUrl(signedUrl, fallbackName) };
}

// ---------- task validation ----------
function setsEqual(a, b) {
  const x = new Set(a.map(String)), y = new Set(b.map(String));
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
}
function parseCondition(task) {
  const raw = task && task.condition;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch (_) { return {}; }
}
// returns "" when OK, otherwise a human-readable reason
function checkTask(task, kind, expectedStation) {
  if (String(task.export_name || "") !== EXPORT_NAME || String(task.biz_name || "") !== BIZ_NAME) {
    return "export type is " + (task.export_name || "?") + "/" + (task.biz_name || "?");
  }
  // The export was requested for one station. If SPX echoes the station filter back, it must match.
  if (expectedStation) {
    const cond = parseCondition(task);
    const echoed = Array.isArray(cond.current_station_ids) ? cond.current_station_ids.map(Number) : null;
    if (echoed && echoed.length && !echoed.includes(expectedStation)) {
      return "export is for station " + echoed.join(",") + ", not the requested station " + expectedStation + ".";
    }
  }
  const ts = String(parseCondition(task).tracking_status || "");
  if (!ts || !setsEqual(ts.split(",").map((s) => s.trim()).filter(Boolean), JOBS[kind].ids)) {
    return "status filter is '" + ts + "', expected '" + JOBS[kind].ids.join(",") + "'";
  }
  return "";
}

// ---------- one export, start to finish ----------
async function runPipeline(kind, date, riderId, run) {
  const job = JOBS[kind];
  const taskId = await submitExport(kind, date, run);
  const waitStartSec = Math.max(0, Math.floor((run.startedAt - 10 * 60 * 1000) / 1000));
  const task = await waitForCompletion(taskId, waitStartSec, run, job.label);
  const why = checkTask(task, kind, run.expectedStation);
  if (why) throw new Error(job.label + ": the finished SPX task is not the expected export - " + why);

  const stationId = run.stationId || null;
  progress(job.label + ": export ready" + (stationId ? " (station " + stationId + ")" : " (account default station)") + ", downloading CSV...", run);
  const signed = await getSignedDownloadUrl(taskId);
  const csv = await downloadCsv(signed, "bauko_" + kind + ".csv");
  const rowCount = Math.max(0, csv.text.split(/\r?\n/).filter(Boolean).length - 1);
  progress(job.label + ": downloaded " + rowCount.toLocaleString() + " rows. Sending to BAUKO...", run);
  sendToPage(job.outType, { date, riderId: riderId || null, stationId, taskId, fileName: csv.fileName, rowCount, csvText: csv.text }, run);
}

async function runSync(run, kinds, date, riderId) {
  try {
    startKeepAlive();
    run.startedAt = Date.now();
    const results = await Promise.allSettled(kinds.map((k) => runPipeline(k, date, riderId, run)));
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error("[BAUKO BRIDGE]", kinds[i], r.reason);
        sendToPage("BAUKO_BRIDGE_ERROR", { kind: kinds[i], message: String((r.reason && r.reason.message) || r.reason) }, run);
      }
    });
  } finally {
    if (jobs.get(run.tabKey) === run) jobs.delete(run.tabKey);
    if (jobs.size === 0) stopKeepAlive();
  }
}

// ---------- page connection ----------
function isBaukoPage(url) {
  const u = String(url || "");
  return /^file:/i.test(u) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(u) ||
    /^https:\/\/xenerycenery1-pixel\.github\.io(?:[/:]|$)/i.test(u);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "BAUKO_PAGE") return;
  const from = String((port.sender && (port.sender.url || port.sender.origin)) || "");
  if (!isBaukoPage(from)) {
    console.warn("[BAUKO BRIDGE] rejected origin:", from);
    try { port.disconnect(); } catch (_) {}
    return;
  }

  // One key per browser tab; reconnects of the same tab keep the key, so a running sync keeps reporting to it.
  const tab = port.sender && port.sender.tab;
  const tabKey = tab && tab.id != null ? "tab" + tab.id : "p" + (++portSeq);
  port.__tabKey = tabKey;

  // Only replace an OLD port of the SAME tab. Other pages keep their own connection.
  for (const old of Array.from(ports)) {
    if (old.__tabKey === tabKey) { ports.delete(old); try { old.disconnect(); } catch (_) {} }
  }
  ports.add(port);
  try { port.postMessage({ type: "BAUKO_BRIDGE_READY", version: VERSION, running: jobs.has(tabKey) }); } catch (_) {}

  port.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "BAUKO_PING") return;
    if (msg.type === "BAUKO_OPEN_ORDER") { void openOrder(String(msg.orderId || ""), { tabKey }); return; }
    if (msg.type === "BAUKO_ABORT_SYNC") { const j = jobs.get(tabKey); if (j) j.cancelled = true; return; }

    const kinds =
      msg.type === "BAUKO_START_INVENTORY_SYNC" ? ["inventory"] :
      msg.type === "BAUKO_START_DELIVERING_SYNC" ? ["delivering"] :
      msg.type === "BAUKO_START_ONHOLD_SYNC" ? ["onhold"] :
      msg.type === "BAUKO_START_FULL_SYNC" ? ["inventory", "delivering"] : null;
    if (!kinds) return;

    if (jobs.has(tabKey)) {
      sendToPage("BAUKO_BRIDGE_ERROR", { message: "A BAUKO SPX sync is already running on this page." }, { tabKey });
      return;
    }
    const date = ISO.test(msg.date || "") ? msg.date : todayManila();
    let stationId = null;
    if (msg.stationId !== null && msg.stationId !== undefined && String(msg.stationId).trim() !== "") {
      stationId = Number(msg.stationId);
      if (!Number.isInteger(stationId) || stationId <= 0) {
        sendToPage("BAUKO_BRIDGE_ERROR", { message: "Invalid Station ID: " + msg.stationId }, { tabKey });
        return;
      }
    }
    const run = { startedAt: 0, cancelled: false, tabKey, stationId, expectedStation: stationId };
    jobs.set(tabKey, run);
    progress("Starting " + kinds.join(" + ") + " sync for " + date + (stationId ? " (station " + stationId + ")" : "") + "...", run);
    void runSync(run, kinds, date, msg.riderId || null);
  });

  port.onDisconnect.addListener(() => { ports.delete(port); void chrome.runtime.lastError; });
});

chrome.runtime.onInstalled.addListener(() => console.log("[BAUKO BRIDGE] v" + VERSION + " installed"));
