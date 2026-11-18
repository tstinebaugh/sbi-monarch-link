// popup.js - Extension UI logic (Native Messaging architecture)

let currentRate = 0;
let targetAccountId = null;
let fetchedAccounts = [];

function logDebug(msg) {
  console.log('[SBI-Monarch]', msg);
  const debugBox = document.getElementById('debugBox');
  if (debugBox) {
    const time = new Date().toLocaleTimeString();
    debugBox.innerText += `[${time}] ${msg}\n`;
    debugBox.scrollTop = debugBox.scrollHeight;
  }
}

function setStatus(msg, type) {
  const statusEl = document.getElementById('status');
  statusEl.innerText = msg;
  statusEl.style.color = type === 'error' ? '#f87171' : type === 'success' ? '#4ade80' : '#38bdf8';
}

function updateConnectionIndicator(state) {
  const ind = document.getElementById('loginIndicator');
  if (state === 'connected') {
    ind.innerText = '● Connected';
    ind.style.background = '#16a34a';
    ind.style.color = '#fff';
  } else if (state === 'error') {
    ind.innerText = '● Not Setup';
    ind.style.background = '#7f1d1d';
    ind.style.color = '#fca5a5';
  } else {
    ind.innerText = '○ Checking...';
    ind.style.background = '#334155';
    ind.style.color = '#94a3b8';
  }
}

// ── Exchange Rate ─────────────────────────────────────────────────────────────

async function fetchExchangeRate() {
  const rateBadge = document.getElementById('rateBadge');
  logDebug(`Extension v${chrome.runtime.getManifest().version} active.`);
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/JPY');
    const data = await res.json();
    currentRate = data.rates.USD;
    rateBadge.innerText = `1 JPY = ${currentRate.toFixed(6)} USD`;
    recalculate();
  } catch (err) {
    rateBadge.innerText = 'Failed to fetch exchange rate';
    logDebug('FX rate fetch failed: ' + err.message);
  }
}

function recalculate() {
  const jpyVal = parseFloat(document.getElementById('jpyInput').value.replace(/,/g, '')) || 0;
  const usdVal = (jpyVal * currentRate).toFixed(2);
  document.getElementById('usdResult').innerText = `$${Number(usdVal).toLocaleString()}`;
}

// ── Account Selector ──────────────────────────────────────────────────────────

function renderAccountSelector(accounts) {
  const selectSection = document.getElementById('accountSelectSection');
  const accountSelect = document.getElementById('accountSelect');
  accountSelect.innerHTML = '';

  accounts.forEach(acc => {
    const opt = document.createElement('option');
    opt.value = acc.id;
    opt.innerText = `${acc.displayName} ($${(acc.currentBalance || 0).toLocaleString()})`;
    if (acc.id === targetAccountId) opt.selected = true;
    accountSelect.appendChild(opt);
  });

  selectSection.style.display = 'block';

  accountSelect.onchange = (e) => {
    targetAccountId = e.target.value;
    const selected = accounts.find(a => a.id === targetAccountId);
    if (selected) {
      document.getElementById('linkedAccountName').innerText = `${selected.displayName} ($${(selected.currentBalance || 0).toLocaleString()})`;
      chrome.storage.local.set({ monarchAccountId: targetAccountId });
      logDebug(`Account changed to: "${selected.displayName}" (${targetAccountId})`);
    }
  };

  // Set selected account display
  if (targetAccountId) {
    const selected = accounts.find(a => a.id === targetAccountId) || accounts[0];
    if (selected) {
      document.getElementById('linkedAccountName').innerText = `${selected.displayName} ($${(selected.currentBalance || 0).toLocaleString()})`;
    }
  }
}

// ── Native Host Connection Check ──────────────────────────────────────────────

