import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import type { MarketDataProviderId, ScreenerProviderId } from "../../shared/src/types.js";

const loadEnvFiles = () => {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), ".env.txt"),
    path.resolve(process.cwd(), "..", ".env"),
    path.resolve(process.cwd(), "..", ".env.local"),
    path.resolve(process.cwd(), "..", ".env.txt"),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false });
    }
  }
};

loadEnvFiles();

const numberFromEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseSymbolList = (value: string | undefined) =>
  (value ?? "AAPL,MSFT,GOOGL,META,TSM,ASML,AMAT,ADBE,CSCO,HIMS,PAYO,ACMR,BAC,BLK,BABA,PDD,SNOW")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);

export const config = {
  port: numberFromEnv(process.env.PORT, 8787),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  frontendOrigins: (process.env.FRONTEND_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  defaultProvider: (process.env.SCREENER_PROVIDER as ScreenerProviderId | undefined) ?? "sample",
  marketDataProvider:
    (process.env.MARKET_DATA_PROVIDER as MarketDataProviderId | undefined) ??
    (process.env.ALPHA_VANTAGE_API_KEY ? "alphavantage" : "yahoo"),
  tradeDataFile: process.env.TRADE_DATA_FILE,
  yahooLang: process.env.YAHOO_LANG ?? "en-US",
  yahooRegion: process.env.YAHOO_REGION ?? "US",
  yahooScreenerSymbols: parseSymbolList(process.env.SCREENER_SYMBOLS),
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY ?? "",
  alphaVantageBaseUrl: process.env.ALPHA_VANTAGE_BASE_URL ?? "https://www.alphavantage.co/query",
  alphaVantageSymbols: parseSymbolList(process.env.ALPHA_VANTAGE_SYMBOLS ?? process.env.SCREENER_SYMBOLS),
  alphaVantageSoftDailyLimit: numberFromEnv(process.env.ALPHA_VANTAGE_SOFT_DAILY_LIMIT, 25),
};
