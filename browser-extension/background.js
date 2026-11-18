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

async function readBrowserSession() {
  for (const endpoint of MONARCH_GRAPHQL_ENDPOINTS) {
    // getAll({url}) returns exactly the cookies the browser would send to the API,
    // including HttpOnly ones the web page itself can't read.
    const cookies = await chrome.cookies.getAll({ url: endpoint });
    if (cookies.some(c => c.name === 'session_id')) {
      return {
        cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '),
        endpoint,
        user_agent: navigator.userAgent,
        fingerprint: await sha256(
          endpoint + '|' + cookies.filter(c => AUTH_COOKIES.includes(c.name)).map(c => `${c.name}=${c.value}`).sort().join(';')
        ),
      };
    }
  }
  return null;
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

// Attach the live browser session to a host request when there is one.
async function withSession(message) {
  const session = await readBrowserSession();
  if (!session) return message;
  storeBrowserSession(session).catch(() => {});
  const { fingerprint, ...wire } = session;
  return { ...message, session: wire };
}

// Pick up logins automatically: log into Monarch in any tab and the extension is connected.
chrome.cookies.onChanged.addListener(async ({ cookie, removed }) => {
  if (removed || cookie.name !== 'session_id') return;
  if (!/(^|\.)monarch(money)?\.com$/.test(cookie.domain.replace(/^\./, ''))) return;
  const session = await readBrowserSession();
  if (session) storeBrowserSession(session).catch(() => {});
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
  const res = await callNativeHost(await withSession({
    action: 'sync',
    jpy_balance: jpyBalance,
    account_id: accountId || null,
  }));
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
  const saved = await storeBrowserSession(session, { force: true });
  if (!saved || !saved.success) return saved || { success: false, message: 'No response from native host.' };
  return callNativeHost(await withSession({ action: 'get_accounts' }));
}

// ── Message router ────────────────────────────────────────────────────────────

const handlers = {
  getStatus: () => getStatus(),
  connectMonarch: () => connectMonarch(),
  getMonarchAccounts: async () => callNativeHost(await withSession({ action: 'get_accounts' })),
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