async function checkNativeHost() {
  setStatus('Checking native host connection...', 'info');
  logDebug('Pinging native host...');

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'pingNativeHost' }, (res) => {
      if (res && res.success) {
        logDebug(`✓ Native host running! Session saved: ${res.has_session}`);
        if (res.has_session) {
          document.getElementById('loginSection').style.display = 'none';
          updateConnectionIndicator('connected');
          setStatus('✓ Native host connected! Load accounts below.', 'success');
          loadMonarchAccounts();
        } else {
          document.getElementById('loginSection').style.display = 'block';
          document.getElementById('setupNeeded').style.display = 'block';
          setStatus('Native host found but not logged in. Enter Monarch credentials below.', 'info');
          updateConnectionIndicator('error');
        }
        resolve(true);
      } else {
        const msg = res?.message || 'Native host not installed.';
        logDebug('Native host error: ' + msg);
        document.getElementById('loginSection').style.display = 'block';
        document.getElementById('nativeHostError').style.display = 'block';
        document.getElementById('nativeHostError').innerText = msg;
        setStatus('⚠ Native host not installed. See setup steps below.', 'error');
        updateConnectionIndicator('error');
        resolve(false);
      }
    });
  });
}

// ── Load Monarch Accounts ─────────────────────────────────────────────────────

async function loadMonarchAccounts() {
  logDebug('Loading Monarch accounts from native host...');
  setStatus('Loading accounts...', 'info');

  chrome.runtime.sendMessage({ action: 'getMonarchAccounts' }, (res) => {
    if (!res || !res.success) {
      const msg = res?.message || 'Failed to load accounts.';
      logDebug('Account load error: ' + msg);
      if (res?.error === 'not_logged_in' || res?.error === 'token_expired') {
        document.getElementById('loginSection').style.display = 'block';
        setStatus('Not logged into Monarch. Enter credentials below.', 'error');
      } else {
        setStatus('Error: ' + msg, 'error');
      }
      return;
    }

    fetchedAccounts = res.accounts || [];
    logDebug(`Loaded ${fetchedAccounts.length} manual accounts.`);

    if (fetchedAccounts.length === 0) {
      setStatus('No manual accounts in Monarch. Create one first!', 'error');
      return;
    }

    // Auto-select saved or best match. Only persist a keyword match automatically; a
    // plain "first account" default is shown but not saved until the user confirms it
    // (by syncing or choosing it), so the on-page banner never writes to a guessed account.
    const savedId = targetAccountId;
    const saved = fetchedAccounts.find(a => a.id === savedId);
    const matched = fetchedAccounts.find(a => ['sbi','shinsei','japan','yen'].some(kw => a.displayName.toLowerCase().includes(kw)));
    const best = saved || matched || fetchedAccounts[0];

    targetAccountId = best.id;
    if (saved || matched) chrome.storage.local.set({ monarchAccountId: targetAccountId });
    renderAccountSelector(fetchedAccounts);
    setStatus(`✓ Ready! ${fetchedAccounts.length} account(s) loaded.`, 'success');
  });
}

// ── Login to Monarch (via native host) ───────────────────────────────────────

async function loginToMonarch() {
  const email = document.getElementById('monarchEmail').value.trim();
  const password = document.getElementById('monarchPassword').value;
  const mfa = document.getElementById('monarchMfa').value.trim() || null;

  if (!email || !password) {
    setStatus('Please enter your Monarch email and password.', 'error');
    return;
  }

  setStatus('Logging into Monarch...', 'info');
  logDebug(`Attempting Monarch login for ${email}...`);

  chrome.runtime.sendMessage({ action: 'monarchLogin', email, password, mfa_secret: mfa }, (res) => {
    if (!res) {
      setStatus('No response from native host. Is it installed?', 'error');
      return;
    }
    if (res.success) {
      logDebug('✓ Logged in successfully! Session saved.');
      setStatus('✓ Logged in! Loading your accounts...', 'success');
      document.getElementById('loginSection').style.display = 'none';
      updateConnectionIndicator('connected');
      loadMonarchAccounts();
    } else if (res.error === 'mfa_required') {
      setStatus('MFA required — enter your TOTP secret key or current 6-digit code above.', 'error');
      logDebug('MFA required. Enter your TOTP secret key (not the 6-digit code).');
    } else {
      setStatus('Login failed: ' + (res.message || res.error), 'error');
      logDebug('Login error: ' + (res.message || res.error));
    }
  });
}

// ── Sync Balance ──────────────────────────────────────────────────────────────

