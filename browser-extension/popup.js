// popup.js — extension popup: setup checklist, balance conversion, account picker, sync

const $ = (id) => document.getElementById(id);
const ACCOUNT_KEYWORDS = ['sbi', 'shinsei', 'japan', 'yen'];

const state = {
  rate: null,
  jpy: 0,
  hostInstalled: false,
  connected: false,
  accounts: [],
  accountId: null,
  busy: false,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (res) => {
      if (chrome.runtime.lastError) resolve({ success: false, message: chrome.runtime.lastError.message });
      else resolve(res || { success: false, message: 'No response from extension.' });
    });
  });
}

const fmtJPY = (n) => Math.round(n).toLocaleString('en-US');
const fmtUSD = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function log(msg) {
  console.log('[SBI-Monarch]', msg);
  const box = $('debugBox');
  box.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  box.scrollTop = box.scrollHeight;
}

function setStatus(msg, type = '') {
  $('status').textContent = msg || '';
  $('status').className = type;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  const pill = $('connectionPill');
  if (!state.hostInstalled) {
    pill.textContent = 'Setup needed';
    pill.className = 'pill warn';
  } else if (!state.connected) {
    pill.textContent = 'Not connected';
    pill.className = 'pill warn';
  } else {
    pill.textContent = 'Connected';
    pill.className = 'pill ok';
  }

  $('setupCard').hidden = state.hostInstalled && state.connected;
  setStep('stepHost', state.hostInstalled ? 'done' : 'todo', '1');
  setStep('stepMonarch', state.connected ? 'done' : state.hostInstalled ? 'todo' : '', '2');
  $('connectBtn').disabled = !state.hostInstalled;
  $('saveTokenBtn').disabled = !state.hostInstalled;
  $('accountCard').hidden = !state.connected;

  const usd = state.rate ? state.jpy * state.rate : null;
  $('usdResult').textContent = usd == null ? '—' : fmtUSD(usd);

  const ready = state.hostInstalled && state.connected && state.accountId && state.jpy > 0;
  $('syncBtn').disabled = !ready || state.busy;
}

function setStep(id, status, number) {
  const el = $(id);
  el.className = `step ${status}`;
  el.querySelector('.step-mark').textContent = status === 'done' ? '✓' : number;
}

function setSourceChip(source, at) {
  const chip = $('sourceChip');
  chip.className = 'chip' + (source === 'live' ? ' live' : '');
  chip.textContent = {
    live: 'Live from SBI',
    cached: `Saved ${at ? timeAgo(at) : ''}`.trim(),
    manual: 'Edited',
  }[source] || 'No balance yet';
}

function setJpy(value, source, at) {
  state.jpy = value || 0;
  $('jpyInput').value = state.jpy ? fmtJPY(state.jpy) : '';
  setSourceChip(state.jpy ? source : null, at);
  render();
}

function renderAccounts() {
  const select = $('accountSelect');
  select.replaceChildren();

  const saved = state.accounts.find(a => a.id === state.accountId);
  const matched = state.accounts.find(a => ACCOUNT_KEYWORDS.some(kw => a.displayName.toLowerCase().includes(kw)));

  if (!saved && !matched && state.accounts.length) {
    // Never guess silently: make the user pick which account receives the balance.
    const placeholder = new Option('Choose an account…', '', true, true);
    placeholder.disabled = true;
    select.append(placeholder);
    state.accountId = null;
  } else {
    state.accountId = (saved || matched || {}).id || null;
    if (state.accountId) chrome.storage.local.set({ monarchAccountId: state.accountId });
  }

  for (const acc of state.accounts) {
    const opt = new Option(`${acc.displayName} · ${fmtUSD(acc.currentBalance || 0)}`, acc.id);
    opt.selected = acc.id === state.accountId;
    select.append(opt);
  }
  render();
}

function renderLastSync(lastSync) {
  $('lastSyncLine').textContent = lastSync
    ? `Last synced ${fmtUSD(lastSync.usd)} to ${lastSync.accountName} · ${timeAgo(lastSync.at)}`
    : 'Not synced yet.';
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadFx() {
  const res = await send('getFxRate');
  if (res.success) {
    state.rate = res.rate;
    const at = new Date(res.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('rateLine').textContent = `1 JPY = ${res.rate.toFixed(6)} USD · ${at}`;
  } else {
    $('rateLine').textContent = 'Exchange rate unavailable';
    log('FX error: ' + res.message);
  }
  render();
}

function askActiveTabForBalance() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || !tabs[0].id) return resolve(null);
      chrome.tabs.sendMessage(tabs[0].id, { action: 'getSBIBalance' }, (res) => {
        resolve(!chrome.runtime.lastError && res && res.balance ? res.balance : null);
      });
    });
  });
}

async function loadBalance() {
  const live = await askActiveTabForBalance();
  if (live) {
    setJpy(live, 'live');
    chrome.storage.local.set({ lastParsedSBIBalance: live, lastParsedTimestamp: Date.now() });
    return;
  }
  const { lastParsedSBIBalance, lastParsedTimestamp } = await chrome.storage.local.get(['lastParsedSBIBalance', 'lastParsedTimestamp']);
  if (lastParsedSBIBalance) setJpy(lastParsedSBIBalance, 'cached', lastParsedTimestamp);
}

