// content.js — SBI Shinsei balance detection + floating sync banner

let lastDetectedBalance = null;
let exchangeRateUSD = null;
let pickerActive = false;
let cachedCustomSelector = null;

// Pre-load custom selector from storage
chrome.storage.local.get(['customSBISelector'], (items) => {
  if (items.customSBISelector) {
    cachedCustomSelector = items.customSBISelector;
  }
});

const IS_TOP_FRAME = window === window.top;

// Fetch exchange rate via the service worker (avoids the bank page's CSP / CORS rules)
function getFXRate() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'getFxRate' }, (res) => {
        resolve(!chrome.runtime.lastError && res && res.success ? res.rate : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// Generate a unique CSS selector path for any DOM element
function getUniqueCssSelector(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;

  const path = [];
  while (el && el.nodeType === Node.ELEMENT_NODE) {
    let selector = el.nodeName.toLowerCase();
    if (el.id) {
      selector += `#${CSS.escape(el.id)}`;
      path.unshift(selector);
      break;
    } else {
      let sib = el, nth = 1;
      while (sib = sib.previousElementSibling) {
        if (sib.nodeName.toLowerCase() === selector) nth++;
      }
      if (nth !== 1) selector += `:nth-of-type(${nth})`;
    }
    path.unshift(selector);
    el = el.parentNode;
  }
  return path.join(' > ');
}

// DOM scanner with priority Angular & SBI topMain selectors
// Detection runs in tiers from most to least specific and stops at the first tier
// that finds a value. Taking the max across *all* tiers would let an unrelated large
// number (a transfer limit, an account number) win over the balance the user picked.
function parseSBIBalance() {
  // 1. Element the user picked with the element picker always wins
  if (cachedCustomSelector) {
    try {
      const el = document.querySelector(cachedCustomSelector);
      if (el) {
        const num = extractYenNumber(el.innerText || el.value);
        if (num && num > 0) return num;
      }
    } catch (e) {}
  }

  let candidates = [];

  // 2. Specific SBI Shinsei Angular & ID / Class selectors
  const prioritySelectors = [
    'main#topMain span.ng-binding',
    'main#topMain td span',
    'main#topMain section table td',
    '#totalBalance',
    '.total-balance',
    '.balance-amount',
    '.account-balance-sum',
    '.yen-deposit-total',
    '[data-test="total-balance"]',
    '.p-account-summary__total-amount',
    '.total-asset-val',
    '#asset_total',
    '.asset-total'
  ];

  for (const selector of prioritySelectors) {
    const els = document.querySelectorAll(selector);
    for (const el of els) {
      const text = el.innerText || el.value || '';
      if (text.includes('Total') || text.includes('JPY') || text.includes('円') || text.includes('¥')) {
        const num = extractYenNumber(text);
        if (num && num > 0) candidates.push(num);
      }
    }
  }
  if (candidates.length) return Math.max(...candidates);

  // 3. Search key Japanese & English balance labels on targeted elements
  const keywords = ['Total', '総資産', '評価額', '資産合計', '円預金', '普通預金', '預金合計', '残高合計', 'Balance'];
  const targets = document.querySelectorAll('main#topMain span, main#topMain td, td, th, h2, h3, dt, dd, span[class*="ng-binding"]');
  
  for (const el of targets) {
    const text = el.innerText || '';
    if (!text) continue;
    for (const kw of keywords) {
      if (text.includes(kw)) {
        const num = extractYenNumber(text);
        if (num && num > 0) candidates.push(num);
        break;
      }
    }
  }
  if (candidates.length) return Math.max(...candidates);

  // 4. Global Currency Regex Fallback
  const bodyText = document.body.innerText || '';
  const currencyRegexes = [
    /Total\s*([0-9,]{4,15})/gi,
    /([0-9,]{4,15})\s*JPY/gi,
    /(?:¥|￥)\s*([0-9,]{4,15})/g,
    /([0-9,]{4,15})\s*円/g
  ];

  for (const reg of currencyRegexes) {
    let match;
    while ((match = reg.exec(bodyText)) !== null) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(val) && val >= 100) {
        candidates.push(val);
      }
    }
  }

  return candidates.length ? Math.max(...candidates) : null;
}

