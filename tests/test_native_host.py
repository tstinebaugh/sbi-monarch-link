import asyncio
import json
import struct
import sys
from io import BytesIO
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native-host'))
import sbi_monarch_host as host  # noqa: E402


def run(coro):
    return asyncio.run(coro)


# ── parse_auth_headers ────────────────────────────────────────────────────────

def test_cookie_session_uses_new_domain_and_csrf_header():
    headers, endpoint = host.parse_auth_headers('session_id=abc; csrftoken=xyz123; other=1')
    assert endpoint == 'https://api.monarch.com/graphql'
    assert headers['Cookie'] == 'session_id=abc; csrftoken=xyz123; other=1'
    assert headers['X-Csrftoken'] == 'xyz123'
    assert 'Authorization' not in headers


def test_legacy_token_uses_authorization_header():
    headers, endpoint = host.parse_auth_headers('deadbeef')
    assert endpoint == 'https://api.monarch.com/graphql'
    assert headers['Authorization'] == 'Token deadbeef'
    assert 'Cookie' not in headers


# ── validate_jpy_balance ──────────────────────────────────────────────────────

@pytest.mark.parametrize('value, expected', [(0, 0.0), ('1234567', 1234567.0), (12.5, 12.5)])
def test_valid_balances(value, expected):
    assert host.validate_jpy_balance(value) == expected


@pytest.mark.parametrize('value', [None, -1, 'nan', 'inf', 'abc', True])
def test_invalid_balances(value):
    with pytest.raises((TypeError, ValueError)):
        host.validate_jpy_balance(value)


# ── pick_default_account ──────────────────────────────────────────────────────

def test_pick_default_account_matches_keyword():
    accounts = [{'id': '1', 'displayName': 'Chase Checking'}, {'id': '2', 'displayName': 'SBI Shinsei Bank'}]
    assert host.pick_default_account(accounts)['id'] == '2'


def test_pick_default_account_never_guesses():
    assert host.pick_default_account([{'id': '1', 'displayName': 'Chase Checking'}]) is None


# ── handle() dispatch ─────────────────────────────────────────────────────────

def test_sync_rejects_missing_balance():
    res = run(host.handle({'action': 'sync'}))
    assert res['success'] is False and res['error'] == 'invalid_jpy'


def test_unknown_action():
    res = run(host.handle({'action': 'nope'}))
    assert res['error'] == 'unknown_action'


def test_sync_without_account_and_no_match_does_not_write(monkeypatch):
    monkeypatch.setattr(host, 'keychain_load', lambda: 'session_id=x')

    async def fake_rate():
        return 0.0067

    async def fake_accounts(token=None):
        return {'success': True, 'accounts': [{'id': '1', 'displayName': 'Chase Checking', 'currentBalance': 0}]}

    async def fail_graphql(*a, **k):
        raise AssertionError('must not call the update mutation')

    monkeypatch.setattr(host, 'get_exchange_rate', fake_rate)
    monkeypatch.setattr(host, 'handle_get_accounts', fake_accounts)
    monkeypatch.setattr(host, 'monarch_graphql', fail_graphql)

    res = run(host.handle({'action': 'sync', 'jpy_balance': 100000}))
    assert res['error'] == 'no_account_selected'


def test_sync_success_converts_and_reports(monkeypatch):
    monkeypatch.setattr(host, 'keychain_load', lambda: 'session_id=x')
    sent = {}

    async def fake_rate():
        return 0.0067

    async def fake_graphql(token, query, variables=None):
        sent.update(variables)
        return {'data': {'updateAccount': {'account': {'displayName': 'SBI'}, 'errors': []}}}

    monkeypatch.setattr(host, 'get_exchange_rate', fake_rate)
    monkeypatch.setattr(host, 'monarch_graphql', fake_graphql)

    res = run(host.handle({'action': 'sync', 'jpy_balance': 1_000_000, 'account_id': '42'}))
    assert res['success'] is True
    assert res['usd_balance'] == 6700.0
    assert sent == {'input': {'id': '42', 'displayBalance': 6700.0}}


def test_expired_keychain_session_clears_keychain(monkeypatch):
    monkeypatch.setattr(host, 'keychain_load', lambda: 'session_id=x')
    deleted = []
    monkeypatch.setattr(host, 'keychain_delete', lambda: deleted.append(True))

    async def expired(*a, **k):
        raise host.AuthError('expired')

    monkeypatch.setattr(host, 'monarch_graphql', expired)
    res = run(host.handle({'action': 'get_accounts'}))
    assert res['error'] == 'token_expired' and deleted


