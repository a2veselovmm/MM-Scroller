/**
 * Firebase Auth (Google / Gmail SSO) — optional until firebase-config.json is present.
 */

let auth = null;
let initPromise = null;

async function loadConfig() {
  if (typeof window !== "undefined" && window.__FIREBASE_CONFIG__) {
    return window.__FIREBASE_CONFIG__;
  }
  try {
    const res = await fetch("/firebase-config.json", { cache: "no-store" });
    if (res.ok) return res.json();
  } catch {
    /* not configured */
  }
  return null;
}

export async function initAuth() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const config = await loadConfig();
    if (!config?.apiKey) {
      return { enabled: false, user: null };
    }
    const { initializeApp } = await import(
      "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js"
    );
    const { getAuth, onAuthStateChanged, GoogleAuthProvider } = await import(
      "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js"
    );
    const app = initializeApp(config);
    auth = getAuth(app);
    return new Promise((resolve) => {
      onAuthStateChanged(auth, (user) => {
        resolve({ enabled: true, user, provider: GoogleAuthProvider });
      });
    });
  })();
  return initPromise;
}

export async function signInWithGoogle() {
  const state = await initAuth();
  if (!state.enabled) {
    throw new Error("Firebase Auth is not configured. Add firebase-config.json.");
  }
  const { signInWithPopup } = await import(
    "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js"
  );
  const provider = new state.provider();
  provider.setCustomParameters({ prompt: "select_account" });
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOut() {
  if (!auth) return;
  const { signOut: fbSignOut } = await import(
    "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js"
  );
  await fbSignOut(auth);
}

export async function getIdToken() {
  if (!auth?.currentUser) return null;
  return auth.currentUser.getIdToken();
}

export function getCurrentUser() {
  return auth?.currentUser || null;
}