function extractYenNumber(str) {
  if (!str) return null;
  const matches = str.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,12})/g);
  if (matches) {
    for (const m of matches) {
      const val = parseFloat(m.replace(/,/g, ''));
      if (!isNaN(val) && val >= 100) return val;
    }
  }
  return null;
}

// ── Floating banner ───────────────────────────────────────────────────────────
// Rendered inside a closed Shadow DOM so the bank's stylesheets can't restyle it (and
// ours can't leak into the bank page). All dynamic text is set via textContent.

const BANNER_CSS = `
  :host { all: initial; }
  .card {
    --bg: #ffffff; --text: #111827; --muted: #6b7280; --border: #e3e6ef;
    --accent: #4f46e5; --accent-hover: #4338ca; --on-accent: #fff;
    --success: #15803d; --success-soft: #dcfce7; --danger: #b91c1c; --soft: #f1f3f9;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--text); background: var(--bg);
    border: 1px solid var(--border); border-radius: 14px;
    box-shadow: 0 12px 32px -8px rgba(15, 23, 42, .35);
    padding: 12px 14px; width: 260px;
    animation: in .18s ease-out;
  }
  @media (prefers-color-scheme: dark) {
    .card {
      --bg: #131a2e; --text: #e5e7eb; --muted: #94a3b8; --border: #263049;
      --accent: #818cf8; --accent-hover: #a5b4fc; --on-accent: #0b1020;
      --success: #4ade80; --success-soft: #0f2e1d; --danger: #f87171; --soft: #1a2238;
    }
  }
  @keyframes in { from { opacity: 0; transform: translateY(6px); } }
  .top { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
  .brand { flex: 1; display: flex; align-items: center; gap: 7px; font-weight: 650; font-size: 12px; color: var(--muted); }
  .brand svg { width: 18px; height: 18px; }
  button { font: inherit; cursor: pointer; }
  .icon {
    border: none; background: none; color: var(--muted); padding: 2px 5px; border-radius: 6px; font-size: 13px;
  }
  .icon:hover { background: var(--soft); color: var(--text); }
  .jpy { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .usd { font-size: 22px; font-weight: 650; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
  .sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .sub.ok { color: var(--success); }
  .sub.err { color: var(--danger); }
  .actions { display: flex; gap: 6px; margin-top: 10px; }
  .btn {
    flex: 1; border: none; border-radius: 9px; padding: 8px 10px; font-weight: 600;
    background: var(--accent); color: var(--on-accent);
  }
  .btn:hover:not(:disabled) { background: var(--accent-hover); }
  .btn:disabled { opacity: .55; cursor: default; }
  .btn.secondary { background: var(--soft); color: var(--text); }
  .btn.done, .btn.done:disabled { opacity: 1; background: var(--success-soft); color: var(--success); }
`;

const LOGO_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#14b8a6"/></linearGradient></defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <path d="M18 34h22m-7-8 8 8-8 8" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="47" cy="34" r="5" fill="#fff"/></svg>`;

let bannerRoot = null;
let bannerDismissed = false;
let bannerView = { state: 'detecting' };

