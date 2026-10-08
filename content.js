// ============================================================
// BAUKO SPX BRIDGE v2.2.1 - page side (BAUKO Dispatch Checker + Rider OnHold Checker <-> service worker)
// Runs ONLY on the BAUKO page (see manifest "matches"), never on SPX.
// ============================================================
(() => {
  if (window.__baukoBridgeV2) return;
  window.__baukoBridgeV2 = true;

  const PAGE_SOURCE = "BAUKO_SPX_BRIDGE";   // extension -> page
  const CHECKER_SOURCE = "BAUKO_CHECKER";    // page -> extension
  const VERSION = "2.2.1";
  const START = ["BAUKO_START_INVENTORY_SYNC", "BAUKO_START_DELIVERING_SYNC", "BAUKO_START_FULL_SYNC", "BAUKO_START_ONHOLD_SYNC", "BAUKO_OPEN_ORDER"];

  let port = null;
  let reconnectTimer = null;
  let retries = 0;
  let shuttingDown = false;
  let pingTimer = null;
  const isInvalidated = (m) => /context invalidated|extension context/i.test(String(m || ""));

  const emit = (type, data = {}) => window.postMessage({ source: PAGE_SOURCE, type, ...data }, "*");

  const scheduleReconnect = () => {
    if (shuttingDown || reconnectTimer) return;
    // back off 0.75s, 1.5s, 3s ... max 5s, so a failing connection never hammers the worker
    const delay = Math.min(5000, 750 * Math.pow(2, Math.min(retries++, 3)));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  };

  function connect() {
    if (shuttingDown || port) return;
    try {
      port = chrome.runtime.connect({ name: "BAUKO_PAGE" });
      port.onMessage.addListener((msg) => {
        if (!msg || !msg.type) return;
        if (msg.type === "BAUKO_BRIDGE_READY") retries = 0;
        emit(msg.type, msg);
      });
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        try { port && port.postMessage({ type: "BAUKO_PING" }); } catch (_) {}
      }, 20000);
      port.onDisconnect.addListener(() => {
        const reason = chrome.runtime.lastError?.message || "Bridge connection closed.";
        port = null;
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        emit("BAUKO_BRIDGE_DISCONNECTED", { message: reason });
        scheduleReconnect();
      });
      emit("BAUKO_BRIDGE_READY", { version: VERSION });
    } catch (error) {
      port = null;
      emit("BAUKO_BRIDGE_DISCONNECTED", {
        message: (error && error.message) || String(error)
      });
      // "Extension context invalidated" cannot recover until the page is refreshed;
      // anything else (worker still starting) is retried.
      if (!isInvalidated(error && error.message)) scheduleReconnect();
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const m = event.data;
    if (!m || m.source !== CHECKER_SOURCE) return;

    if (m.type === "BAUKO_CHECKER_READY") {
      if (port) emit("BAUKO_BRIDGE_READY", { version: VERSION });
      else connect();
      return;
    }

    if (START.includes(m.type) || m.type === "BAUKO_ABORT_SYNC") {
      if (!port) {
        emit("BAUKO_BRIDGE_ERROR", {
          message: "BAUKO SPX Bridge is not connected. Reload the extension, then refresh this page (F5)."
        });
        return;
      }
      try {
        port.postMessage({ type: m.type, date: m.date || null, riderId: m.riderId || null, orderId: m.orderId || null });
      } catch (error) {
        emit("BAUKO_BRIDGE_ERROR", { message: (error && error.message) || String(error) });
      }
    }
  });

  window.addEventListener("beforeunload", () => {
    shuttingDown = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { port && port.disconnect(); } catch (_) {}
  });

  connect();
})();
