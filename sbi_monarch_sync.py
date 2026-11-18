#!/usr/bin/env python3
"""
SBI Shinsei to Monarch Money Balance Syncer (CLI)
-------------------------------------------------
Converts a JPY balance to USD at the live spot rate and writes it to a manual
account in Monarch Money, using the same Keychain session as the browser
extension's native host.

First save a session once:
    python3 native-host/sbi_monarch_host.py --session

Then:
    python3 sbi_monarch_sync.py --jpy 1234567 [--account-id 123456789]
"""

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / 'native-host'))

import sbi_monarch_host as host  # noqa: E402


def parse_jpy(raw: str) -> float:
    return host.validate_jpy_balance(raw.replace(',', '').replace('¥', '').strip())


def main() -> int:
    parser = argparse.ArgumentParser(description='Sync an SBI Shinsei JPY balance (converted to USD) to Monarch Money')
    parser.add_argument('--jpy', type=str, help='SBI Shinsei balance in JPY (commas allowed)')
    parser.add_argument('--account-id', type=str, default=None,
                        help='Monarch manual account ID (defaults to the first manual account named like SBI/Shinsei/Japan/Yen)')
    parser.add_argument('--list-accounts', action='store_true', help='List manual Monarch accounts and exit')
    args = parser.parse_args()

    if args.list_accounts:
        result = asyncio.run(host.handle_get_accounts())
        if not result['success']:
            print(f"❌ {result['message']}")
            return 1
        for a in result['accounts']:
            print(f"{a['id']}\t{a['displayName']}\t${a['currentBalance']:,.2f}")
        return 0

    try:
        jpy = parse_jpy(args.jpy if args.jpy is not None else input('Current SBI Shinsei balance in JPY (¥): '))
    except (TypeError, ValueError):
        print('Invalid JPY amount.')
        return 1

    result = asyncio.run(host.handle_sync(jpy, args.account_id))
    print(('✅ ' if result['success'] else '❌ ') + result['message'])
    return 0 if result['success'] else 1


if __name__ == '__main__':
    sys.exit(main())
