#!/usr/bin/env python3
"""
SBI Monarch Native Messaging Host
----------------------------------
Chrome calls this script via Native Messaging.
Uses direct aiohttp calls to Monarch's GraphQL API.
Stores the Monarch session in the OS credential store (Apple Keychain on macOS)
via the `keyring` library.

Communication: 4-byte length-prefixed JSON over stdin/stdout.

CLI usage:
    python3 sbi_monarch_host.py --session   # paste a Monarch session cookie / token
    python3 sbi_monarch_host.py --login     # email + password (+ optional TOTP)
    python3 sbi_monarch_host.py --status
    python3 sbi_monarch_host.py --logout
"""

from __future__ import annotations

import asyncio
import getpass
import json
import math
import socket
import struct
import sys
import traceback
from dataclasses import dataclass

import aiohttp
import keyring
from keyring.errors import KeyringError, PasswordDeleteError

# ── Constants ─────────────────────────────────────────────────────────────────

MONARCH_LOGIN   = 'https://api.monarchmoney.com/auth/login/'
EXCHANGE_API    = 'https://open.er-api.com/v6/latest/JPY'

HOST_VERSION = '1.3.0'

KEYCHAIN_SERVICE = 'sbi-monarch-link'
KEYCHAIN_ACCOUNT = 'monarch_session_token'

# Connecting should be quick; Monarch's API itself sometimes takes 10+ s to answer,
# so the overall budget is generous.
HTTP_TIMEOUT = aiohttp.ClientTimeout(total=45, sock_connect=8)

# GraphQL endpoints a cookie session may be sent to. The browser extension tells us
# which one the session belongs to; anything else is rejected so a session cookie
# can never be forwarded to an arbitrary host.
MONARCH_GRAPHQL_ENDPOINTS = (
    'https://api.monarch.com/graphql',
    'https://api.monarchmoney.com/graphql',
)
# api.monarchmoney.com now 301-redirects to api.monarch.com (and a redirected POST
# turns into a GET), so every request goes straight to the new host. Sessions are
# shared across both domains.
API_ENDPOINT = 'https://api.monarch.com/graphql'
CSRF_ENDPOINT = 'https://api.monarch.com/auth/csrf/'
APP_ORIGIN = 'https://app.monarch.com'
DEFAULT_USER_AGENT = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
                      '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36')

# Accounts whose name contains one of these are auto-selected when no account
# ID has been chosen yet.
ACCOUNT_KEYWORDS = ('sbi', 'shinsei', 'japan', 'yen')

BASE_HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Client-Platform': 'web',
    'User-Agent': 'MonarchMoneyAPI (https://github.com/hammem/monarchmoney)',
}


class AuthError(Exception):
    """Raised when Monarch rejects the stored session (expired / revoked)."""


# ── Credential storage (Apple Keychain via keyring) ───────────────────────────
# keyring talks to the Security framework directly, so the secret never appears
# in a process argument list (unlike `security add-generic-password -w <secret>`).
# It reads/writes the same service/account pair the original implementation used.

def keychain_save(token: str) -> bool:
    try:
        keyring.set_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token)
        return True
    except KeyringError:
        return False


def keychain_load() -> str | None:
    try:
        return keyring.get_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) or None
    except KeyringError:
        return None


def keychain_delete() -> None:
    try:
        keyring.delete_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    except (PasswordDeleteError, KeyringError):
        pass

# ── HTTP ──────────────────────────────────────────────────────────────────────

class NetworkError(Exception):
    """The request never got a usable response (timeout / connection failure)."""


@dataclass
class HttpResponse:
    status: int
    reason: str
    headers: dict
    body: bytes
    cookies: dict  # Set-Cookie name -> value (dict(headers) would drop repeated Set-Cookie lines)

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def text(self) -> str:
        return self.body.decode('utf-8', 'replace')

    def json(self):
        return json.loads(self.body)


