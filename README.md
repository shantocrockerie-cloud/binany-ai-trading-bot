# CODEX AI MARKET — Binany AI Trading-Bot MVP v2

Mobile-first signal dashboard matching the supplied screen-recording concept: REAL/OTC selector, asset/timeframe/expiry, strategy toggles, staged analysis status, CALL/PUT/WAIT, confidence, indicator readout and risk guard.

> **Important:** This repository is a paper-trading MVP. It does not log in to Binany, scrape the platform, simulate browser clicks, or place live orders.

## Features

- FastAPI backend with a single-page mobile-first frontend.
- REAL MARKET mode using public Binance candles for development/testing.
- OTC mode accepts only explicitly supplied authorized OTC candles; it never fabricates OTC prices.
- EMA 9/21 + RSI 14 confluence.
- Bollinger Bands.
- Price-action confirmation.
- Recent support/resistance detection.
- CALL / PUT / WAIT signal classification.
- Confidence score and indicator readout.
- Paper-trade risk guard with max stake, daily loss limit, daily trade cap and cooldown.
- Termux-friendly one-command startup.

## Architecture

```text
Android / Browser
       │
       ▼
FastAPI :8000
 ┌───────────────┐
 │ Web dashboard │
 └───────┬───────┘
         │
         ├── Market data → Binance public candles (REAL)
         │
         ├── Authorized OTC feed (OTC, supplied explicitly)
         │
         ▼
 Indicator / Confluence Engine
         │
         ▼
 CALL / PUT / WAIT + confidence
         │
         ▼
      Risk Guard
         │
         ▼
    PAPER TRADE ONLY
```

## Project structure

```text
binany-ai-trading-bot/
├── app/
│   ├── __init__.py
│   ├── main.py
│   └── static/
│       └── index.html
├── .env.example
├── .gitignore
├── Makefile
├── README.md
├── requirements.txt
└── start-termux.sh
```

## Run on Termux

```bash
pkg update -y
pkg install python unzip -y
cd ~/binany-ai-trading-bot
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open on the same Android device:

```text
http://127.0.0.1:8000
```

Health check:

```text
http://127.0.0.1:8000/health
```

### One-command startup

After the first dependency installation:

```bash
bash start-termux.sh
```

Do **not** run `start-termux.sh` without `bash` unless it has executable permission.

## If you extracted the ZIP from Downloads

```bash
cd ~/storage/downloads
unzip -o binany-ai-trading-bot-v2.zip -d ~/
cd ~/binany-ai-trading-bot
bash start-termux.sh
```

## Signal pipeline

1. User selects REAL MARKET or OTC.
2. User selects asset, timeframe and expiry.
3. User enables one or more strategies.
4. Backend obtains candles from the configured/authorized source.
5. Indicator engine calculates EMA, RSI, Bollinger Bands, recent range levels and candle direction.
6. Confluence engine scores bullish/bearish evidence.
7. Engine returns CALL, PUT or WAIT plus confidence and reasons.
8. Risk guard can accept a paper-trade request only when stake, cooldown and daily limits pass.

## API

### `GET /health`

Returns service and paper-mode status.

### `GET /api/candles`

Query parameters:

- `symbol`: e.g. `BTCUSDT`
- `timeframe`: `1m`, `5m`, or `15m`

### `POST /api/signal`

Example:

```json
{
  "symbol": "BTCUSDT",
  "timeframe": "1m",
  "expiry_seconds": 60,
  "market": "REAL",
  "strategies": [
    "ema_rsi",
    "price_action",
    "bollinger",
    "support_resistance"
  ]
}
```

For OTC mode, an authorized candle list must be supplied explicitly. The application refuses to invent OTC prices.

### `POST /api/paper-trade`

Creates a paper-trade acceptance record after risk checks. It does not send an order to Binany.

## Configuration

Copy `.env.example` to `.env` and adjust risk limits if required.

```text
MAX_STAKE_USD=1.0
DAILY_LOSS_LIMIT_USD=5.0
MAX_TRADES_PER_DAY=20
COOLDOWN_SECONDS=60
PAPER_MODE=true
```

Never commit `.env`, API keys, passwords, session tokens, or other secrets.

## Live Binany integration boundary

A production execution adapter should only be implemented after obtaining an official/authorized Binany API or partner integration contract covering authentication, quotes, order creation, expiry, settlement, errors and rate limits.

Do **not** use the Binany website password as an API credential and do not build browser-click automation as a substitute for an authorized API.

Keep:

```text
PAPER_MODE=true
```

until market data and execution semantics have been independently verified.

## Risk / trading disclaimer

This software generates technical-analysis signals; it does not guarantee profitable trades. Short-expiry/binary-style trading can result in rapid losses. Use paper trading and independent testing before considering any real-money deployment.

## License

No license has been granted yet. Until a license is added, normal copyright restrictions apply.
