import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;
const HOST = '0.0.0.0';

const settings = {
  app_host: HOST,
  app_port: PORT,
  max_stake_usd: parseFloat(process.env.MAX_STAKE_USD || '1.0'),
  daily_loss_limit_usd: parseFloat(process.env.DAILY_LOSS_LIMIT_USD || '5.0'),
  max_trades_per_day: parseInt(process.env.MAX_TRADES_PER_DAY || '20', 10),
  cooldown_seconds: parseInt(process.env.COOLDOWN_SECONDS || '60', 10),
  paper_mode: process.env.PAPER_MODE !== 'false',
};

class RiskState {
  day: string;
  pnl: number;
  trades: number;
  last_trade_ts: number;

  constructor() {
    this.day = new Date().toISOString().slice(0, 10);
    this.pnl = 0.0;
    this.trades = 0;
    this.last_trade_ts = 0.0;
  }

  resetIfNewDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.pnl = 0.0;
      this.trades = 0;
      this.last_trade_ts = 0.0;
    }
  }
}

const risk = new RiskState();

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp?: number;
}

function cleanCandles(candles: any[]): Candle[] {
  if (!candles || !Array.isArray(candles) || candles.length < 30) {
    throw new Error('At least 30 candles are required');
  }

  const cleaned: Candle[] = [];
  for (const c of candles) {
    if (c == null || typeof c !== 'object') {
      throw new Error('Candles must contain open, high, low and close');
    }
    const open = parseFloat(c.open);
    const high = parseFloat(c.high);
    const low = parseFloat(c.low);
    const close = parseFloat(c.close);

    if (
      Number.isNaN(open) ||
      Number.isNaN(high) ||
      Number.isNaN(low) ||
      Number.isNaN(close) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      throw new Error('Invalid candle data');
    }

    cleaned.push({
      open,
      high,
      low,
      close,
      timestamp: c.timestamp ? Number(c.timestamp) : undefined,
    });
  }

  if (cleaned.length < 30) {
    throw new Error('At least 30 valid candles are required');
  }

  return cleaned;
}

function calculateEMA(closes: number[], span: number): number[] {
  const alpha = 2 / (span + 1);
  const ema: number[] = new Array(closes.length);
  ema[0] = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema[i] = alpha * closes[i] + (1 - alpha) * ema[i - 1];
  }
  return ema;
}

function calcIndicators(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  const n = closes.length;

  const ema9Series = calculateEMA(closes, 9);
  const ema21Series = calculateEMA(closes, 21);

  // RSI 14 (rolling 14 mean of gains and losses)
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  let rsi = 50.0;
  if (gains.length >= 14) {
    const last14Gains = gains.slice(-14);
    const last14Losses = losses.slice(-14);
    const avgGain = last14Gains.reduce((a, b) => a + b, 0) / 14;
    const avgLoss = last14Losses.reduce((a, b) => a + b, 0) / 14;

    if (avgLoss === 0) {
      rsi = 100.0;
    } else {
      const rs = avgGain / avgLoss;
      rsi = 100 - 100 / (1 + rs);
    }
  }

  // Bollinger Bands 20
  const last20Closes = closes.slice(-20);
  const mid = last20Closes.reduce((a, b) => a + b, 0) / 20;
  const variance =
    last20Closes.reduce((sum, val) => sum + Math.pow(val - mid, 2), 0) / 20;
  const std = Math.sqrt(variance);
  const upper = mid + 2 * std;
  const lower = mid - 2 * std;

  // High 20 & Low 20
  const last20Candles = candles.slice(-20);
  const high20 = Math.max(...last20Candles.map((c) => c.high));
  const low20 = Math.min(...last20Candles.map((c) => c.low));

  const last = candles[n - 1];

  return {
    close: Number(last.close),
    ema9: Number(ema9Series[n - 1]),
    ema21: Number(ema21Series[n - 1]),
    rsi: Number.isFinite(rsi) ? Number(rsi) : 50.0,
    bb_upper: Number(upper),
    bb_mid: Number(mid),
    bb_lower: Number(lower),
    high_20: Number(high20),
    low_20: Number(low20),
    last_open: Number(last.open),
    last_high: Number(last.high),
    last_low: Number(last.low),
  };
}

