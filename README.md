# Swing Trading Tracker

A Firebase Spark-compatible web dashboard for tracking long trades with live market prices, risk/reward math, login, cloud persistence, and sell-price recommendations.

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

The Firebase Spark deployment uses a Yahoo-compatible browser endpoint for market prices and candle history. If quote refresh is blocked by the browser, the app falls back to a no-key browser-safe quote source. No mock prices are used by the tracker. If all providers fail a request, the UI shows a clear error on the affected trade.

The legacy local Express backend can still use Yahoo-compatible endpoints or Alpha Vantage for local development, but Firebase production does not deploy a backend function on the free Spark plan.

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

Browser market data
  - fetches current prices and daily candles from a Yahoo-compatible public endpoint
  - uses a no-key browser-safe quote fallback when the primary quote endpoint fails
  - avoids Firebase Functions so the app can deploy on the Spark plan
```

## Run Locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

The local Express backend still runs on [http://localhost:8787](http://localhost:8787) for local market-data development. Firebase production is static Hosting plus Firestore/Auth, with market data fetched directly by the browser.

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

VITE_FIREBASE_MEASUREMENT_ID=your_measurement_id
```

No Firebase Functions are deployed, so this project can stay on Firebase Spark/free. If you later want server-side market-data API keys, provider proxying, or more reliable CORS behavior, add Functions back and upgrade that Firebase project to Blaze.

## Legacy Express Backend

The old Express backend is still in the repo for local compatibility and can still run with:

```bash
npm run dev
```

## Disclaimer

This tool is for tracking and educational purposes only and is not financial advice.
