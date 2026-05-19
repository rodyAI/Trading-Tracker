# Swing Trading Tracker

A Firebase-hosted web dashboard for tracking long trades with live market prices, risk/reward math, login, cloud persistence, and sell-price recommendations.

## Features

- Add, edit, and delete trades
- Organize trades into dashboard sheets: Swing, Long trades, Value investing, and Magic formula
- Track ticker, quantity, entry, optional stop loss, optional take profit, notes, entry date, and tags
- Fetch current prices from a real market data source
- Auto-refresh prices every 60 seconds while the app is open
- Display current P/L, risk, reward, risk/reward ratio, status, and portfolio unrealized P/L
- Show total P/L in dollars and percent for each dashboard sheet
- Recommend a sell price. With a stop loss, the default is 2:1 risk/reward improved with resistance and ATR when candle data is available. Without a stop loss, the recommendation uses resistance/ATR and shows risk metrics as unavailable.
- Sign in with Firebase Auth using email/password or Google
- Save trades per user in Cloud Firestore
- Export and import CSV
- Responsive dark-mode UI with a desktop table and mobile cards

## Market Data

Firebase Functions supports:

- Yahoo-compatible endpoints via `MARKET_DATA_PROVIDER=yahoo`
- Alpha Vantage via `MARKET_DATA_PROVIDER=alphavantage`

Alpha Vantage requires an API key in an environment variable:

```bash
ALPHA_VANTAGE_API_KEY=your_key_here
```

No mock prices are used by the tracker. If the selected provider cannot return a price, the UI shows a clear error on the affected trade.

## Firebase Architecture

```txt
Firebase Hosting
  - serves the React app from frontend/dist

Firebase Auth
  - email/password login
  - Google login

Cloud Firestore
  - stores trades at users/{uid}/trades/{tradeId}
  - protected by firestore.rules

Firebase Functions
  - exposes /api/market/quotes
  - exposes /api/market/candles/:symbol
  - keeps market-data provider keys server-side
```

## Run Locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

The local Express backend still runs on [http://localhost:8787](http://localhost:8787) for local market-data development. In Firebase production, `/api` is served by Firebase Functions.

Trades are stored in Firestore after login.

## Firebase Setup

1. Create a Firebase project.
2. Enable Authentication providers:
   - Email/password
   - Google
3. Create a Cloud Firestore database.
4. Create a Firebase Web App and copy its config into `.env`.
5. Copy `.firebaserc.example` to `.firebaserc` and replace `your-firebase-project-id`.
6. Install dependencies:

```bash
npm install
```

7. Log in and deploy:

```bash
npx firebase login
npm run deploy:firebase
```

Firebase deploys:

- Hosting
- Functions
- Firestore rules
- Firestore indexes

## Firebase Build

```bash
npm install
npm run build:firebase
```

## Firebase Environment

Copy `.env.example` to `.env` and fill in Firebase Web App values:

```bash
VITE_FIREBASE_API_KEY=your_firebase_api_key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id

MARKET_DATA_PROVIDER=yahoo
YAHOO_LANG=en-US
YAHOO_REGION=US
```

For Alpha Vantage, set `ALPHA_VANTAGE_API_KEY` as a Firebase Functions environment variable or secret.

## Legacy Express Backend

The old Express backend is still in the repo for local compatibility and can still run with:

```bash
npm run dev
```

## Disclaimer

This tool is for tracking and educational purposes only and is not financial advice.