async def http_request(method: str, url: str, **kwargs) -> HttpResponse:
    """One HTTP request, IPv4 first.

    On some networks the IPv6 route to Cloudflare (which fronts Monarch) intermittently
    stalls for 5-30 s even though IPv4 answers in ~100 ms. Happy Eyeballs doesn't help
    because the IPv6 TCP connect itself succeeds. So try IPv4, and only fall back to the
    system default (e.g. IPv6-only networks) when IPv4 can't connect at all.
    """
    last_error: Exception | None = None
    for family in (socket.AF_INET, 0):
        try:
            connector = aiohttp.TCPConnector(family=family)
            async with aiohttp.ClientSession(connector=connector, timeout=HTTP_TIMEOUT) as session:
                async with session.request(method, url, allow_redirects=False, **kwargs) as resp:
                    return HttpResponse(resp.status, resp.reason or '', dict(resp.headers), await resp.read(),
                                        {name: morsel.value for name, morsel in resp.cookies.items()})
        except aiohttp.ClientConnectorError as e:
            last_error = e
            continue
        except asyncio.TimeoutError:
            host = url.split('/')[2]
            raise NetworkError(f'Timed out waiting for {host} (no response in {int(HTTP_TIMEOUT.total)} s). '
                               'Check your connection or VPN and try again.') from None
        except aiohttp.ClientError as e:
            raise NetworkError(f'Network error talking to {url.split("/")[2]}: {e}') from None
    raise NetworkError(f'Could not connect to {url.split("/")[2]}: {last_error}')


def describe(e: Exception) -> str:
    """Exception text that is never empty (TimeoutError() stringifies to '')."""
    return str(e) or type(e).__name__

# ── Monarch API Calls ─────────────────────────────────────────────────────────

async def monarch_login(email: str, password: str, mfa_secret: str | None = None) -> str:
    """Login to Monarch and return auth token. Raises on failure."""
    import oathtool

    payload = {
        'username': email,
        'password': password,
        'supports_mfa': True,
        'trusted_device': False,
    }
    if mfa_secret:
        clean_mfa = mfa_secret.strip().replace(' ', '')
        if clean_mfa.isdigit() and len(clean_mfa) == 6:
            payload['totp'] = clean_mfa
        else:
            payload['totp'] = oathtool.generate_otp(clean_mfa)

    resp = await http_request('POST', MONARCH_LOGIN, json=payload, headers=BASE_HEADERS)
    try:
        body = resp.json()
    except ValueError:
        raise ValueError(f'Login failed (HTTP {resp.status}): {error_detail(resp)}') from None

    if resp.status == 403:
        if isinstance(body, dict) and body.get('detail') == 'MFA_REQUIRED':
            raise ValueError('MFA_REQUIRED')
        raise ValueError(f'Login blocked (HTTP 403): {error_detail(resp)}')
    if resp.status != 200:
        raise ValueError(f'Login failed (HTTP {resp.status}): {error_detail(resp)}')
    token = body.get('token') if isinstance(body, dict) else None
    if not token:
        raise ValueError('Login succeeded but no token was returned.')
    return token


def encode_session(cookie_or_token: str, user_agent: str | None = None, endpoint: str | None = None) -> str:
    """Serialize what we store in the Keychain.

    Sessions captured from the browser carry the browser's User-Agent (Cloudflare ties
    some cookies to it) and the API endpoint the cookies belong to. A bare string is
    kept for manually pasted cookies / legacy tokens.
    """
    if endpoint is not None and endpoint not in MONARCH_GRAPHQL_ENDPOINTS:
        raise ValueError(f'Unsupported Monarch endpoint: {endpoint}')
    if not user_agent and not endpoint:
        return cookie_or_token
    return json.dumps({'v': 1, 'cookie': cookie_or_token, 'user_agent': user_agent, 'endpoint': endpoint})


def decode_session(stored: str) -> dict:
    """Inverse of encode_session. Returns {'credential', 'user_agent', 'endpoint'}."""
    if stored.startswith('{'):
        try:
            data = json.loads(stored)
            return {'credential': data.get('cookie') or '',
                    'user_agent': data.get('user_agent'),
                    'endpoint': data.get('endpoint')}
        except json.JSONDecodeError:
            pass
    return {'credential': stored, 'user_agent': None, 'endpoint': None}