function makeSignal(req: any, rawCandles: any[]) {
  const candles = cleanCandles(rawCandles);
  const x = calcIndicators(candles);
  let score = 0;
  let maxScore = 0;
  const reasons: string[] = [];

  const strategies: string[] = req.strategies || [
    'ema_rsi',
    'price_action',
    'bollinger',
    'support_resistance',
  ];

  if (strategies.includes('ema_rsi')) {
    maxScore += 2;
    if (x.ema9 > x.ema21 && x.rsi >= 52) {
      score += 2;
      reasons.push('EMA 9 is above EMA 21 and RSI confirms bullish momentum');
    } else if (x.ema9 < x.ema21 && x.rsi <= 48) {
      score -= 2;
      reasons.push('EMA 9 is below EMA 21 and RSI confirms bearish momentum');
    } else {
      reasons.push('EMA/RSI alignment is mixed');
    }
  }

  if (strategies.includes('bollinger')) {
    maxScore += 1;
    if (x.close > x.bb_mid) {
      score += 1;
      reasons.push('Price is above Bollinger midline');
    } else if (x.close < x.bb_mid) {
      score -= 1;
      reasons.push('Price is below Bollinger midline');
    }
  }

  if (strategies.includes('price_action')) {
    maxScore += 1;
    const body = x.close - x.last_open;
    if (body > 0) {
      score += 1;
      reasons.push('Latest candle is bullish');
    } else if (body < 0) {
      score -= 1;
      reasons.push('Latest candle is bearish');
    }
  }

  if (strategies.includes('support_resistance')) {
    maxScore += 1;
    const close = x.close;
    if (close <= x.low_20 * 1.0015) {
      score += 1;
      reasons.push('Price is near recent support');
    } else if (close >= x.high_20 * 0.9985) {
      score -= 1;
      reasons.push('Price is near recent resistance');
    }
  }

  const threshold = Math.max(2, Math.ceil(maxScore * 0.5));
  const direction =
    score >= threshold ? 'CALL' : score <= -threshold ? 'PUT' : 'WAIT';

  let confidence =
    maxScore === 0 ? 50 : Math.round(Math.min(95, 50 + (Math.abs(score) / maxScore) * 45));
  if (direction === 'WAIT') {
    confidence = Math.min(confidence, 59);
  }

  const signalId = 'sig_' + Math.random().toString(36).substring(2, 14);

  return {
    signal_id: signalId,
    symbol: req.symbol,
    market: req.market,
    timeframe: req.timeframe,
    expiry_seconds: req.expiry_seconds,
    direction,
    confidence,
    score,
    max_score: maxScore,
    indicators: x,
    reasons,
    generated_at: Math.floor(Date.now() / 1000),
  };
}

function generateSimulatedCandles(symbol: string, limit: number = 100): Candle[] {
  let basePrice = 65000;
  const sym = symbol.toUpperCase();
  if (sym.includes('ETH')) basePrice = 3400;
  else if (sym.includes('BNB')) basePrice = 580;
  else if (sym.includes('EUR')) basePrice = 1.08;

  const now = Date.now();
  const step = 60 * 1000;
  const candles: Candle[] = [];
  let current = basePrice;

  for (let i = limit; i >= 0; i--) {
    const timestamp = now - i * step;
    const delta = (Math.random() - 0.495) * (current * 0.003);
    const open = current;
    const close = current + delta;
    const high = Math.max(open, close) + Math.random() * (current * 0.0015);
    const low = Math.min(open, close) - Math.random() * (current * 0.0015);
    current = close;
    candles.push({ open, high, low, close, timestamp });
  }

  return candles;
}

