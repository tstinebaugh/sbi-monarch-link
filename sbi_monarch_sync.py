#!/usr/bin/env python3
"""
SBI Shinsei to Monarch Money Balance Syncer
-------------------------------------------
Fetches live JPY -> USD exchange rate, converts SBI Shinsei account balance (in Yen),
and updates a manual account in Monarch Money.
"""

import sys
import argparse
import asyncio
import requests
from monarchmoney import MonarchMoney

EXCHANGE_RATE_API = "https://open.er-api.com/v6/latest/JPY"

def get_jpy_to_usd_rate() -> float:
    """Fetch current JPY to USD exchange rate."""
    response = requests.get(EXCHANGE_RATE_API, timeout=10)
    response.raise_for_status()
    data = response.json()
    rate = data.get("rates", {}).get("USD")
    if not rate:
        raise ValueError("Could not fetch USD exchange rate from API")
    return rate

async def sync_to_monarch(email: str, password: str, account_id: str, jpy_balance: float, mfa_secret: str = None):
    """Log into Monarch Money and update manual account balance."""
    mm = MonarchMoney()
    
    print("Logging into Monarch Money...")
    if mfa_secret:
        await mm.login(email=email, password=password, mfa_secret_key=mfa_secret)
    else:
        await mm.login(email=email, password=password)

    rate = get_jpy_to_usd_rate()
    usd_balance = round(jpy_balance * rate, 2)
    
    print(f"Current JPY -> USD Rate: 1 JPY = {rate:.6f} USD")
    print(f"Converting ¥{jpy_balance:,.0f} JPY => ${usd_balance:,.2f} USD")

    # Update manual account balance in Monarch
    print(f"Updating Monarch Account ID '{account_id}'...")
    await mm.update_account(account_id=account_id, current_balance=usd_balance)
    print("Successfully updated balance in Monarch Money!")

def main():
    parser = argparse.ArgumentParser(description="Sync SBI Shinsei JPY balance converted to USD in Monarch Money")
    parser.add_argument("--jpy", type=float, help="SBI Shinsei balance in JPY")
    parser.add_argument("--email", type=str, help="Monarch Money email")
    parser.add_argument("--password", type=str, help="Monarch Money password")
    parser.add_argument("--account-id", type=str, help="Monarch Manual Account ID")
    parser.add_argument("--mfa-secret", type=str, help="Optional Monarch MFA secret key", default=None)

    args = parser.parse_args()

    jpy = args.jpy
    if jpy is None:
        try:
            jpy_input = input("Enter current SBI Shinsei balance in JPY (¥): ").replace(",", "").strip()
            jpy = float(jpy_input)
        except ValueError:
            print("Invalid JPY amount entered.")
            sys.exit(1)

    email = args.email or input("Monarch Email: ").strip()
    password = args.password or input("Monarch Password: ").strip()
    account_id = args.account_id or input("Monarch Manual Account ID: ").strip()

    asyncio.run(sync_to_monarch(email, password, account_id, jpy, args.mfa_secret))

if __name__ == "__main__":
    main()