async function loadAccounts({ keepStatus = false } = {}) {
  log('Loading Monarch accounts…');
  if (!keepStatus) setStatus('Loading Monarch accounts…');
  const res = await send('getMonarchAccounts');
  if (!res.success) {
    state.connected = false;
    render();
    if (res.error === 'token_expired') setStatus(res.message || 'Your Monarch session expired. Log into Monarch, then Connect.', 'error');
    else if (res.error === 'not_logged_in') setStatus('Connect Monarch to continue.');
    else setStatus(res.message || 'Could not load Monarch accounts.', 'error');
    log(`Account load failed: ${res.error || ''} ${res.session_source ? `[${res.session_source} session] ` : ''}${res.detail || res.message || ''}`);
    return;
  }
  state.connected = true;
  state.accounts = res.accounts || [];
  log(`Loaded ${state.accounts.length} manual account(s).`);
  renderAccounts();
  if (!state.accounts.length) {
    setStatus('No manual accounts in Monarch yet. Add one (Accounts → Add account → Manual), then press ↻.', 'error');
  } else if (!state.accountId) {
    setStatus('Choose which Monarch account to update.');
  } else if (!keepStatus) {
    setStatus('');
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function connectMonarch() {
  setStatus('Connecting… (Monarch can take a few seconds)');
  const res = await send('connectMonarch');
  if (res.success) {
    state.connected = true;
    state.accounts = res.accounts || [];
    renderAccounts();
    setStatus('Connected to Monarch.', 'success');
    log('Connected using the browser session.');
  } else if (res.error === 'needs_browser_login') {
    setStatus(res.message);
  } else {
    setStatus(res.message || 'Could not connect.', 'error');
    log(`Connect failed: ${res.error || ''} ${res.session_source ? `[${res.session_source} session] ` : ''}${res.detail || res.message || ''}`);
    if (res.cookieReport) log('Monarch cookies visible to the extension: ' + res.cookieReport);
  }
}

async function saveManualSession() {
  const input = $('monarchTokenInput');
  const token = input.value.trim();
  if (!token) return setStatus('Paste your Monarch Cookie header first.', 'error');
  const res = await send('saveMonarchToken', { token });
  input.value = '';
  if (!res.success) return setStatus(res.message || 'Could not save session.', 'error');
  log('Manual session saved to Keychain.');
  await loadAccounts();
}

async function sync() {
  state.busy = true;
  const btn = $('syncBtn');
  btn.textContent = 'Syncing…';
  render();
  log(`Syncing ¥${fmtJPY(state.jpy)} → account ${state.accountId}`);

  const res = await send('syncToMonarch', { jpy_balance: state.jpy, account_id: state.accountId });

  state.busy = false;
  btn.textContent = 'Sync to Monarch';
  if (res.success) {
    setStatus(`Updated ${res.account_name} to ${fmtUSD(res.usd_balance)}`, 'success');
    log(res.message);
    loadAccounts({ keepStatus: true });
  } else if (res.error === 'token_expired' || res.error === 'not_logged_in') {
    state.connected = false;
    setStatus(res.message || 'Your Monarch session expired. Log into Monarch, then Connect.', 'error');
    log(`Sync auth failure: ${res.detail || res.message}`);
  } else {
    setStatus('Sync failed: ' + (res.message || res.error), 'error');
    log('Sync error: ' + (res.message || res.error));
  }
  render();
}

// ── Wiring ────────────────────────────────────────────────────────────────────

$('jpyInput').addEventListener('input', (e) => {
  state.jpy = Number(e.target.value.replace(/[^\d.]/g, '')) || 0;
  setSourceChip(state.jpy ? 'manual' : null);
  render();
});
$('jpyInput').addEventListener('blur', () => {
  $('jpyInput').value = state.jpy ? fmtJPY(state.jpy) : '';
});
$('accountSelect').addEventListener('change', (e) => {
  state.accountId = e.target.value;
  chrome.storage.local.set({ monarchAccountId: state.accountId });
  setStatus('');
  render();
});
$('syncBtn').addEventListener('click', sync);
$('refreshAccountsBtn').addEventListener('click', loadAccounts);
$('connectBtn').addEventListener('click', connectMonarch);
$('saveTokenBtn').addEventListener('click', saveManualSession);
$('copyCmdBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('installCmd').textContent);
  $('copyCmdBtn').textContent = 'Copied';
  setTimeout(() => { $('copyCmdBtn').textContent = 'Copy'; }, 1500);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.monarchConnectedAt && !state.connected && state.hostInstalled) loadAccounts();
  if (changes.lastSync) renderLastSync(changes.lastSync.newValue);
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function init() {
  log(`Extension v${chrome.runtime.getManifest().version}`);
  $('installCmd').textContent = `bash native-host/install_native_host.sh ${chrome.runtime.id}`;

  const { monarchAccountId, lastSync } = await chrome.storage.local.get(['monarchAccountId', 'lastSync']);
  state.accountId = monarchAccountId || null;
  renderLastSync(lastSync);

  loadFx();
  loadBalance();

  const status = await send('getStatus');
  state.hostInstalled = !!status.hostInstalled;
  log(state.hostInstalled ? `Native host v${status.hostVersion || '?'} OK` : `Native host missing: ${status.hostMessage || status.message}`);
  log(`Monarch session in browser: ${status.browserLoggedIn ? 'found' : 'not found'}; saved in Keychain: ${status.hasStoredSession ? 'yes' : 'no'}`);
  if (status.cookieReport) log('Monarch cookies visible to the extension: ' + status.cookieReport);

  if (!state.hostInstalled) {
    setStatus('Finish setup to start syncing.');
  } else if (status.browserLoggedIn || status.hasStoredSession) {
    await loadAccounts();
  } else {
    setStatus('Connect Monarch to continue.');
  }
  render();
}

init();
