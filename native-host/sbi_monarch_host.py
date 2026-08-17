#!/usr/bin/env python3
"""
SBI Monarch Native Messaging Host
----------------------------------
Chrome calls this script via Native Messaging.
Uses direct aiohttp to call api.monarch.com (library hardcodes old domain).
Stores session token securely in Apple Keychain via macOS `security` CLI.

Communication: 4-byte length-prefixed JSON over stdin/stdout.
CLI usage: python3 sbi_monarch_host.py --login
"""

import sys
import json
import struct
import asyncio
import subprocess
import traceback
import getpass

import aiohttp

# ── Constants ─────────────────────────────────────────────────────────────────

MONARCH_API     = 'https://api.monarchmoney.com/graphql'
MONARCH_LOGIN   = 'https://api.monarchmoney.com/auth/login/'
EXCHANGE_API    = 'https://open.er-api.com/v6/latest/JPY'

KEYCHAIN_SERVICE = 'sbi-monarch-link'
KEYCHAIN_ACCOUNT = 'monarch_session_token'

BASE_HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Client-Platform': 'web',
    'User-Agent': 'MonarchMoneyAPI (https://github.com/hammem/monarchmoney)',
}

# ── Apple Keychain ─────────────────────────────────────────────────────────────

def keychain_save(token: str) -> bool:
    """Store token in Apple Keychain. Overwrites existing entry."""
    # Delete old entry first (ignore errors)
    subprocess.run(
        ['security', 'delete-generic-password',
         '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
        capture_output=True
    )
    result = subprocess.run(
        ['security', 'add-generic-password',
         '-s', KEYCHAIN_SERVICE,
         '-a', KEYCHAIN_ACCOUNT,
         '-w', token,
         '-U'],  # Update if already exists
        capture_output=True, text=True
    )
    return result.returncode == 0

def keychain_load() -> str | None:
    """Load token from Apple Keychain. Returns None if not found."""
    result = subprocess.run(
        ['security', 'find-generic-password',
         '-s', KEYCHAIN_SERVICE,
         '-a', KEYCHAIN_ACCOUNT,
         '-w'],  # -w = print password only
        capture_output=True, text=True
    )
    if result.returncode == 0:
        return result.stdout.strip() or None
    return None

def keychain_delete():
    subprocess.run(
        ['security', 'delete-generic-password',
         '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
        capture_output=True
    )

# ── Monarch API Calls ─────────────────────────────────────────────────────────

async def monarch_login(email: str, password: str, mfa_secret: str = None) -> str:
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

    async with aiohttp.ClientSession() as session:
        async with session.post(MONARCH_LOGIN, json=payload, headers=BASE_HEADERS) as resp:
            try:
                body = await resp.json(content_type=None)
            except Exception:
                raw = await resp.text()
                raise ValueError(f'Server returned non-JSON HTTP {resp.status}: {raw[:150]}')

            if resp.status == 403:
                if isinstance(body, dict) and body.get('detail') == 'MFA_REQUIRED':
                    raise ValueError('MFA_REQUIRED')
                detail = body.get('detail', body) if isinstance(body, dict) else body
                raise ValueError(f'Login blocked HTTP 403: {detail}')
            if resp.status != 200:
                detail = body.get('detail', resp.reason) if isinstance(body, dict) else resp.reason
                raise ValueError(f'Login failed HTTP {resp.status}: {detail}')
            token = body.get('token') if isinstance(body, dict) else None
            if not token:
                raise ValueError(f'No token in response: {body}')
            return token

def parse_auth_headers(auth_data: str) -> tuple[dict, str]:
    """Returns (headers, endpoint_url) supporting both modern Cookie sessions and legacy Tokens."""
    headers = {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Client-Platform': 'web',
        'monarch-client': 'monarch-core-web-app-graphql',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    }

    if 'session_id=' in auth_data or 'csrftoken=' in auth_data:
        endpoint = 'https://api.monarch.com/graphql'
        headers['Cookie'] = auth_data
        headers['Origin'] = 'https://app.monarch.com'
        headers['Referer'] = 'https://app.monarch.com/'
        for part in auth_data.split(';'):
            part = part.strip()
            if part.startswith('csrftoken='):
                headers['X-Csrftoken'] = part.split('=', 1)[1]
                break
    else:
        endpoint = 'https://api.monarchmoney.com/graphql'
        headers['Authorization'] = f'Token {auth_data}'

    return headers, endpoint

async def monarch_graphql(token_or_cookie: str, query: str, variables: dict = None) -> dict:
    """Execute a GraphQL query against Monarch supporting both Cookie and Token auth."""
    headers, endpoint = parse_auth_headers(token_or_cookie)
    payload = {'query': query, 'variables': variables or {}}

    async with aiohttp.ClientSession() as session:
        async with session.post(endpoint, json=payload, headers=headers) as resp:
            data = await resp.json(content_type=None)
            if not resp.ok:
                raise ValueError(f'GraphQL HTTP {resp.status}: {resp.reason}')
            if data.get('errors'):
                raise ValueError(f'GraphQL errors: {data["errors"]}')
            return data

async def get_exchange_rate() -> float:
    async with aiohttp.ClientSession() as session:
        async with session.get(EXCHANGE_API, timeout=aiohttp.ClientTimeout(total=10)) as r:
            data = await r.json(content_type=None)
            return data['rates']['USD']

# ── Action Handlers ───────────────────────────────────────────────────────────

async def handle_ping() -> dict:
    token = keychain_load()
    return {
        'success': True,
        'has_session': token is not None,
        'message': 'Native host running' + (' (logged in)' if token else ' (not logged in)')
    }

async def handle_login(email: str, password: str, mfa_secret: str = None) -> dict:
    try:
        token = await monarch_login(email, password, mfa_secret)
        if keychain_save(token):
            return {'success': True, 'message': 'Logged in! Session saved to Apple Keychain.'}
        else:
            return {'success': False, 'error': 'keychain_save_failed', 'message': 'Login OK but could not save to Keychain.'}
    except ValueError as e:
        msg = str(e)
        if msg == 'MFA_REQUIRED':
            return {'success': False, 'error': 'mfa_required', 'message': 'MFA required. Provide your TOTP secret key.'}
        return {'success': False, 'error': 'login_failed', 'message': msg}
    except Exception as e:
        return {'success': False, 'error': 'login_error', 'message': traceback.format_exc()}

async def handle_get_accounts() -> dict:
    token = keychain_load()
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
        all_accounts = data.get('data', {}).get('accounts', [])
        manual = [
            {'id': a['id'], 'displayName': a.get('displayName', ''), 'currentBalance': a.get('currentBalance', 0)}
            for a in all_accounts if a.get('isManual')
        ]
        # If no explicit isManual accounts exist, return all accounts so user can choose
        if not manual:
            manual = [
                {'id': a['id'], 'displayName': a.get('displayName', ''), 'currentBalance': a.get('currentBalance', 0)}
                for a in all_accounts
            ]
        return {'success': True, 'accounts': manual}
    except Exception as e:
        # Token/Cookie might be expired — clear it
        if '401' in str(e) or 'Unauthorized' in str(e):
            keychain_delete()
            return {'success': False, 'error': 'token_expired', 'message': 'Session expired. Please update session cookie.'}
        return {'success': False, 'error': 'fetch_failed', 'message': str(e)}

async def handle_sync(jpy_balance: float, account_id: str = None) -> dict:
    token = keychain_load()
    if not token:
        return {'success': False, 'error': 'not_logged_in', 'message': 'Not logged in. Open the extension popup and log in.'}

    # Get exchange rate
    try:
        rate = await get_exchange_rate()
    except Exception as e:
        return {'success': False, 'error': 'exchange_rate_failed', 'message': str(e)}

    usd_balance = round(jpy_balance * rate, 2)

    # Resolve account_id if not given
    account_name = account_id
    if not account_id:
        data = await handle_get_accounts()
        if not data['success']:
            return data
        accounts = data['accounts']
        if not accounts:
            return {'success': False, 'error': 'no_manual_accounts', 'message': 'No manual accounts found in Monarch.'}
        best = next(
            (a for a in accounts if any(kw in a['displayName'].lower() for kw in ['sbi', 'shinsei', 'japan', 'yen'])),
            accounts[0]
        )
        account_id = best['id']
        account_name = best['displayName']

    # Update balance
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
        errors = data.get('data', {}).get('updateAccount', {}).get('errors', [])
        if errors:
            return {'success': False, 'error': 'update_errors', 'message': str(errors)}
    except Exception as e:
        if '401' in str(e) or 'Unauthorized' in str(e):
            keychain_delete()
            return {'success': False, 'error': 'token_expired', 'message': 'Session expired. Please log in again.'}
        return {'success': False, 'error': 'update_failed', 'message': str(e)}

    return {
        'success': True,
        'jpy_balance': jpy_balance,
        'usd_balance': usd_balance,
        'rate': rate,
        'account_id': account_id,
        'account_name': account_name,
        'message': f'Updated {account_name} → ${usd_balance:,.2f} USD  (¥{jpy_balance:,.0f} × {rate:.6f})'
    }

# ── Native Messaging I/O ──────────────────────────────────────────────────────

def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len or len(raw_len) < 4:
        return None
    msg_len = struct.unpack('I', raw_len)[0]
    raw_msg = sys.stdin.buffer.read(msg_len)
    return json.loads(raw_msg.decode('utf-8'))

def send_message(msg: dict):
    encoded = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

async def handle_save_token(token: str) -> dict:
    clean_token = token.strip()
    if not clean_token:
        return {'success': False, 'error': 'missing_token', 'message': 'Token cannot be empty.'}
    if keychain_save(clean_token):
        return {'success': True, 'message': 'Session token saved to Apple Keychain!'}
    return {'success': False, 'error': 'keychain_save_failed', 'message': 'Could not save token to Apple Keychain.'}

async def handle(request: dict) -> dict:
    action = request.get('action')
    if action == 'ping':
        return await handle_ping()
    elif action == 'save_token':
        return await handle_save_token(request.get('token', ''))
    elif action == 'login':
        return await handle_login(
            request.get('email', ''),
            request.get('password', ''),
            request.get('mfa_secret') or None
        )
    elif action == 'get_accounts':
        return await handle_get_accounts()
    elif action == 'sync':
        jpy = request.get('jpy_balance')
        if not jpy:
            return {'success': False, 'error': 'missing_jpy', 'message': 'jpy_balance required'}
        return await handle_sync(float(jpy), request.get('account_id'))
    else:
        return {'success': False, 'error': 'unknown_action', 'message': f'Unknown: {action}'}

# ── CLI Entry Point ───────────────────────────────────────────────────────────

def cli_login():
    print('\n🔐 Monarch Money Login')
    print('─' * 40)
    print('Credentials are NOT stored — only the session token goes to Apple Keychain.\n')
    email = input('Monarch Email: ').strip()
    password = getpass.getpass('Monarch Password: ')
    mfa = input('TOTP MFA Secret Key (leave blank if none): ').strip() or None

    print('\nLogging in...')
    result = asyncio.run(handle_login(email, password, mfa))
    print(json.dumps(result, indent=2))

def main():
    if len(sys.argv) > 1 and sys.argv[1].startswith('--'):
        if sys.argv[1] == '--login':
            cli_login()
            return
        elif sys.argv[1] in ('--token', '--cookie', '--session'):
            if len(sys.argv) > 2:
                t = sys.argv[2].strip()
            else:
                t = input('Paste Monarch Session Cookie or Token: ').strip()
            if t:
                if keychain_save(t):
                    print('✅ Session saved to Apple Keychain!')
                else:
                    print('❌ Failed to save session to Apple Keychain.')
            else:
                print('Session data cannot be empty.')
            return
        elif sys.argv[1] == '--logout':
            keychain_delete()
            print('Session removed from Keychain.')
            return
        elif sys.argv[1] == '--status':
            token = keychain_load()
            print('Logged in (session in Keychain).' if token else 'Not logged in.')
            return

    # Native Messaging mode (handles chrome-extension://... arguments from browser)
    while True:
        try:
            request = read_message()
            if request is None:
                break
            result = asyncio.run(handle(request))
            send_message(result)
        except Exception:
            send_message({'success': False, 'error': 'host_exception', 'message': traceback.format_exc()})

if __name__ == '__main__':
    main()