def is_cookie_session(credential: str) -> bool:
    return 'session_id=' in credential or 'csrftoken=' in credential


def parse_auth_headers(auth_data: str) -> tuple[dict, str]:
    """Returns (headers, endpoint_url) for a stored session (cookie or legacy token)."""
    session = decode_session(auth_data)
    credential = session['credential']
    headers = {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Client-Platform': 'web',
        'monarch-client': 'monarch-core-web-app-graphql',
        'User-Agent': session['user_agent'] or DEFAULT_USER_AGENT,
    }

    if is_cookie_session(credential):
        headers['Cookie'] = credential
        headers['Origin'] = APP_ORIGIN
        headers['Referer'] = APP_ORIGIN + '/'
        for part in credential.split(';'):
            part = part.strip()
            if part.startswith('csrftoken='):
                headers['X-Csrftoken'] = part.split('=', 1)[1]
                break
    else:
        headers['Authorization'] = f'Token {credential}'

    return headers, API_ENDPOINT


def set_cookie(cookie_header: str, name: str, value: str) -> str:
    """Return cookie_header with `name` set to `value` (replacing any existing value)."""
    parts = [p.strip() for p in cookie_header.split(';') if p.strip() and not p.strip().startswith(name + '=')]
    return '; '.join([*parts, f'{name}={value}'])


async def refresh_csrf(headers: dict) -> None:
    """Get a CSRF token the way Monarch's web app does and add it to `headers`.

    The web app calls GET /auth/csrf/ on load, which sets a `csrftoken` cookie, then
    echoes it in an X-CSRFToken header. Django (Monarch's backend) requires that pair
    for cookie-authenticated POSTs. Browsers sometimes don't have the cookie (expired,
    cleared), which shows up as "CSRF Failed: CSRF cookie not set".
    """
    csrf_headers = {k: v for k, v in headers.items() if k in ('Cookie', 'User-Agent', 'Origin', 'Referer', 'Client-Platform')}
    resp = await http_request('GET', CSRF_ENDPOINT, headers=csrf_headers)
    token = resp.cookies.get('csrftoken')
    if not resp.ok or not token:
        raise ValueError(f'Could not get a CSRF token from Monarch (HTTP {resp.status}).')
    headers['Cookie'] = set_cookie(headers['Cookie'], 'csrftoken', token)
    headers['X-Csrftoken'] = token


def is_csrf_failure(resp: HttpResponse) -> bool:
    return resp.status == 403 and 'csrf' in error_detail(resp).lower()


async def monarch_graphql(token_or_cookie: str, query: str, variables: dict | None = None) -> dict:
    """Execute a GraphQL query against Monarch supporting both Cookie and Token auth."""
    headers, endpoint = parse_auth_headers(token_or_cookie)
    payload = {'query': query, 'variables': variables or {}}
    uses_cookies = 'Cookie' in headers

    if uses_cookies and 'X-Csrftoken' not in headers:
        await refresh_csrf(headers)
    resp = await http_request('POST', endpoint, json=payload, headers=headers)
    if uses_cookies and is_csrf_failure(resp):
        # Token was stale or rotated: fetch a fresh one and try once more.
        await refresh_csrf(headers)
        resp = await http_request('POST', endpoint, json=payload, headers=headers)

    if resp.status in (401, 403):
        detail = error_detail(resp)
        if resp.status == 401 or looks_like_auth_failure(detail):
            raise AuthError(f'HTTP {resp.status}: {detail}')
        raise ValueError(f'Monarch refused the request (HTTP 403: {detail})')
    if 300 <= resp.status < 400:
        raise ValueError(f'Monarch API redirected (HTTP {resp.status}) to {resp.headers.get("Location")}')
    if not resp.ok:
        raise ValueError(f'Monarch API error (HTTP {resp.status}): {error_detail(resp)}')
    try:
        data = resp.json()
    except ValueError:
        raise ValueError(f'Monarch returned a non-JSON response (HTTP {resp.status}).') from None
    if data.get('errors'):
        messages = [e.get('message', str(e)) for e in data['errors']]
        if any('unauthenticated' in m.lower() or 'not authenticated' in m.lower() for m in messages):
            raise AuthError('Monarch session is not authenticated.')
        raise ValueError(f'GraphQL errors: {messages}')
    return data