async function fetchBinanceCandles(symbol: string, timeframe: string, limit: number = 100): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(
    symbol.toUpperCase()
  )}&interval=${encodeURIComponent(timeframe)}&limit=${limit}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) {
      console.warn(`Binance API returned status ${response.status}, falling back to simulated candles`);
      return generateSimulatedCandles(symbol, limit);
    }

    const rows = (await response.json()) as any[];
    return rows.map((row) => ({
      open: parseFloat(row[1]),
      high: parseFloat(row[2]),
      low: parseFloat(row[3]),
      close: parseFloat(row[4]),
      timestamp: Number(row[0]),
    }));
  } catch (err) {
    console.warn('Failed to fetch from Binance, using fallback candles:', err);
    return generateSimulatedCandles(symbol, limit);
  }
}

// Routes
app.get('/health', (_req: Request, res: Response) => {
  risk.resetIfNewDay();
  res.json({
    ok: true,
    paper_mode: settings.paper_mode,
    risk: { trades: risk.trades, pnl: risk.pnl },
  });
});

app.get('/api/candles', async (req: Request, res: Response) => {
  const symbol = (req.query.symbol as string) || 'BTCUSDT';
  const timeframe = (req.query.timeframe as string) || '1m';
  try {
    const candles = await fetchBinanceCandles(symbol, timeframe);
    res.json({
      symbol: symbol.toUpperCase(),
      timeframe,
      candles,
    });
  } catch (err: any) {
    res.status(502).json({ error: err.message || 'Market data unavailable' });
  }
});

app.post('/api/signal', async (req: Request, res: Response) => {
  try {
    const {
      symbol = 'BTCUSDT',
      timeframe = '1m',
      expiry_seconds = 60,
      market = 'REAL',
      strategies = ['ema_rsi', 'price_action', 'bollinger', 'support_resistance'],
      candles: providedCandles,
    } = req.body || {};

    let candles: any[] = providedCandles;
    if (market === 'OTC') {
      if (!candles || !candles.length) {
        res.status(400).json({
          detail: 'OTC mode requires an authorized OTC candle feed; send candles explicitly',
          error: 'OTC mode requires an authorized OTC candle feed; send candles explicitly',
        });
        return;
      }
    } else {
      if (!candles || !candles.length) {
        candles = await fetchBinanceCandles(symbol, timeframe);
      }
    }

    const signalData = makeSignal(
      { symbol, timeframe, expiry_seconds, market, strategies },
      candles
    );
    res.json(signalData);
  } catch (err: any) {
    res.status(400).json({ detail: err.message, error: err.message });
  }
});

app.post('/api/paper-trade', (req: Request, res: Response) => {
  risk.resetIfNewDay();
  const now = Date.now() / 1000;
  const { signal_id, direction, stake_usd } = req.body || {};

  if (!settings.paper_mode) {
    res.status(403).json({ error: 'Paper mode is disabled by configuration' });
    return;
  }

  const stake = parseFloat(stake_usd);
  if (isNaN(stake) || stake <= 0 || stake > settings.max_stake_usd) {
    res.status(400).json({
      error: `Stake exceeds $${settings.max_stake_usd.toFixed(2)} or is invalid`,
    });
    return;
  }

  if (risk.pnl <= -settings.daily_loss_limit_usd) {
    res.status(429).json({ error: 'Daily loss limit reached' });
    return;
  }

  if (risk.trades >= settings.max_trades_per_day) {
    res.status(429).json({ error: 'Daily trade cap reached' });
    return;
  }

  if (now - risk.last_trade_ts < settings.cooldown_seconds) {
    res.status(429).json({ error: 'Cooldown active' });
    return;
  }

  risk.trades += 1;
  risk.last_trade_ts = now;

  res.json({
    accepted: true,
    mode: 'paper',
    signal_id,
    direction,
    stake_usd: stake,
  });
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`CODEX AI MARKET server running on http://${HOST}:${PORT}`);
});
