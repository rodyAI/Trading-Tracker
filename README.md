# Swing Trading Tracker

A local web dashboard for tracking long trades with live market prices, risk/reward math, server-side persistence, and sell-price recommendations.

## Features

- Add, edit, and delete trades
- Organize trades into dashboard sheets: Swing, Long trades, Value investing, and Magic formula
- Track ticker, quantity, entry, optional stop loss, optional take profit, notes, entry date, and tags
- Fetch current prices from a real market data source
- Auto-refresh prices every 60 seconds while the app is open
- Display current P/L, risk, reward, risk/reward ratio, status, and portfolio unrealized P/L
- Show total P/L in dollars and percent for each dashboard sheet
- Recommend a sell price. With a stop loss, the default is 2:1 risk/reward improved with resistance and ATR when candle data is available. Without a stop loss, the recommendation uses resistance/ATR and shows risk metrics as unavailable.
- Save trades server-side in a lightweight backend JSON database
- Export and import CSV
- Responsive dark-mode UI with a desktop table and mobile cards

## Market Data

The backend supports:

- Yahoo-compatible endpoints via `MARKET_DATA_PROVIDER=yahoo`
- Alpha Vantage via `MARKET_DATA_PROVIDER=alphavantage`

Alpha Vantage requires an API key in an environment variable:

```bash
ALPHA_VANTAGE_API_KEY=your_key_here
```

No mock prices are used by the tracker. If the selected provider cannot return a price, the UI shows a clear error on the affected trade.

## Run Locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

The backend runs on [http://localhost:8787](http://localhost:8787).

Trades are stored by the backend in `backend/data/trades.json` by default. Set `TRADE_DATA_FILE` to use a different file path.

## Environment

Copy `.env.example` to `.env` and adjust values as needed.

```bash
PORT=8787
FRONTEND_ORIGIN=http://localhost:5173
MARKET_DATA_PROVIDER=yahoo
ALPHA_VANTAGE_API_KEY=your_key_here
TRADE_DATA_FILE=backend/data/trades.json
YAHOO_LANG=en-US
YAHOO_REGION=US
```

## Disclaimer

This tool is for tracking and educational purposes only and is not financial advice.
