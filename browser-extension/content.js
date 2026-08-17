// content.js - Minimal, silent DOM parser & floating sync banner for SBI Shinsei Bank

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

// Fetch exchange rate for floating banner
async function getFXRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/JPY');
    const data = await res.json();
    return data.rates.USD;
  } catch (e) {
    return null;
  }
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
function parseSBIBalance() {
  const candidates = [];

  // 1. Check pre-loaded custom selector from user click
  if (cachedCustomSelector) {
    try {
      const el = document.querySelector(cachedCustomSelector);
      if (el) {
        const num = extractYenNumber(el.innerText || el.value);
        if (num && num > 0) candidates.push(num);
      }
    } catch (e) {}
  }

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
      }
    }
  }

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

  if (candidates.length > 0) {
    candidates.sort((a, b) => b - a);
    return candidates[0];
  }

  return null;
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

// Render floating sync banner on SBI Shinsei page
async function renderFloatingBanner(jpyBalance) {
  exchangeRateUSD = exchangeRateUSD || await getFXRate();
  const usdAmount = (jpyBalance && exchangeRateUSD) ? (jpyBalance * exchangeRateUSD).toFixed(2) : null;
  const usdText = usdAmount ? `$${Number(usdAmount).toLocaleString()} USD` : 'Calculating USD...';

  let banner = document.getElementById('sbi-monarch-banner');
  
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'sbi-monarch-banner';
    banner.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 999999;
      background: #0f172a;
      color: #f8fafc;
      border: 1px solid #38bdf8;
      border-radius: 12px;
      padding: 14px 18px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 12px;
    `;
    document.body.appendChild(banner);
  }

  if (jpyBalance) {
    banner.innerHTML = `
      <div>
        <div style="font-weight: 600; color: #38bdf8; font-size: 13px;">🏦 SBI ➔ Monarch Money</div>
        <div style="font-weight: bold; font-size: 15px; margin-top: 2px;">
          ¥${jpyBalance.toLocaleString()} JPY <span style="color: #4ade80;">➔ ${usdText}</span>
        </div>
      </div>
      <button id="sbi-monarch-quick-sync" style="
        background: #0284c7;
        color: white;
        border: none;
        padding: 8px 14px;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
        font-size: 13px;
      ">Sync Now</button>
      <button id="sbi-monarch-picker-btn" title="Pick balance on screen" style="
        background: #334155;
        color: #94a3b8;
        border: none;
        padding: 6px 10px;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
      ">🎯 Pick Element</button>
      <span id="sbi-monarch-close" style="cursor: pointer; color: #64748b; font-size: 16px; margin-left: 4px;">✕</span>
    `;

    document.getElementById('sbi-monarch-quick-sync').onclick = async () => {
      const btn = document.getElementById('sbi-monarch-quick-sync');
      btn.innerText = 'Syncing...';
      btn.disabled = true;

      chrome.runtime.sendMessage({
        action: 'syncBalanceFromBanner',
        jpyBalance: jpyBalance,
        usdBalance: parseFloat(usdAmount)
      }, (response) => {
        if (response && response.success) {
          btn.innerText = '✓ Synced!';
          btn.style.background = '#16a34a';
        } else {
          btn.innerText = 'Setup Monarch Account in Extension';
          btn.style.background = '#dc2626';
        }
      });
    };
  } else {
    banner.innerHTML = `
      <div>
        <div style="font-weight: 600; color: #38bdf8; font-size: 13px;">🏦 SBI ➔ Monarch Money</div>
        <div style="font-size: 13px; margin-top: 2px; color: #94a3b8;">
          Detecting balance on page...
        </div>
      </div>
      <button id="sbi-monarch-rescan-btn" style="
        background: #334155;
        color: #e2e8f0;
        border: none;
        padding: 6px 10px;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
      ">🔍 Scan Page</button>
      <button id="sbi-monarch-picker-btn" style="
        background: #0284c7;
        color: white;
        border: none;
        padding: 8px 14px;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
        font-size: 13px;
      ">🎯 Click Balance on Screen</button>
      <span id="sbi-monarch-close" style="cursor: pointer; color: #64748b; font-size: 16px; margin-left: 4px;">✕</span>
    `;

    const rescanBtn = document.getElementById('sbi-monarch-rescan-btn');
    if (rescanBtn) {
      rescanBtn.onclick = () => runScanOnce();
    }
  }

  document.getElementById('sbi-monarch-close').onclick = () => banner.remove();
  
  const pickerBtn = document.getElementById('sbi-monarch-picker-btn');
  if (pickerBtn) {
    pickerBtn.onclick = enableElementPicker;
  }
}

// Interactive Element Picker
function enableElementPicker() {
  if (pickerActive) return;
  pickerActive = true;

  const overlay = document.createElement('div');
  overlay.id = 'sbi-picker-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999999;
    background: #0369a1;
    color: white;
    padding: 10px 20px;
    border-radius: 20px;
    font-size: 14px;
    font-weight: bold;
    box-shadow: 0 4px 15px rgba(0,0,0,0.4);
    pointer-events: none;
  `;
  overlay.innerText = '🎯 Click on your SBI Bank Balance number on screen!';
  document.body.appendChild(overlay);

  let hoverEl = null;

  function onMouseOver(e) {
    if (e.target.closest('#sbi-monarch-banner') || e.target.id === 'sbi-picker-overlay') return;
    if (hoverEl) hoverEl.style.outline = '';
    hoverEl = e.target;
    hoverEl.style.outline = '2px solid #38bdf8';
  }

  function onClick(e) {
    if (e.target.closest('#sbi-monarch-banner') || e.target.id === 'sbi-picker-overlay') return;
    e.preventDefault();
    e.stopPropagation();

    if (hoverEl) hoverEl.style.outline = '';
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    overlay.remove();
    pickerActive = false;

    const targetEl = e.target;
    const clickedText = targetEl.innerText || targetEl.value;
    const selector = getUniqueCssSelector(targetEl);
    const num = extractYenNumber(clickedText);
    
    if (num) {
      console.log('[SBI-Shinsei] Selected balance:', num);
      lastDetectedBalance = num;
      cachedCustomSelector = selector;
      
      chrome.storage.local.set({
        lastParsedSBIBalance: num,
        lastParsedTimestamp: Date.now(),
        customSBISelector: selector
      });

      renderFloatingBanner(num);
    } else {
      alert('Could not parse a currency number from clicked element: ' + clickedText);
    }
  }

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onClick, true);
}

