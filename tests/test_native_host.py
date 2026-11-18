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
    assert endpoint == 'https://api.monarchmoney.com/graphql'
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


def test_expired_session_clears_keychain(monkeypatch):
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
    assert endpoint == 'https://api.monarchmoney.com/graphql'
    assert headers['User-Agent'] == 'TestUA/1.0'
    assert headers['Origin'] == 'https://app.monarchmoney.com'
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
