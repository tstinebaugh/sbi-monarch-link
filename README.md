# SBI Shinsei Bank → Monarch Money Balance Syncer 🇯🇵 ➔ 🇺🇸

[![CI](https://github.com/tstinebaugh/sbi-monarch-link/actions/workflows/ci.yml/badge.svg)](https://github.com/tstinebaugh/sbi-monarch-link/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Chrome / Brave / Edge / Arc extension plus a small local Python service that copies your **SBI Shinsei Bank (JPY)** balance into a manual account in **Monarch Money (USD)**, converted at the live spot rate. Monarch can't link Japanese banks, so this keeps a multi-currency net worth up to date with one click.

> **Platform:** macOS (the native host stores your session in Apple Keychain). Python 3.10+.

---

## ✨ Features

- 🏦 **Automatic balance detection** on SBI Shinsei PowerDirect, with an element picker for when the page layout changes.
- 💱 **Live JPY→USD conversion** using spot rates.
- 🔔 **On-page sync banner**: shows `¥ JPY ➔ $ USD` with a one-click **Sync Now** button.
- 🔐 **Session stored in Apple Keychain**: never in a config file, browser storage, or process arguments.
- 📋 **Account picker**: lists your manual Monarch accounts so you choose where the balance goes.

---

## 🧭 How it works

```
 SBI Shinsei page            Browser extension (MV3)                 Native host (Python)            Monarch
┌──────────────────┐  msg  ┌──────────────────────────┐  native   ┌──────────────────────────┐  HTTPS  ┌─────────┐
│ content.js       │ ────▶ │ background.js (service   │ ────────▶ │ sbi_monarch_host.py      │ ──────▶ │ GraphQL │
│  scrape balance  │       │  worker) + popup.js      │ messaging │  • Keychain session      │         │   API   │
│  floating banner │       │                          │  (stdio)  │  • FX conversion         │         └─────────┘
└──────────────────┘       └──────────────────────────┘           │  • updateAccount mutation│
                                                                   └──────────────────────────┘
```

The extension never sees your Monarch credentials. It hands the JPY figure to a [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) host, and that host is the only component that holds the session and talks to Monarch. Chrome only lets the extension ID you registered at install time launch the host.

---

## 🔒 Security & privacy

- **No backend of its own**: no servers, telemetry, or analytics. Network traffic goes only to:
  - your bank (the page you're already on)
  - Monarch's API (over TLS)
  - [open.er-api.com](https://open.er-api.com) for the exchange rate (this request carries no account data)
- **Keychain storage**: the session is written through the [`keyring`](https://pypi.org/project/keyring/) library, which uses the macOS Security framework directly.
- **Minimal permissions**: the extension requests only `storage` and `nativeMessaging`, plus host access to the bank's domains and the FX API.
- **No silent writes to the wrong account**: if you haven't picked a target account and none is named like *SBI / Shinsei / Japan / Yen*, sync refuses to run.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

---

## 🛠 Installation

```bash
git clone https://github.com/tstinebaugh/sbi-monarch-link.git
cd sbi-monarch-link
python3 -m pip install -r requirements.txt
```

### 1. Load the extension
1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Turn on **Developer mode**, then click **Load unpacked** and choose the `browser-extension/` folder.
3. Copy the **Extension ID** shown on the card. It's 32 letters, and it's unique to your install because it's derived from the folder path.

### 2. Register the native host
```bash
bash native-host/install_native_host.sh <YOUR_EXTENSION_ID>
```
The installer generates a launcher pinned to the Python interpreter that has the dependencies installed. It then registers the host for every supported browser it finds. Reload the extension afterwards.

---

## 🚀 Usage

### 1. Create a manual account in Monarch
**Accounts ➔ Add Account ➔ Manual Account**, then name it e.g. `SBI Shinsei Bank` (type: Cash / Checking).

### 2. Connect your Monarch session (one time)
Monarch's login endpoint sits behind Cloudflare bot protection, so the reliable method is to reuse your browser session:

1. Open [app.monarch.com](https://app.monarch.com) while logged in.
2. Open DevTools (`⌥⌘I`), go to **Network**, filter for `graphql`, and click any request.
3. Under **Request Headers**, copy the full `Cookie:` value (it must include `session_id=…` and `csrftoken=…`).
4. Paste it into the extension popup and click **Save Monarch Session**, or run this and paste at the hidden prompt:
   ```bash
   python3 native-host/sbi_monarch_host.py --session
   ```

> ⚠️ This cookie grants full access to your Monarch account. Treat it like a password. Don't paste it into issues or chats.

Other host commands: `--status`, `--logout`, `--login` (email/password; often blocked by Cloudflare).

### 3. Sync
- **On-page banner:** log into [SBI Shinsei PowerDirect](https://bk.web.sbishinseibank.co.jp/) and click **Sync Now**. If the detected number is wrong, click **🎯 Pick Element** and select your balance. The extension remembers your choice.
- **Popup:** check the balance and target account, then click **⚡ Sync Balance to Monarch**.
- **CLI (no browser):**
  ```bash
  python3 sbi_monarch_sync.py --list-accounts
  python3 sbi_monarch_sync.py --jpy 1,234,567 --account-id <ID>
  ```

---

## 🧪 Development

```bash
python3 -m pip install -r requirements.txt pytest ruff
pytest           # native host unit tests (no network or Keychain access)
ruff check .
```

CI runs the tests, `ruff`, syntax checks on the extension scripts, and `shellcheck` on the installer.

For debugging, open the popup's **Debug Log**, or inspect the service worker from `chrome://extensions`. The host writes stack traces to stderr, which Chrome shows when it's launched with `--enable-logging=stderr`.

---

## 📁 Repository structure

```
sbi-monarch-link/
├── browser-extension/
│   ├── manifest.json          # Manifest V3 config
│   ├── background.js          # Service worker: native messaging bridge, FX fetch
│   ├── content.js             # SBI balance detection + floating banner
│   ├── popup.html / popup.js  # Popup UI
├── native-host/
│   ├── sbi_monarch_host.py    # Native host: Keychain session + Monarch GraphQL
│   └── install_native_host.sh # Generates launcher + host manifest, registers with browsers
├── sbi_monarch_sync.py        # Stand-alone CLI (reuses the native host)
└── tests/                     # pytest suite for the native host
```

---

## ⚠️ Limitations

- Balance detection is DOM-scraping heuristics. If SBI changes their site it may pick the wrong number, so check it before syncing, or use the element picker.
- Monarch's API is undocumented and may change without notice.
- Only the yen balance is synced; foreign-currency and time-deposit accounts aren't separated yet.

## 🗺️ Roadmap

- 📊 Historical FX logging to help with FBAR / FATCA (Form 8938) peak-balance reporting
- 📈 FX gain/loss ledger for cross-border transfers
- 🏦 Separate yen savings, time-deposit and foreign-currency balances

---

## ⚖️ License & disclaimer

[MIT](LICENSE). This is an unofficial personal utility, **not affiliated with, endorsed by, or associated with SBI Shinsei Bank, Ltd. or Monarch Money, Inc.** All product names and brands are property of their respective owners. Automated access may be subject to those services' terms. Use at your own risk.