// Single-pass scanner
function runScanOnce() {
  const balance = parseSBIBalance();
  if (balance) {
    if (balance !== lastDetectedBalance) {
      console.log('[SBI-Shinsei] Auto-detected balance:', balance);
      lastDetectedBalance = balance;
      try {
        chrome.storage.local.set({
          lastParsedSBIBalance: balance,
          lastParsedTimestamp: Date.now()
        });
      } catch (e) {}
    }
    renderFloatingBanner(balance);
  } else {
    renderFloatingBanner(null);
  }
}

// Watch for Navigation & Login Transitions (SPA pushState / popstate)
function setupNavigationListeners() {
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;

  history.pushState = function(...args) {
    origPushState.apply(this, args);
    onUrlNavigated();
  };

  history.replaceState = function(...args) {
    origReplaceState.apply(this, args);
    onUrlNavigated();
  };

  window.addEventListener('popstate', onUrlNavigated);
  window.addEventListener('hashchange', onUrlNavigated);
}

function onUrlNavigated() {
  setTimeout(() => runScanOnce(), 1500);
}

// Listen for background messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'triggerScan') {
    setTimeout(() => runScanOnce(), 1500);
  } else if (request.action === 'getSBIBalance') {
    const balance = parseSBIBalance() || lastDetectedBalance;
    sendResponse({ balance: balance });
  }
  return true;
});

// Run initial setup and scan
setupNavigationListeners();
setTimeout(() => runScanOnce(), 2000);
