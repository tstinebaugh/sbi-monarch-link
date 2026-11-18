// background.js — service worker
//  • Bridge to the Python native host (Keychain + Monarch GraphQL)
//  • Reads the Monarch session your browser already has, so there is nothing to copy-paste
//  • Shared sync + FX logic for the popup and the on-page banner

const NATIVE_HOST = 'com.sbi.monarch.host';

// Monarch moved from monarchmoney.com to monarch.com; support whichever one you're logged into.
const MONARCH_GRAPHQL_ENDPOINTS = [
  'https://api.monarch.com/graphql',
  'https://api.monarchmoney.com/graphql',
];
const MONARCH_LOGIN_URL = 'https://app.monarch.com/login';
const AUTH_COOKIES = ['session_id', 'csrftoken'];
const FX_URL = 'https://open.er-api.com/v6/latest/JPY';
const FX_CACHE_MS = 10 * 60 * 1000;

// ── Native host ───────────────────────────────────────────────────────────────

function callNativeHost(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ── Monarch session from browser cookies ──────────────────────────────────────

// Cookies the browser would send to Monarch's API, per endpoint.
async function apiCookies() {
  const out = [];
  for (const endpoint of MONARCH_GRAPHQL_ENDPOINTS) {
    // getAll({url}) returns exactly the cookies the browser would send to that URL,
    // including HttpOnly ones the web page itself can't read.
    out.push({ endpoint, cookies: await chrome.cookies.getAll({ url: endpoint }) });
  }
  return out;
}

// Cookie names only (never values), for the popup's debug log.
async function cookieReport() {
  const parts = [];
  for (const { endpoint, cookies } of await apiCookies()) {
    const counts = {};
    for (const c of cookies) counts[c.name] = (counts[c.name] || 0) + 1;
    const names = Object.entries(counts).map(([n, k]) => (k > 1 ? `${n}×${k}` : n)).join(', ');
    parts.push(`${new URL(endpoint).host}: ${names || 'no cookies'}`);
  }
  return parts.join(' | ');
}

// Every distinct Monarch session the browser holds, best guess first. Usually there is
// exactly one; an old session_id left on the legacy domain or a parent domain is why
// we try candidates instead of trusting the first cookie we see.
async function browserSessionCandidates() {
  const candidates = [];
  const seen = new Set();
  for (const { endpoint, cookies } of await apiCookies()) {
    const sessions = cookies.filter(c => c.name === 'session_id');
    // Host-only and more specific cookies first, then the ones that live longest.
    sessions.sort((a, b) => (b.hostOnly - a.hostOnly) || (b.domain.length - a.domain.length) ||
                            ((b.expirationDate || 0) - (a.expirationDate || 0)));
    for (const sess of sessions) {
      if (seen.has(sess.value)) continue;
      seen.add(sess.value);
      // One cookie per name: the chosen session_id plus the most specific of everything else.
      const byName = new Map([['session_id', sess]]);
      for (const c of cookies) {
        const prev = byName.get(c.name);
        if (!prev || (c.name !== 'session_id' && c.domain.length > prev.domain.length)) byName.set(c.name, c);
      }
      const jar = [...byName.values()];
      candidates.push({
        cookie: jar.map(c => `${c.name}=${c.value}`).join('; '),
        endpoint,
        user_agent: navigator.userAgent,
        fingerprint: await sha256(jar.filter(c => AUTH_COOKIES.includes(c.name)).map(c => `${c.name}=${c.value}`).sort().join(';')),
      });
    }
  }
  // Put the session that worked last time first.
  const { goodFingerprint } = await chrome.storage.session.get('goodFingerprint');
  candidates.sort((a, b) => (b.fingerprint === goodFingerprint) - (a.fingerprint === goodFingerprint));
  return candidates;
}

async function readBrowserSession() {
  return (await browserSessionCandidates())[0] || null;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Persist the browser session to the Keychain (used by the CLI and as a fallback when
// you're logged out in the browser). Only writes when the auth cookies actually change.
async function storeBrowserSession(session, { force = false } = {}) {
  const { storedFingerprint } = await chrome.storage.session.get('storedFingerprint');
  if (!force && storedFingerprint === session.fingerprint) return { success: true, unchanged: true };
  const res = await callNativeHost({
    action: 'save_token',
    token: session.cookie,
    user_agent: session.user_agent,
    endpoint: session.endpoint,
  });
  if (res && res.success) {
    await chrome.storage.session.set({ storedFingerprint: session.fingerprint });
    await chrome.storage.local.set({ monarchConnectedAt: Date.now() });
  }
  return res;
}

// Run a host request with the browser's Monarch session, trying each candidate session
// until Monarch accepts one. Falls back to the Keychain copy when the browser has none.
async function callWithSession(message) {
  const candidates = await browserSessionCandidates();
  if (!candidates.length) return callNativeHost(message);
  let res;
  for (const session of candidates) {
    const { fingerprint, ...wire } = session;
    res = await callNativeHost({ ...message, session: wire });
    if (!(res && res.error === 'token_expired')) {
      if (res && res.success) {
        await chrome.storage.session.set({ goodFingerprint: fingerprint });
        storeBrowserSession(session).catch(() => {});
      }
      return res;
    }
  }
  if (res && candidates.length > 1) res.message += ` (tried ${candidates.length} browser sessions)`;
  return res;
}

// Pick up logins automatically: log into Monarch in any tab and the extension is connected.
chrome.cookies.onChanged.addListener(async ({ cookie, removed }) => {
  if (removed || cookie.name !== 'session_id') return;
  if (!/(^|\.)monarch(money)?\.com$/.test(cookie.domain.replace(/^\./, ''))) return;
  // A fresh login: verify it and store it once Monarch accepts it.
  callWithSession({ action: 'get_accounts' }).catch(() => {});
});

// ── FX rate ───────────────────────────────────────────────────────────────────

async function getFxRate() {
  const { fx } = await chrome.storage.session.get('fx');
  if (fx && Date.now() - fx.fetchedAt < FX_CACHE_MS) return fx;
  const data = await fetch(FX_URL).then(r => r.json());
  const rate = data && data.rates && data.rates.USD;
  if (!rate) throw new Error('No USD rate in exchange-rate response');
  const fresh = { rate, fetchedAt: Date.now(), source: 'open.er-api.com' };
  await chrome.storage.session.set({ fx: fresh });
  return fresh;
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function syncBalance(jpyBalance, accountId) {
  const res = await callWithSession({
    action: 'sync',
    jpy_balance: jpyBalance,
    account_id: accountId || null,
  });
  if (res && res.success) {
    await chrome.storage.local.set({
      monarchAccountId: res.account_id,
      lastSync: {
        at: Date.now(),
        jpy: res.jpy_balance,
        usd: res.usd_balance,
        rate: res.rate,
        accountName: res.account_name,
      },
    });
  }
  return res;
}

async function getStatus() {
  const browserSession = await readBrowserSession();
  let host;
  try {
    host = await callNativeHost({ action: 'ping' });
  } catch (err) {
    host = { success: false, message: err.message };
  }
  return {
    success: true,
    cookieReport: await cookieReport().catch(e => `unavailable: ${e.message}`),
    extensionId: chrome.runtime.id,
    hostInstalled: !!(host && host.success),
    hostMessage: host && host.message,
    hostVersion: host && host.host_version,
    browserLoggedIn: !!browserSession,
    hasStoredSession: !!(host && host.has_session),
  };
}

async function connectMonarch() {
  const session = await readBrowserSession();
  if (!session) {
    await chrome.tabs.create({ url: MONARCH_LOGIN_URL });
    return { success: false, error: 'needs_browser_login',
             message: 'Log into Monarch in the tab that just opened. The extension connects automatically.' };
  }
  // Only store a session after Monarch has accepted it (callWithSession does that).
  const res = await callWithSession({ action: 'get_accounts' });
  if (res && !res.success) res.cookieReport = await cookieReport();
  return res;
}

// ── Message router ────────────────────────────────────────────────────────────

const handlers = {
  getStatus: () => getStatus(),
  connectMonarch: () => connectMonarch(),
  getMonarchAccounts: () => callWithSession({ action: 'get_accounts' }),
  saveMonarchToken: (req) => callNativeHost({ action: 'save_token', token: req.token }),
  getFxRate: async () => ({ success: true, ...(await getFxRate()) }),
  syncToMonarch: (req) => syncBalance(req.jpy_balance, req.account_id),
  syncBalanceFromBanner: async (req) => {
    const { monarchAccountId } = await chrome.storage.local.get('monarchAccountId');
    return syncBalance(req.jpyBalance, monarchAccountId);
  },
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handler = handlers[request.action];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(request))
    .then(res => sendResponse(res || { success: false, message: 'No response from native host.' }))
    .catch(err => sendResponse({ success: false, error: 'native_error', message: err.message }));
  return true;
});
