/**
 * sw.js
 * -----
 * Admin-side Service Worker.
 *
 * Listens directly to Firebase Realtime Database from within the Service
 * Worker and fires native Notification API notifications when new support
 * requests or new user messages arrive. Deliberately does NOT use FCM or any
 * third-party push service.
 *
 * IMPORTANT LIMITATION (read this):
 * Browsers can suspend an idle Service Worker that has no Push subscription
 * keeping it alive. This SW will work reliably while it has just been
 * (re)registered and while the RTDB socket is open, but there is no
 * guarantee the browser keeps it resident indefinitely with zero open tabs.
 * For guaranteed delivery, keep the admin dashboard tab open -- it runs its
 * own foreground listener and will also show in-page + Notification alerts.
 * This SW is a best-effort background layer on top of that.
 *
 * Must be served from the site root (or with an appropriate Service-Worker-
 * Allowed header) so its scope covers /admin.html.
 */

importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-auth-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-database-compat.js");
importScripts("/firebase-config.js"); // must set self.FIREBASE_CONFIG

/**
 * The RTDB security rules require `auth != null` (see rtdb.rules.json).
 * This SW can't show an interactive login UI, so instead it relies on
 * Firebase Auth's default IndexedDB persistence: once an admin logs in via
 * admin.html (same origin, same browser), that session is written to
 * IndexedDB and firebase-auth-compat here will pick it up automatically.
 * Until the admin has logged in at least once in this browser, DB reads
 * from this SW will fail permission checks -- that's expected.
 */

const DB_NAME = "live-help-sw-state";
const STORE_NAME = "kv";

let dbReadyPromise = null;
let firebaseApp = null;
let rtdb = null;

function openState() {
  if (dbReadyPromise) {
    return dbReadyPromise;
  }
  dbReadyPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (event) => {
      const idb = event.target.result;
      if (!idb.objectStoreNames.contains(STORE_NAME)) {
        idb.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbReadyPromise;
}

async function getState(key, fallback) {
  const idb = await openState();
  return new Promise((resolve) => {
    const tx = idb.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result === undefined ? fallback : req.result);
    req.onerror = () => resolve(fallback);
  });
}

async function setState(key, value) {
  const idb = await openState();
  return new Promise((resolve) => {
    const tx = idb.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
  });
}

function ensureFirebase() {
  if (rtdb) {
    return rtdb;
  }
  if (!self.FIREBASE_CONFIG) {
    console.error("[live-help sw] FIREBASE_CONFIG missing.");
    return null;
  }
  firebaseApp = firebase.apps.length ? firebase.app() : firebase.initializeApp(self.FIREBASE_CONFIG);
  rtdb = firebaseApp.database();
  return rtdb;
}

async function notifyNewSession(sessionId, userInfo) {
  const title = "New Help Request!";
  const name = userInfo && userInfo.name ? String(userInfo.name) : "A visitor";
  await self.registration.showNotification(title, {
    body: `${name} is requesting support.`,
    icon: "/icon.png",
    tag: `session-${sessionId}`,
    data: { url: `/admin.html?session=${encodeURIComponent(sessionId)}` },
    actions: [{ action: "open_panel", title: "Go to Panel" }]
  });
}

async function notifyNewMessage(sessionId, message) {
  const preview = String(message && message.text ? message.text : "").slice(0, 120);
  await self.registration.showNotification("New message", {
    body: preview || "New message received.",
    icon: "/icon.png",
    tag: `message-${sessionId}`,
    data: { url: `/admin.html?session=${encodeURIComponent(sessionId)}` },
    actions: [{ action: "open_panel", title: "Go to Panel" }]
  });
}

/**
 * Attach a listener to /support_chats for brand new sessions.
 * Uses IndexedDB to remember the newest createdAt we've already notified
 * about, so re-attaching this listener (SW restart) doesn't re-fire
 * notifications for every historical session.
 */
async function watchSessions() {
  const db = ensureFirebase();
  if (!db) {
    return;
  }

  const lastSeenCreatedAt = await getState("lastSeenSessionCreatedAt", 0);
  let maxSeen = lastSeenCreatedAt;

  const sessionsRef = db.ref("support_chats");
  sessionsRef.orderByChild("user_info/createdAt").startAfter(lastSeenCreatedAt).on("child_added", async (snap) => {
    const sessionId = snap.key;
    const data = snap.val() || {};
    const userInfo = data.user_info || {};
    const createdAt = Number(userInfo.createdAt || 0);

    if (createdAt <= lastSeenCreatedAt) {
      return; // already handled before this SW instance started
    }
    if (userInfo.status !== "pending") {
      return;
    }

    await notifyNewSession(sessionId, userInfo);
    watchMessagesForSession(sessionId);

    if (createdAt > maxSeen) {
      maxSeen = createdAt;
      await setState("lastSeenSessionCreatedAt", maxSeen);
    }
  });

  // Also attach message watchers for any sessions that already exist and are
  // still pending/active, so new user messages on existing chats still alert.
  const existingSnap = await sessionsRef.once("value");
  existingSnap.forEach((child) => {
    const status = child.val() && child.val().user_info ? child.val().user_info.status : null;
    if (status === "pending" || status === "active") {
      watchMessagesForSession(child.key);
    }
    return false;
  });
}

const watchedMessageSessions = new Set();

function watchMessagesForSession(sessionId) {
  if (watchedMessageSessions.has(sessionId)) {
    return;
  }
  watchedMessageSessions.add(sessionId);

  const db = ensureFirebase();
  if (!db) {
    return;
  }

  const messagesRef = db.ref(`support_chats/${sessionId}/messages`);
  messagesRef.limitToLast(1).on("child_added", async (snap) => {
    const message = snap.val() || {};
    if (message.sender !== "user") {
      return; // don't notify the admin about their own messages
    }

    const stateKey = `lastSeenMessageTs:${sessionId}`;
    const lastSeenTs = await getState(stateKey, 0);
    const ts = Number(message.timestamp || 0);
    if (ts && ts <= lastSeenTs) {
      return;
    }

    await notifyNewMessage(sessionId, message);
    if (ts) {
      await setState(stateKey, ts);
    }
  });
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await watchSessions();
    })()
  );
});

// Re-arm listeners any time the SW is (re)woken, in case activate already ran
// in a prior lifecycle and this is a fresh script evaluation.
watchSessions();

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const targetUrl = (notification.data && notification.data.url) || "/admin.html";
  notification.close();

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = allClients.find((client) => client.url.includes("/admin.html"));

      if (existing) {
        await existing.focus();
        existing.postMessage({ type: "live-help-navigate", url: targetUrl });
        return;
      }

      await self.clients.openWindow(targetUrl);
    })()
  );
});