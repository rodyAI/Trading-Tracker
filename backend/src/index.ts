import cors from "cors";
import express from "express";
import path from "node:path";
import type { MarketDataProviderId, ScreenerProviderId } from "../../shared/src/types.js";
import { config } from "./config.js";
import { createScreenerProvider } from "./providers/index.js";
import { MarketDataService } from "./services/marketDataService.js";
import { ScreenerService } from "./services/screenerService.js";
import { TradeStore } from "./services/tradeStore.js";

const app = express();
const DEFAULT_PROVIDER = createScreenerProvider();
const tradeStore = new TradeStore();

const isProviderId = (value: string): value is ScreenerProviderId =>
  value === "sample" || value === "yahoo" || value === "alphavantage";

const isMarketDataProviderId = (value: string): value is MarketDataProviderId =>
  value === "yahoo" || value === "alphavantage";

const resolveMarketDataProvider = (value: unknown) => {
  const requestedProvider = String(value ?? config.marketDataProvider).toLowerCase();
  if (!isMarketDataProviderId(requestedProvider)) {
    throw new Error(`Unsupported market data provider: ${requestedProvider}`);
  }
  return requestedProvider;
};

const isAllowedFrontendOrigin = (origin: string) => {
  if (config.frontendOrigins.includes(origin)) return true;

  try {
    const parsedOrigin = new URL(origin);
    const isDevPort = parsedOrigin.port === "5173";
    const isLocalhost = parsedOrigin.hostname === "localhost" || parsedOrigin.hostname === "127.0.0.1";
    const isPrivateLan =
      /^10\./.test(parsedOrigin.hostname) ||
      /^192\.168\./.test(parsedOrigin.hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(parsedOrigin.hostname);
    return isDevPort && (isLocalhost || isPrivateLan);
  } catch {
    return false;
  }
};

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || isAllowedFrontendOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS origin not allowed: ${origin}`));
    },
  }),
);
app.use(express.json());

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, provider: DEFAULT_PROVIDER.id });
});

app.post("/api/market/quotes", async (request, response) => {
  try {
    const symbols = Array.isArray(request.body?.symbols) ? request.body.symbols.map(String) : [];
    if (symbols.length === 0) {
      response.status(400).json({ error: "At least one symbol is required." });
      return;
    }

    const provider = resolveMarketDataProvider(request.query.provider);
    const marketDataService = new MarketDataService(provider);
    const result = await marketDataService.getQuotes(symbols);
    response.json({
      provider,
      generatedAt: Date.now(),
      ...result,
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to fetch current prices",
    });
  }
});

app.get("/api/market/candles/:symbol", async (request, response) => {
  try {
    const provider = resolveMarketDataProvider(request.query.provider);
    const marketDataService = new MarketDataService(provider);
    const candles = await marketDataService.getDailyCandles(request.params.symbol);
    response.json({
      symbol: request.params.symbol.trim().toUpperCase(),
      provider,
      generatedAt: Date.now(),
      candles,
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to fetch daily candles",
    });
  }
});

app.get("/api/trades", async (_request, response) => {
  try {
    response.json({ trades: await tradeStore.getAll() });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load trades",
    });
  }
});

app.post("/api/trades", async (request, response) => {
  try {
    const trade = await tradeStore.upsert(request.body);
    response.status(201).json({ trade });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to save trade",
    });
  }
});

app.put("/api/trades/:id", async (request, response) => {
  try {
    const trade = await tradeStore.upsert({ ...request.body, id: request.params.id });
    response.json({ trade });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to update trade",
    });
  }
});

app.put("/api/trades", async (request, response) => {
  try {
    const trades = await tradeStore.replaceAll(Array.isArray(request.body?.trades) ? request.body.trades : []);
    response.json({ trades });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to replace trades",
    });
  }
});

app.post("/api/trades/import", async (request, response) => {
  try {
    const trades = await tradeStore.bulkInsert(Array.isArray(request.body?.trades) ? request.body.trades : []);
    response.status(201).json({ trades });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to import trades",
    });
  }
});

app.delete("/api/trades/:id", async (request, response) => {
  try {
    const deleted = await tradeStore.delete(request.params.id);
    response.status(deleted ? 204 : 404).send();
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to delete trade",
    });
  }
});

app.get("/api/screener/run", async (request, response) => {
  try {
    const requestedProvider = String(request.query.provider ?? config.defaultProvider).toLowerCase();
    if (!isProviderId(requestedProvider)) {
      response.status(400).json({ error: `Unsupported provider: ${requestedProvider}` });
      return;
    }

    const provider = createScreenerProvider(requestedProvider);
    const screenerService = new ScreenerService(provider);
    const result = await screenerService.run();
    response.json(result);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to run stock screen",
    });
  }
});

const frontendDistPath = path.resolve(process.cwd(), "frontend/dist");
app.use(express.static(frontendDistPath));

app.get("*", (request, response, next) => {
  if (request.path.startsWith("/api")) {
    next();
    return;
  }

  response.sendFile(path.join(frontendDistPath, "index.html"));
});

app.listen(config.port, () => {
  console.log(`Swing Trading Tracker backend running on http://localhost:${config.port}`);
});