def error_detail(resp: HttpResponse) -> str:
    """Short, human-readable reason from an error response (never echoes request headers)."""
    text = resp.text()
    try:
        body = json.loads(text)
        if isinstance(body, dict) and body.get('detail'):
            return str(body['detail'])[:200]
    except json.JSONDecodeError:
        pass
    if 'cloudflare' in text.lower():
        return 'blocked by Cloudflare bot protection'
    return ' '.join(text.split())[:120] or resp.reason or 'no details'


def looks_like_auth_failure(detail: str) -> bool:
    d = detail.lower()
    return any(k in d for k in ('credentials', 'authenticat', 'invalid token', 'session'))


async def get_exchange_rate() -> float:
    resp = await http_request('GET', EXCHANGE_API)
    if not resp.ok:
        raise ValueError(f'Exchange rate API error (HTTP {resp.status})')
    data = resp.json()
    rate = (data.get('rates') or {}).get('USD')
    if not isinstance(rate, (int, float)) or rate <= 0:
        raise ValueError('Exchange rate API did not return a valid JPY→USD rate.')
    return float(rate)

# ── Action Handlers ───────────────────────────────────────────────────────────

def _session_rejected(err: AuthError, from_browser: bool) -> dict:
    """Monarch didn't accept the session we sent.

    Only the Keychain copy is deleted, and only when it was the one that failed, so a bad
    browser cookie never wipes a working saved session.
    """
    if from_browser:
        message = ('Monarch did not accept the session from this browser '
                   f'({err}). Log out of Monarch and back in, then click Connect.')
    else:
        keychain_delete()
        message = f'Saved Monarch session expired ({err}). Log into Monarch in this browser, then click Connect.'
    return {'success': False, 'error': 'token_expired', 'session_source': 'browser' if from_browser else 'keychain',
            'detail': str(err), 'message': message}


async def handle_ping() -> dict:
    token = keychain_load()
    return {
        'success': True,
        'has_session': token is not None,
        'host_version': HOST_VERSION,
        'message': 'Native host running' + (' (logged in)' if token else ' (not logged in)')
    }


async def handle_login(email: str, password: str, mfa_secret: str | None = None) -> dict:
    if not email or not password:
        return {'success': False, 'error': 'missing_credentials', 'message': 'Email and password are required.'}
    try:
        token = await monarch_login(email, password, mfa_secret)
        if keychain_save(token):
            return {'success': True, 'message': 'Logged in! Session saved to Apple Keychain.'}
        return {'success': False, 'error': 'keychain_save_failed', 'message': 'Login OK but could not save to Keychain.'}
    except ValueError as e:
        msg = str(e)
        if msg == 'MFA_REQUIRED':
            return {'success': False, 'error': 'mfa_required', 'message': 'MFA required. Provide your TOTP secret key or current 6-digit code.'}
        return {'success': False, 'error': 'login_failed', 'message': msg}
    except Exception as e:
        return {'success': False, 'error': 'login_error', 'message': describe(e)}


async def handle_get_accounts(token: str | None = None) -> dict:
    from_browser = token is not None
    token = token or keychain_load()
    if not token:
        return {'success': False, 'error': 'not_logged_in', 'message': 'Not logged in. Save session cookie or token first.'}

    query = '''
    query GetAccounts {
      accounts {
        id
        displayName
        currentBalance
        isManual
      }
    }
    '''
    try:
        data = await monarch_graphql(token, query)
    except AuthError as e:
        return _session_rejected(e, from_browser)
    except Exception as e:
        return {'success': False, 'error': 'fetch_failed', 'message': describe(e)}

    all_accounts = (data.get('data') or {}).get('accounts') or []
    manual = [
        {'id': a['id'], 'displayName': a.get('displayName') or '', 'currentBalance': a.get('currentBalance') or 0}
        for a in all_accounts if a.get('isManual')
    ]
    return {'success': True, 'accounts': manual}


