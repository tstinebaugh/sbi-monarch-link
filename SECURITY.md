# Security Policy

This tool handles a Monarch Money session cookie and reads your bank balance, so security reports are very welcome.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository.

## Handling your own data

- Never paste your Monarch session cookie, password, or TOTP secret into an issue, PR, or log.
- If you think your session cookie has leaked, log out of Monarch on all devices (this revokes the session) and run
  `python3 native-host/sbi_monarch_host.py --logout`.
