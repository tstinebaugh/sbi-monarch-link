# SBI Shinsei Bank to Monarch Money Balance Syncer 🇯🇵 ➔ 🇺🇸

A lightweight, secure Chrome / Brave / Edge browser extension that bridges your **SBI Shinsei Bank (Japan - JPY)** account balance to **Monarch Money (US - USD)** to seamlessly track your multi-currency net worth in real-time.

---

## ✨ Features

- 🏦 **Automatic SBI Shinsei Balance Parsing**: Reads your JPY balance automatically from SBI Shinsei PowerDirect online banking.
- 💱 **Live Spot FX Exchange Rates**: Converts JPY to USD in real-time using spot currency rates.
- 🔔 **Interactive On-Page Sync Banner**: When logged into SBI Shinsei, a non-intrusive floating banner appears showing `¥ JPY ➔ $ USD` with a 1-Click **"Sync Now"** button.
- 🔐 **Zero-Cloud & Apple Keychain Security**: Native Python host handles auth directly with Monarch Money API and stores session credentials securely in macOS Apple Keychain.
- 📋 **Account Dropdown Selector**: Automatically pulls your manual accounts from Monarch for easy 1-click selection.

---

## 🔒 Security & Privacy by Design

- **100% Local Processing**: No intermediate servers, telemetry, analytics, or third-party cloud backends. All communication happens strictly between your browser, your local machine, and Monarch's official GraphQL API over TLS.
- **Apple Keychain Credential Storage**: Session cookies and auth tokens are stored encrypted in the macOS Keychain (`security` subsystem) rather than plaintext configuration files.
- **Scoped Permissions**: The native messaging host manifest strictly locks communication to your extension's unique origin ID.

---

## 🛠 Installation Guide

### 1. Load the Browser Extension
1. Open Chrome, Brave, or Edge and navigate to `chrome://extensions`.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `browser-extension/` directory in this repository.
5. Note the **Extension ID** displayed (e.g., `olancffkhkogbcnkhemeiooednpodibo`).

### 2. Install Native Host
Run the automated installer script from your terminal:

```bash
bash native-host/install_native_host.sh
```

Follow the prompt (press Enter to accept the default Extension ID, or paste your ID if different).

---

## 🚀 How to Use

1. **Create a Manual Account in Monarch**:
   - In Monarch Money, go to **Accounts ➔ Add Account ➔ Manual Account**.
   - Name it `SBI Shinsei Bank` (Account Type: Cash / Checking / Asset).

2. **Connect Monarch (One-time Setup)**:
   - Open the extension popup in your browser toolbar.
   - Enter your Monarch email & password (or paste your session cookie/token).
   - Once connected, your session is saved in Apple Keychain.

3. **Syncing your Balance**:
   - **Method A (On-Page Banner)**: Log into [SBI Shinsei PowerDirect](https://bk.web.sbishinseibank.co.jp/). Click **"Sync Now"** on the floating banner in the bottom-right corner!
   - **Method B (Extension Popup)**: Open the extension popup, verify the parsed balance, and click **"⚡ Sync Balance to Monarch"**.

---

## 🗺️ Roadmap & Future Enhancements

- 📊 **US Expat Tax Tracking**: Historical FX conversion logging to assist with annual IRS filings (FBAR / FinCEN 114 and FATCA / Form 8938 peak balance calculation).
- 📈 **Foreign Exchange Gain/Loss Ledger**: Track basis and currency exchange gains/losses for cross-border transfers.
- 🏦 **Multi-Account Support**: Auto-differentiate between Yen savings, Yen time deposits, and foreign currency deposit accounts in SBI Shinsei.

---

## 📁 Repository Structure

```
sbi-monarch-link/
├── README.md                          # Project documentation & setup
├── requirements.txt                   # Python requirements
├── sbi_monarch_sync.py               # Optional standalone CLI script
├── native-host/
│   ├── com.sbi.monarch.host.json      # Native messaging host manifest template
│   ├── install_native_host.sh         # One-click native host installer
│   ├── sbi_monarch_host_launcher.sh   # Environment launcher wrapper
│   └── sbi_monarch_host.py            # Native host (Keychain + Monarch GraphQL API)
└── browser-extension/
    ├── manifest.json                  # Manifest V3 extension configuration
    ├── background.js                  # Service worker (Native messaging bridge)
    ├── content.js                     # SBI Shinsei DOM scraper + floating banner
    ├── popup.html                     # Extension Popup UI
    └── popup.js                       # Extension UI logic & native host communicator
```

---

## ⚖️ Disclaimer

This project is an unofficial, open-source personal utility and is **not affiliated with, endorsed by, or associated with SBI Shinsei Bank, Ltd. or Monarch Money, Inc.**

All product names, logos, and brands are property of their respective owners. This software is provided "as is" for personal convenience without warranties of any kind.
