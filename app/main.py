from __future__ import annotations

import math
import time
import uuid
from datetime import date
from pathlib import Path
from typing import Literal

import httpx
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    max_stake_usd: float = 1.0
    daily_loss_limit_usd: float = 5.0
    max_trades_per_day: int = 20
    cooldown_seconds: int = 60
    paper_mode: bool = True


settings = Settings()
app = FastAPI(title="CODEX AI MARKET — Binany Bot", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class SignalRequest(BaseModel):
    symbol: str = Field(default="BTCUSDT", pattern=r"^[A-Z0-9_/-]{3,20}$")
    timeframe: Literal["1m", "5m", "15m"] = "1m"
    expiry_seconds: int = Field(60, ge=30, le=900)
    market: Literal["REAL", "OTC"] = "REAL"
    strategies: list[Literal["ema_rsi", "price_action", "bollinger", "support_resistance"]] = [
        "ema_rsi", "price_action", "bollinger", "support_resistance"
    ]
    candles: list[dict] | None = None


class PaperTradeRequest(BaseModel):
    signal_id: str
    direction: Literal["CALL", "PUT"]
    stake_usd: float = Field(gt=0, le=1000)


class RiskState:
    def __init__(self):
        self.day = str(date.today())
        self.pnl = 0.0
        self.trades = 0
        self.last_trade_ts = 0.0

    def reset_if_new_day(self):
        today = str(date.today())
        if today != self.day:
            self.day, self.pnl, self.trades, self.last_trade_ts = today, 0.0, 0, 0.0


risk = RiskState()


def clean_candles(candles: list[dict]) -> pd.DataFrame:
    if len(candles) < 30:
        raise HTTPException(400, "At least 30 candles are required")
    df = pd.DataFrame(candles)
    required = ["open", "high", "low", "close"]
    if any(c not in df for c in required):
        raise HTTPException(400, "Candles must contain open, high, low and close")
    for c in required:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=required).reset_index(drop=True)
    if len(df) < 30 or not np.isfinite(df[required].to_numpy()).all():
        raise HTTPException(400, "Invalid candle data")
    return df


def calc_indicators(df: pd.DataFrame) -> dict:
    close = df.close
    ema9 = close.ewm(span=9, adjust=False).mean()
    ema21 = close.ewm(span=21, adjust=False).mean()
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    mid = close.rolling(20).mean()
    std = close.rolling(20).std(ddof=0)
    upper, lower = mid + 2 * std, mid - 2 * std
    last = df.iloc[-1]
    return {
        "close": float(last.close),
        "ema9": float(ema9.iloc[-1]),
        "ema21": float(ema21.iloc[-1]),
        "rsi": float(rsi.iloc[-1]) if math.isfinite(rsi.iloc[-1]) else 50.0,
        "bb_upper": float(upper.iloc[-1]),
        "bb_mid": float(mid.iloc[-1]),
        "bb_lower": float(lower.iloc[-1]),
        "high_20": float(df.high.tail(20).max()),
        "low_20": float(df.low.tail(20).min()),
        "last_open": float(last.open),
        "last_high": float(last.high),
        "last_low": float(last.low),
    }