# ── Native messaging framing ──────────────────────────────────────────────────

def test_message_round_trip(monkeypatch):
    payload = json.dumps({'action': 'ping'}).encode()
    stdin = type('S', (), {'buffer': BytesIO(struct.pack('=I', len(payload)) + payload)})()
    monkeypatch.setattr(sys, 'stdin', stdin)
    assert host.read_message() == {'action': 'ping'}

    out = BytesIO()
    monkeypatch.setattr(sys, 'stdout', type('S', (), {'buffer': out})())
    host.send_message({'ok': True})
    raw = out.getvalue()
    (length,) = struct.unpack('=I', raw[:4])
    assert json.loads(raw[4:4 + length]) == {'ok': True}


def test_oversized_message_rejected(monkeypatch):
    stdin = type('S', (), {'buffer': BytesIO(struct.pack('=I', host.MAX_MESSAGE_BYTES + 1))})()
    monkeypatch.setattr(sys, 'stdin', stdin)
    with pytest.raises(ValueError):
        host.read_message()


# ── Browser-captured sessions ─────────────────────────────────────────────────

def test_browser_session_round_trip_uses_its_endpoint_and_user_agent():
    stored = host.encode_session('session_id=a; csrftoken=b', 'TestUA/1.0', 'https://api.monarchmoney.com/graphql')
    headers, endpoint = host.parse_auth_headers(stored)
    # monarchmoney.com redirects to monarch.com, so requests always go to the new host
    assert endpoint == 'https://api.monarch.com/graphql'
    assert headers['User-Agent'] == 'TestUA/1.0'
    assert headers['Origin'] == 'https://app.monarch.com'
    assert headers['X-Csrftoken'] == 'b'


def test_plain_string_is_stored_unchanged():
    assert host.encode_session('session_id=a') == 'session_id=a'


def test_unknown_endpoint_rejected():
    with pytest.raises(ValueError):
        host.encode_session('session_id=a', 'UA', 'https://evil.example/graphql')


def test_request_session_is_used_instead_of_keychain(monkeypatch):
    monkeypatch.setattr(host, 'keychain_load', lambda: None)
    seen = {}

    async def fake_graphql(token, query, variables=None):
        seen['token'] = token
        return {'data': {'accounts': [{'id': '1', 'displayName': 'SBI', 'currentBalance': 1, 'isManual': True}]}}

    monkeypatch.setattr(host, 'monarch_graphql', fake_graphql)
    res = run(host.handle({'action': 'get_accounts',
                           'session': {'cookie': 'session_id=fresh', 'user_agent': 'UA',
                                       'endpoint': 'https://api.monarch.com/graphql'}}))
    assert res['success'] and res['accounts'][0]['id'] == '1'
    assert host.decode_session(seen['token'])['credential'] == 'session_id=fresh'


def test_malformed_request_session_rejected():
    res = run(host.handle({'action': 'get_accounts', 'session': {'cookie': 5}}))
    assert res['error'] == 'invalid_session'


def test_rejected_browser_session_keeps_keychain(monkeypatch):
    deleted = []
    monkeypatch.setattr(host, 'keychain_delete', lambda: deleted.append(True))

    async def rejected(*a, **k):
        raise host.AuthError('HTTP 401: Authentication credentials were not provided.')

    monkeypatch.setattr(host, 'monarch_graphql', rejected)
    res = run(host.handle({'action': 'get_accounts', 'session': {'cookie': 'session_id=x'}}))
    assert res['error'] == 'token_expired' and res['session_source'] == 'browser'
    assert 'credentials were not provided' in res['message']
    assert not deleted


@pytest.mark.parametrize('detail, is_auth', [
    ('Authentication credentials were not provided.', True),
    ('Invalid token.', True),
    ('CSRF Failed: CSRF token missing.', False),
    ('blocked by Cloudflare bot protection', False),
])
def test_auth_failure_classification(detail, is_auth):
    assert host.looks_like_auth_failure(detail) is is_auth


# ── Network failures are reported, never blank ────────────────────────────────