function ensureBanner() {
  if (bannerDismissed) return null;
  if (bannerRoot && bannerRoot.host.isConnected) return bannerRoot;
  const host = document.createElement('div');
  host.id = 'sbi-monarch-banner';
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483646;';
  bannerRoot = host.attachShadow({ mode: 'closed' });
  bannerRoot.innerHTML = `<style>${BANNER_CSS}</style>
    <div class="card" role="region" aria-label="SBI to Monarch sync">
      <div class="top">
        <span class="brand">${LOGO_SVG}SBI → Monarch</span>
        <button class="icon" data-act="pick" title="Pick the balance on the page" aria-label="Pick the balance on the page">🎯</button>
        <button class="icon" data-act="close" title="Hide" aria-label="Hide">✕</button>
      </div>
      <div class="content"></div>
      <div class="actions"></div>
    </div>`;
  bannerRoot.addEventListener('click', onBannerClick);
  document.body.appendChild(host);
  return bannerRoot;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, act, { secondary = false, disabled = false, done = false } = {}) {
  const b = el('button', 'btn' + (secondary ? ' secondary' : '') + (done ? ' done' : ''), label);
  b.dataset.act = act;
  b.disabled = disabled;
  return b;
}

const fmtUSD = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

async function renderBanner(view) {
  bannerView = { ...bannerView, ...view };
  const root = ensureBanner();
  if (!root) return;
  const v = bannerView;
  const content = root.querySelector('.content');
  const actions = root.querySelector('.actions');
  content.replaceChildren();
  actions.replaceChildren();

  if (v.state === 'detecting') {
    content.append(
      el('div', 'usd', 'Balance not found'),
      el('div', 'sub' + (v.message ? ' err' : ''), v.message || 'Open your account summary, or pick the balance on the page.')
    );
    actions.append(button('Scan again', 'scan', { secondary: true }), button('Pick balance', 'pick'));
    return;
  }

  if (!exchangeRateUSD) exchangeRateUSD = await getFXRate();
  const usd = exchangeRateUSD ? v.jpy * exchangeRateUSD : null;
  content.append(
    el('div', 'jpy', `¥${v.jpy.toLocaleString('en-US')}`),
    el('div', 'usd', usd == null ? '—' : fmtUSD(usd))
  );

  const { lastSync } = await chrome.storage.local.get('lastSync');
  let sub;
  if (v.state === 'synced') sub = el('div', 'sub ok', `✓ Updated ${v.accountName || 'Monarch'}`);
  else if (v.state === 'error') sub = el('div', 'sub err', v.message);
  else if (lastSync && lastSync.jpy === v.jpy) sub = el('div', 'sub ok', `Up to date · synced ${timeAgo(lastSync.at)}`);
  else if (lastSync) sub = el('div', 'sub', `Last synced ${timeAgo(lastSync.at)}`);
  if (sub) content.append(sub);

  const label = { syncing: 'Syncing…', synced: '✓ Synced', error: 'Try again' }[v.state] || 'Sync now';
  actions.append(button(label, 'sync', { disabled: v.state === 'syncing' || v.state === 'synced', done: v.state === 'synced' }));
}

function onBannerClick(e) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') {
    bannerDismissed = true;
    bannerRoot.host.remove();
  } else if (act === 'pick') {
    enableElementPicker();
  } else if (act === 'scan') {
    runScanOnce();
  } else if (act === 'sync') {
    syncFromBanner();
  }
}

const SETUP_ERRORS = new Set(['not_logged_in', 'token_expired', 'no_account_selected', 'native_error']);

function syncFromBanner() {
  const jpy = bannerView.jpy;
  renderBanner({ state: 'syncing' });
  chrome.runtime.sendMessage({ action: 'syncBalanceFromBanner', jpyBalance: jpy }, (res) => {
    if (chrome.runtime.lastError || !res) {
      renderBanner({ state: 'error', message: 'Extension not responding. Reload the page.' });
    } else if (res.success) {
      renderBanner({ state: 'synced', accountName: res.account_name });
    } else {
      const message = SETUP_ERRORS.has(res.error)
        ? 'Finish setup in the extension popup (toolbar icon).'
        : (res.message || 'Sync failed');
      renderBanner({ state: 'error', message });
    }
  });
}

// ── Element picker ────────────────────────────────────────────────────────────

