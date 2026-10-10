# Contributing

## Development

1. Install Node.js 22+ and npm.
2. Run `npm install`.
3. Copy `.env.example` to `.env` if you want to customize local settings.
4. Run `npm run dev` to start the local dashboard.
5. Run `npm run build` before submitting a pull request.
6. Keep `.env` files and all credentials out of source control.

## Pull requests

- Explain behavior changes and include reproducible test steps.
- Clearly label mock/simulated market data; never present it as a live quote.
- Do not add browser automation or credential-based broker execution.
- Preserve paper-trading-only behavior unless an authorized API integration is separately documented and security-reviewed.
