# Security Policy

## Scope

This project is a paper-trading MVP. It intentionally does not store Binany passwords, session cookies, or live-order credentials.

## Reporting a vulnerability

Do not publish credentials, tokens, private keys, or exploit details in a public issue. Contact the repository owner privately through GitHub with a clear description and reproduction steps.

## Secret-handling rules

- Never commit `.env` files.
- Never commit API keys, passwords, session tokens, cookies, or private keys.
- Use environment variables or a secret manager for sensitive configuration.
- Keep `PAPER_MODE=true` until an authorized production integration has been reviewed.