def test_describe_never_empty():
    assert host.describe(TimeoutError()) == 'TimeoutError'
    assert host.describe(ValueError('boom')) == 'boom'


def test_network_error_message_reaches_ui(monkeypatch):
    async def stalled(*a, **k):
        raise host.NetworkError('Timed out waiting for api.monarch.com (no response in 45 s).')

    monkeypatch.setattr(host, 'monarch_graphql', stalled)
    res = run(host.handle({'action': 'get_accounts', 'session': {'cookie': 'session_id=x'}}))
    assert res['error'] == 'fetch_failed' and 'Timed out' in res['message']


def test_http_request_prefers_ipv4_then_falls_back(monkeypatch):
    families = []

    class FakeConnector:
        def __init__(self, family=0):
            families.append(family)
            self.family = family

    class FakeResp:
        status, reason, headers, cookies = 200, 'OK', {}, {}

        async def read(self):
            return b'{}'

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    class FakeSession:
        def __init__(self, connector, timeout):
            self.connector = connector

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def request(self, *a, **k):
            if self.connector.family == host.socket.AF_INET:
                raise host.aiohttp.ClientConnectorError(None, OSError('no IPv4 route'))
            return FakeResp()

    monkeypatch.setattr(host.aiohttp, 'TCPConnector', FakeConnector)
    monkeypatch.setattr(host.aiohttp, 'ClientSession', FakeSession)
    resp = run(host.http_request('GET', 'https://api.monarch.com/graphql'))
    assert resp.ok and families == [host.socket.AF_INET, 0]


# ── CSRF handling (mirrors Monarch's web app: GET /auth/csrf/ then X-CSRFToken) ──

def _resp(status=200, body=b'{}', cookies=None):
    return host.HttpResponse(status, '', {}, body, cookies or {})


def test_cookie_session_without_csrf_fetches_one(monkeypatch):
    calls = []

    async def fake_request(method, url, **kw):
        calls.append((method, url, dict(kw.get('headers') or {})))
        if url == host.CSRF_ENDPOINT:
            return _resp(cookies={'csrftoken': 'fresh123'})
        h = kw['headers']
        if h.get('X-Csrftoken') != 'fresh123' or 'csrftoken=fresh123' not in h['Cookie']:
            return _resp(403, b'{"detail": "CSRF Failed: CSRF cookie not set."}')
        return _resp(body=b'{"data": {"accounts": []}}')

    monkeypatch.setattr(host, 'http_request', fake_request)
    data = run(host.monarch_graphql('session_id=abc', 'query { accounts { id } }'))
    assert data == {'data': {'accounts': []}}
    assert [c[1] for c in calls] == [host.CSRF_ENDPOINT, host.API_ENDPOINT]
    assert calls[0][2]['Cookie'] == 'session_id=abc'  # session sent when fetching the token


def test_stale_csrf_is_refreshed_once(monkeypatch):
    calls = []

    async def fake_request(method, url, **kw):
        calls.append(url)
        if url == host.CSRF_ENDPOINT:
            return _resp(cookies={'csrftoken': 'new'})
        if kw['headers'].get('X-Csrftoken') == 'old':
            return _resp(403, b'{"detail": "CSRF Failed: CSRF token incorrect."}')
        return _resp(body=b'{"data": {}}')

    monkeypatch.setattr(host, 'http_request', fake_request)
    run(host.monarch_graphql('session_id=abc; csrftoken=old', 'q'))
    assert calls == [host.API_ENDPOINT, host.CSRF_ENDPOINT, host.API_ENDPOINT]


def test_persistent_csrf_failure_is_not_reported_as_expired(monkeypatch):
    async def fake_request(method, url, **kw):
        if url == host.CSRF_ENDPOINT:
            return _resp(cookies={'csrftoken': 't'})
        return _resp(403, b'{"detail": "CSRF Failed: Origin checking failed."}')

    monkeypatch.setattr(host, 'http_request', fake_request)
    with pytest.raises(ValueError, match='CSRF'):
        run(host.monarch_graphql('session_id=abc', 'q'))


def test_set_cookie_replaces_existing_value():
    assert host.set_cookie('session_id=a; csrftoken=old', 'csrftoken', 'new') == 'session_id=a; csrftoken=new'
    assert host.set_cookie('session_id=a', 'csrftoken', 'n') == 'session_id=a; csrftoken=n'
