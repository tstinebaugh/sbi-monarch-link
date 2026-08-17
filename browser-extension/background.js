// background.js - Native Messaging Bridge to Python monarchmoney host

const NATIVE_HOST = 'com.sbi.monarch.host';

// ── Core: call Python native host ───────────────────────────────────────────

function callNativeHost(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // 1. Ping native host (check if installed & logged in)
  if (request.action === 'pingNativeHost') {
    callNativeHost({ action: 'ping' })
      .then(res => sendResponse(res))
      .catch(err => sendResponse({
        success: false,
        error: 'native_host_not_found',
        message: `Native host connection error: ${err.message}\n\nPlease ensure you have reloaded the extension in chrome://extensions after installing.`
      }));
    return true;
  }

  // 2. Get Monarch accounts list via Python
  if (request.action === 'getMonarchAccounts') {
    callNativeHost({ action: 'get_accounts' })
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: 'native_error', message: err.message }));
    return true;
  }

  // 3. Sync JPY balance to Monarch via Python (converts to USD internally)
  if (request.action === 'syncToMonarch') {
    callNativeHost({
      action: 'sync',
      jpy_balance: request.jpy_balance,
      account_id: request.account_id || null
    })
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: 'native_error', message: err.message }));
    return true;
  }

  // 4. Login to Monarch (one-time setup via extension popup)
  if (request.action === 'monarchLogin') {
    callNativeHost({
      action: 'login',
      email: request.email,
      password: request.password,
      mfa_secret: request.mfa_secret || null
    })
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: 'native_error', message: err.message }));
    return true;
  }

  // 4b. Save existing Monarch session token directly
  if (request.action === 'saveMonarchToken') {
    callNativeHost({
      action: 'save_token',
      token: request.token
    })
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: 'native_error', message: err.message }));
    return true;
  }

  // 5. 1-click sync from SBI Shinsei floating banner
  if (request.action === 'syncBalanceFromBanner') {
    chrome.storage.local.get(['monarchAccountId'], async (items) => {
      try {
        const res = await callNativeHost({
          action: 'sync',
          jpy_balance: request.jpyBalance,
          account_id: items.monarchAccountId || null
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ success: false, error: 'native_error', message: err.message });
      }
    });
    return true;
  }
});