async function syncBalance() {
  const jpyVal = parseFloat(document.getElementById('jpyInput').value.replace(/,/g, '')) || 0;

  if (!jpyVal) {
    setStatus('No JPY balance detected. Open SBI Shinsei PowerDirect first.', 'error');
    return;
  }

  if (!targetAccountId) {
    setStatus('No Monarch account selected.', 'error');
    return;
  }

  setStatus('Syncing balance to Monarch...', 'info');
  logDebug(`Syncing ¥${jpyVal.toLocaleString()} to account ${targetAccountId}...`);

  chrome.runtime.sendMessage({
    action: 'syncToMonarch',
    jpy_balance: jpyVal,
    account_id: targetAccountId
  }, (res) => {
    if (!res || !res.success) {
      const msg = res?.message || res?.error || 'Unknown error';
      logDebug('Sync error: ' + msg);
      setStatus('Sync failed: ' + msg, 'error');
    } else {
      chrome.storage.local.set({ monarchAccountId: targetAccountId });
      logDebug(`✓ ${res.message}`);
      setStatus(`✓ ${res.message}`, 'success');
      // Refresh accounts list to show updated balance
      setTimeout(loadMonarchAccounts, 500);
    }
  });
}

// ── SBI Balance Detection ─────────────────────────────────────────────────────

function loadDetectedBalance() {
  const detectionSourceEl = document.getElementById('detectionSource');

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    let handled = false;
    if (tabs[0] && tabs[0].id) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'getSBIBalance' }, (response) => {
        if (!chrome.runtime.lastError && response && response.balance) {
          handled = true;
          document.getElementById('jpyInput').value = response.balance;
          detectionSourceEl.innerText = `✓ Live from SBI page: ¥${Number(response.balance).toLocaleString()}`;
          detectionSourceEl.style.color = '#4ade80';
          recalculate();
          chrome.storage.local.set({ lastParsedSBIBalance: response.balance, lastParsedTimestamp: Date.now() });
        }
      });
    }

    setTimeout(() => {
      if (!handled) {
        chrome.storage.local.get(['lastParsedSBIBalance', 'lastParsedTimestamp'], (items) => {
          if (items.lastParsedSBIBalance) {
            document.getElementById('jpyInput').value = items.lastParsedSBIBalance;
            const minsAgo = items.lastParsedTimestamp ? Math.round((Date.now() - items.lastParsedTimestamp) / 60000) : 0;
            const timeStr = minsAgo < 1 ? 'just now' : `${minsAgo}m ago`;
            detectionSourceEl.innerText = `✓ Cached balance (${timeStr}): ¥${Number(items.lastParsedSBIBalance).toLocaleString()}`;
            detectionSourceEl.style.color = '#4ade80';
            recalculate();
          }
        });
      }
    }, 300);
  });
}

async function saveMonarchToken() {
  const token = document.getElementById('monarchTokenInput').value.trim();
  if (!token) {
    setStatus('Please paste a session token.', 'error');
    return;
  }
  setStatus('Saving token to Apple Keychain...', 'info');
  chrome.runtime.sendMessage({ action: 'saveMonarchToken', token }, (res) => {
    if (res && res.success) {
      logDebug('✓ Token saved to Keychain.');
      setStatus('✓ Token saved! Loading accounts...', 'success');
      document.getElementById('loginSection').style.display = 'none';
      updateConnectionIndicator('connected');
      loadMonarchAccounts();
    } else {
      setStatus('Failed to save token: ' + (res?.message || 'Unknown error'), 'error');
    }
  });
}

// ── Event Listeners ───────────────────────────────────────────────────────────

document.getElementById('loginMonarchBtn').addEventListener('click', loginToMonarch);
document.getElementById('saveTokenBtn').addEventListener('click', saveMonarchToken);
document.getElementById('jpyInput').addEventListener('input', recalculate);
document.getElementById('syncBtn').addEventListener('click', syncBalance);
document.getElementById('refreshAccountsBtn').addEventListener('click', loadMonarchAccounts);

// ── Startup ───────────────────────────────────────────────────────────────────

chrome.storage.local.get(['monarchAccountId'], (items) => {
  if (items.monarchAccountId) {
    targetAccountId = items.monarchAccountId;
  }
  checkNativeHost();
});

fetchExchangeRate();
loadDetectedBalance();