def make_signal(req: SignalRequest, candles: list[dict]) -> dict:
    df = clean_candles(candles)
    x = calc_indicators(df)
    score, max_score, reasons = 0, 0, []

    if "ema_rsi" in req.strategies:
        max_score += 2
        if x["ema9"] > x["ema21"] and x["rsi"] >= 52:
            score += 2
            reasons.append("EMA 9 is above EMA 21 and RSI confirms bullish momentum")
        elif x["ema9"] < x["ema21"] and x["rsi"] <= 48:
            score -= 2
            reasons.append("EMA 9 is below EMA 21 and RSI confirms bearish momentum")
        else:
            reasons.append("EMA/RSI alignment is mixed")

    if "bollinger" in req.strategies:
        max_score += 1
        if x["close"] > x["bb_mid"]:
            score += 1
            reasons.append("Price is above Bollinger midline")
        elif x["close"] < x["bb_mid"]:
            score -= 1
            reasons.append("Price is below Bollinger midline")

    if "price_action" in req.strategies:
        max_score += 1
        body = x["close"] - x["last_open"]
        if body > 0:
            score += 1
            reasons.append("Latest candle is bullish")
        elif body < 0:
            score -= 1
            reasons.append("Latest candle is bearish")

    if "support_resistance" in req.strategies:
        max_score += 1
        close = x["close"]
        if close <= x["low_20"] * 1.0015:
            score += 1
            reasons.append("Price is near recent support")
        elif close >= x["high_20"] * 0.9985:
            score -= 1
            reasons.append("Price is near recent resistance")

    threshold = max(2, math.ceil(max_score * 0.5))
    direction = "CALL" if score >= threshold else "PUT" if score <= -threshold else "WAIT"
    confidence = 50 if max_score == 0 else round(min(95, 50 + (abs(score) / max_score) * 45))
    if direction == "WAIT":
        confidence = min(confidence, 59)

    return {
        "signal_id": "sig_" + uuid.uuid4().hex[:12],
        "symbol": req.symbol,
        "market": req.market,
        "timeframe": req.timeframe,
        "expiry_seconds": req.expiry_seconds,
        "direction": direction,
        "confidence": confidence,
        "score": score,
        "max_score": max_score,
        "indicators": x,
        "reasons": reasons,
        "generated_at": int(time.time()),
    }


async def fetch_binance_candles(symbol: str, timeframe: str, limit: int = 100) -> list[dict]:
    url = "https://api.binance.com/api/v3/klines"
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(url, params={"symbol": symbol.upper(), "interval": timeframe, "limit": limit})
        if response.status_code != 200:
            raise HTTPException(502, f"Market-data provider returned HTTP {response.status_code}")
        rows = response.json()
    return [{"open": row[1], "high": row[2], "low": row[3], "close": row[4], "timestamp": row[0]} for row in rows]


@app.get("/")
def home():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/health")
def health():
    risk.reset_if_new_day()
    return {"ok": True, "paper_mode": settings.paper_mode, "risk": {"trades": risk.trades, "pnl": risk.pnl}}


@app.get("/api/candles")
async def candles(symbol: str = "BTCUSDT", timeframe: Literal["1m", "5m", "15m"] = "1m"):
    return {"symbol": symbol.upper(), "timeframe": timeframe, "candles": await fetch_binance_candles(symbol, timeframe)}


@app.post("/api/signal")
async def signal(req: SignalRequest):
    if req.market == "OTC":
        if not req.candles:
            raise HTTPException(400, "OTC mode requires an authorized OTC candle feed; send candles explicitly")
        candles = req.candles
    else:
        candles = req.candles or await fetch_binance_candles(req.symbol, req.timeframe)
    return make_signal(req, candles)


@app.post("/api/paper-trade")
def paper_trade(req: PaperTradeRequest):
    risk.reset_if_new_day()
    now = time.time()
    if not settings.paper_mode:
        raise HTTPException(403, "Paper mode is disabled by configuration")
    if req.stake_usd > settings.max_stake_usd:
        raise HTTPException(400, f"Stake exceeds ${settings.max_stake_usd:.2f}")
    if risk.pnl <= -settings.daily_loss_limit_usd:
        raise HTTPException(429, "Daily loss limit reached")
    if risk.trades >= settings.max_trades_per_day:
        raise HTTPException(429, "Daily trade cap reached")
    if now - risk.last_trade_ts < settings.cooldown_seconds:
        raise HTTPException(429, "Cooldown active")
    risk.trades += 1
    risk.last_trade_ts = now
    return {
        "accepted": True,
        "mode": "paper",
        "signal_id": req.signal_id,
        "direction": req.direction,
        "stake_usd": req.stake_usd,
    }