function enableElementPicker() {
  if (pickerActive) return;
  pickerActive = true;

  const hint = document.createElement('div');
  hint.style.cssText = `
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
    background: #4f46e5; color: #fff; padding: 8px 16px; border-radius: 999px;
    font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    box-shadow: 0 6px 20px rgba(0,0,0,.3); pointer-events: none;`;
  hint.textContent = 'Click your balance on the page · Esc to cancel';
  document.body.appendChild(hint);

  let hoverEl = null;
  let savedOutline = '';
  const isOurs = (t) => t === hint || t.id === 'sbi-monarch-banner';

  function clearHover() {
    if (hoverEl) hoverEl.style.outline = savedOutline;
    hoverEl = null;
  }
  function stop() {
    clearHover();
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    hint.remove();
    pickerActive = false;
  }
  function onMouseOver(e) {
    if (isOurs(e.target)) return;
    clearHover();
    hoverEl = e.target;
    savedOutline = hoverEl.style.outline;
    hoverEl.style.outline = '2px solid #6366f1';
  }
  function onKey(e) {
    if (e.key === 'Escape') stop();
  }
  function onClick(e) {
    if (isOurs(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.target;
    stop();

    const num = extractYenNumber(target.innerText || target.value);
    if (!num) {
      renderBanner({ state: 'detecting', message: 'That element has no yen amount. Try clicking the number itself.' });
      return;
    }
    const selector = getUniqueCssSelector(target);
    lastDetectedBalance = num;
    cachedCustomSelector = selector;
    chrome.storage.local.set({ lastParsedSBIBalance: num, lastParsedTimestamp: Date.now(), customSBISelector: selector });
    renderBanner({ state: 'ready', jpy: num, message: null });
  }

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
}

// Single-pass scanner
function runScanOnce() {
  const balance = parseSBIBalance();
  if (balance) {
    if (balance !== lastDetectedBalance) {
      lastDetectedBalance = balance;
      chrome.storage.local.set({ lastParsedSBIBalance: balance, lastParsedTimestamp: Date.now() });
    }
    // Keep a "synced" banner as-is unless the balance changed.
    if (!(bannerView.jpy === balance && ['synced', 'syncing'].includes(bannerView.state))) {
      renderBanner({ state: 'ready', jpy: balance, message: null });
    }
  } else if (IS_TOP_FRAME && bannerView.state === 'detecting') {
    renderBanner({ state: 'detecting' });
  }
}

// Content scripts run in an isolated JS world, so monkey-patching history.pushState
// here would never see the page's own calls. The Navigation API's events, like all
// DOM events, are visible from the isolated world.
function setupNavigationListeners() {
  if (window.navigation) {
    window.navigation.addEventListener('navigatesuccess', onUrlNavigated);
  } else {
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        onUrlNavigated();
      }
    }, 1000);
  }
  window.addEventListener('popstate', onUrlNavigated);
  window.addEventListener('hashchange', onUrlNavigated);
}

let navScanTimer = null;
function onUrlNavigated() {
  clearTimeout(navScanTimer);
  navScanTimer = setTimeout(() => runScanOnce(), 1500);
}

// Listen for background messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'triggerScan') {
    setTimeout(() => runScanOnce(), 1500);
  } else if (request.action === 'getSBIBalance') {
    const balance = parseSBIBalance() || lastDetectedBalance;
    // With all_frames, every frame receives this and the first reply wins, so frames
    // without a balance stay silent (the popup falls back to the cached value).
    if (balance) sendResponse({ balance: balance });
  }
});

// If the balance lives in a subframe, that frame shows the banner. Drop the top
// frame's "not found" card so there aren't two banners.
if (IS_TOP_FRAME) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.lastParsedSBIBalance && !lastDetectedBalance && bannerView.state === 'detecting' && bannerRoot) {
      bannerRoot.host.remove();
    }
  });
}

// Run initial setup and scan
setupNavigationListeners();
setTimeout(() => runScanOnce(), 2000);