def pick_default_account(accounts: list[dict]) -> dict | None:
    """Return the first manual account whose name looks like an SBI / JPY account."""
    for a in accounts:
        name = (a.get('displayName') or '').lower()
        if any(kw in name for kw in ACCOUNT_KEYWORDS):
            return a
    return None


def validate_jpy_balance(value) -> float:
    """Coerce and validate an incoming JPY balance. Raises ValueError if invalid."""
    if value is None or isinstance(value, bool):
        raise ValueError('jpy_balance is required.')
    jpy = float(value)
    if not math.isfinite(jpy) or jpy < 0:
        raise ValueError('jpy_balance must be a non-negative number.')
    return jpy


async def handle_sync(jpy_balance: float, account_id: str | None = None, token: str | None = None) -> dict:
    from_browser = token is not None
    token = token or keychain_load()
    if not token:
        return {'success': False, 'error': 'not_logged_in', 'message': 'Not logged in. Open the extension popup and log in.'}

    try:
        rate = await get_exchange_rate()
    except Exception as e:
        return {'success': False, 'error': 'exchange_rate_failed', 'message': describe(e)}

    usd_balance = round(jpy_balance * rate, 2)

    # Resolve account_id if not given. Never fall back to an arbitrary account:
    # writing a balance to the wrong account silently corrupts the user's data.
    account_name = account_id
    if not account_id:
        data = await handle_get_accounts(token)
        if not data['success']:
            return data
        best = pick_default_account(data['accounts'])
        if best is None:
            return {'success': False, 'error': 'no_account_selected',
                    'message': 'No target account selected. Open the extension popup and choose a Monarch account.'}
        account_id = best['id']
        account_name = best['displayName']

    mutation = '''
    mutation UpdateAccountBalance($input: UpdateAccountMutationInput!) {
      updateAccount(input: $input) {
        account {
          id
          displayName
          currentBalance
          displayBalance
        }
        errors {
          message
          code
        }
      }
    }
    '''
    try:
        data = await monarch_graphql(token, mutation, {'input': {'id': str(account_id), 'displayBalance': float(usd_balance)}})
    except AuthError as e:
        return _session_rejected(e, from_browser)
    except Exception as e:
        return {'success': False, 'error': 'update_failed', 'message': describe(e)}

    result = (data.get('data') or {}).get('updateAccount') or {}
    if result.get('errors'):
        return {'success': False, 'error': 'update_errors', 'message': str(result['errors'])}
    account_name = (result.get('account') or {}).get('displayName') or account_name

    return {
        'success': True,
        'jpy_balance': jpy_balance,
        'usd_balance': usd_balance,
        'rate': rate,
        'account_id': account_id,
        'account_name': account_name,
        'message': f'Updated {account_name} → ${usd_balance:,.2f} USD  (¥{jpy_balance:,.0f} × {rate:.6f})'
    }


async def handle_save_token(token: str, user_agent: str | None = None, endpoint: str | None = None) -> dict:
    clean_token = (token or '').strip()
    if not clean_token:
        return {'success': False, 'error': 'missing_token', 'message': 'Token cannot be empty.'}
    try:
        stored = encode_session(clean_token, user_agent or None, endpoint or None)
    except ValueError as e:
        return {'success': False, 'error': 'invalid_endpoint', 'message': str(e)}
    if keychain_save(stored):
        return {'success': True, 'message': 'Monarch session saved to Apple Keychain.'}
    return {'success': False, 'error': 'keychain_save_failed', 'message': 'Could not save token to Apple Keychain.'}


def session_from_request(request: dict) -> str | None:
    """A session the extension read from the browser's Monarch cookies, sent with the request.

    Preferred over the Keychain copy because it is always the browser's current session.
    Raises ValueError for a malformed session or an unknown endpoint.
    """
    session = request.get('session')
    if not session:
        return None
    if not isinstance(session, dict) or not isinstance(session.get('cookie'), str) or not session['cookie'].strip():
        raise ValueError('Malformed browser session.')
    return encode_session(session['cookie'].strip(), session.get('user_agent'), session.get('endpoint'))


async def handle(request: dict) -> dict:
    action = request.get('action')
    try:
        browser_session = session_from_request(request)
    except ValueError as e:
        return {'success': False, 'error': 'invalid_session', 'message': str(e)}
    if action == 'ping':
        return await handle_ping()
    if action == 'save_token':
        return await handle_save_token(request.get('token', ''), request.get('user_agent'), request.get('endpoint'))
    if action == 'login':
        return await handle_login(
            request.get('email', ''),
            request.get('password', ''),
            request.get('mfa_secret') or None
        )
    if action == 'get_accounts':
        return await handle_get_accounts(browser_session)
    if action == 'sync':
        try:
            jpy = validate_jpy_balance(request.get('jpy_balance'))
        except (TypeError, ValueError) as e:
            return {'success': False, 'error': 'invalid_jpy', 'message': str(e)}
        return await handle_sync(jpy, request.get('account_id') or None, browser_session)
    return {'success': False, 'error': 'unknown_action', 'message': f'Unknown action: {action}'}

# ── Native Messaging I/O ──────────────────────────────────────────────────────

MAX_MESSAGE_BYTES = 1024 * 1024  # Chrome caps extension → host messages at 64 MiB; ours are tiny.


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len or len(raw_len) < 4:
        return None
    msg_len = struct.unpack('=I', raw_len)[0]
    if msg_len > MAX_MESSAGE_BYTES:
        raise ValueError(f'Message too large ({msg_len} bytes)')
    raw_msg = sys.stdin.buffer.read(msg_len)
    return json.loads(raw_msg.decode('utf-8'))


def send_message(msg: dict):
    encoded = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

# ── CLI Entry Point ───────────────────────────────────────────────────────────

def cli_login():
    print('\n🔐 Monarch Money Login')
    print('─' * 40)
    print('Credentials are NOT stored — only the session token goes to Apple Keychain.\n')
    email = input('Monarch Email: ').strip()
    password = getpass.getpass('Monarch Password: ')
    mfa = getpass.getpass('TOTP secret or 6-digit code (leave blank if none): ').strip() or None

    print('\nLogging in...')
    result = asyncio.run(handle_login(email, password, mfa))
    print(json.dumps(result, indent=2))


def cli_save_session():
    # Read with getpass so the cookie is not echoed or left in shell history.
    t = getpass.getpass('Paste Monarch Session Cookie or Token (input hidden): ').strip()
    if not t:
        print('Session data cannot be empty.')
        return
    print('✅ Session saved to Apple Keychain!' if keychain_save(t) else '❌ Failed to save session to Apple Keychain.')


def main():
    if len(sys.argv) > 1 and sys.argv[1].startswith('--'):
        flag = sys.argv[1]
        if flag == '--login':
            cli_login()
            return
        if flag in ('--token', '--cookie', '--session'):
            cli_save_session()
            return
        if flag == '--logout':
            keychain_delete()
            print('Session removed from Keychain.')
            return
        if flag == '--status':
            print('Logged in (session in Keychain).' if keychain_load() else 'Not logged in.')
            return

    # Native Messaging mode (Chrome passes the caller origin, e.g. chrome-extension://..., as argv[1])
    while True:
        try:
            request = read_message()
            if request is None:
                break
            result = asyncio.run(handle(request))
            send_message(result)
        except Exception:
            traceback.print_exc(file=sys.stderr)  # Chrome logs host stderr; keep details out of the UI
            send_message({'success': False, 'error': 'host_exception',
                          'message': 'Native host error. Check the browser log for details.'})


if __name__ == '__main__':
    main()
