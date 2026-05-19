import cors from "cors";
import express from "express";
import { onRequest } from "firebase-functions/v2/https";

type MarketDataProviderId = "yahoo" | "alphavantage";

interface MarketQuote {
  symbol: string;
  price: number;
  currency: string;
  provider: MarketDataProviderId;
  asOf: number;
}

interface MarketCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface YahooQuoteResponse {
  quoteResponse?: {
    result?: Array<{
      symbol?: string;
      regularMarketPrice?: number;
      currency?: string;
      regularMarketTime?: number;
    }>;
    error?: {
      description?: string;
    };
  };
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      meta?: {
        symbol?: string;
        currency?: string;
        regularMarketPrice?: number;
        regularMarketTime?: number;
      };
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
    error?: {
      description?: string;
    };
  };
}

interface AlphaVantageGlobalQuoteResponse {
  ["Global Quote"]?: {
    ["01. symbol"]?: string;
    ["05. price"]?: string;
    ["07. latest trading day"]?: string;
  };
  Note?: string;
  Information?: string;
  ErrorMessage?: string;
}

interface AlphaVantageDailyResponse {
  ["Time Series (Daily)"]?: Record<
    string,
    {
      ["1. open"]?: string;
      ["2. high"]?: string;
      ["3. low"]?: string;
      ["4. close"]?: string;
      ["5. volume"]?: string;
    }
  >;
  Note?: string;
  Information?: string;
  ErrorMessage?: string;
}

const app = express();
const UPSTREAM_TIMEOUT_MS = 10_000;

const config = {
  marketDataProvider:
    (process.env.MARKET_DATA_PROVIDER as MarketDataProviderId | undefined) ??
    (process.env.ALPHA_VANTAGE_API_KEY ? "alphavantage" : "yahoo"),
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY ?? "",
  alphaVantageBaseUrl: process.env.ALPHA_VANTAGE_BASE_URL ?? "https://www.alphavantage.co/query",
  yahooLang: process.env.YAHOO_LANG ?? "en-US",
  yahooRegion: process.env.YAHOO_REGION ?? "US",
};

const parseNumber = (value: string | number | null | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeSymbol = (symbol: string) => symbol.trim().toUpperCase();

const fromUnixSeconds = (seconds: number | undefined) =>
  typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : Date.now();

const fetchWithTimeout = async (url: string, headers: Record<string, string> = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Accept-Language": config.yahooLang,
        "User-Agent": "swing-trading-tracker/1.0",
        ...headers,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
};

const alphaVantageUrl = (params: Record<string, string>) => {
  if (!config.alphaVantageApiKey) {
    throw new Error("ALPHA_VANTAGE_API_KEY must be set to use Alpha Vantage market data.");
  }

  const url = new URL(config.alphaVantageBaseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("apikey", config.alphaVantageApiKey);
  return url.toString();
};

const assertAlphaVantagePayload = (payload: AlphaVantageGlobalQuoteResponse | AlphaVantageDailyResponse) => {
  const message = payload.Note ?? payload.Information ?? payload.ErrorMessage;
  if (message) {
    throw new Error(message);
  }
};

const fetchAlphaVantageJson = async <T extends AlphaVantageGlobalQuoteResponse | AlphaVantageDailyResponse>(
  params: Record<string, string>,
) => {
  const response = await fetchWithTimeout(alphaVantageUrl(params));
  if (!response.ok) throw new Error(`Alpha Vantage request failed with ${response.status}`);
  const payload = (await response.json()) as T;
  assertAlphaVantagePayload(payload);
  return payload;
};

const fetchYahooJson = async <T>(url: string) => {
  const response = await fetchWithTimeout(url, { Referer: "https://finance.yahoo.com/" });
  if (!response.ok) throw new Error(`Yahoo Finance request failed with ${response.status}`);
  return (await response.json()) as T;
};

class MarketDataService {
  provider: MarketDataProviderId;

  constructor(provider: MarketDataProviderId = config.marketDataProvider) {
    this.provider = provider;
  }

  async getQuote(symbolInput: string): Promise<MarketQuote> {
    const symbol = normalizeSymbol(symbolInput);
    if (!symbol) throw new Error("Symbol is required.");
    return this.provider === "alphavantage" ? this.getAlphaVantageQuote(symbol) : this.getYahooQuote(symbol);
  }

  async getQuotes(symbols: string[]) {
    const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
    const quotes: MarketQuote[] = [];
    const errors: Array<{ symbol: string; message: string }> = [];

    await Promise.all(
      uniqueSymbols.map(async (symbol) => {
        try {
          quotes.push(await this.getQuote(symbol));
        } catch (error) {
          errors.push({ symbol, message: error instanceof Error ? error.message : "Unable to fetch current price." });
        }
      }),
    );

    return { quotes, errors };
  }

  async getDailyCandles(symbolInput: string): Promise<MarketCandle[]> {
    const symbol = normalizeSymbol(symbolInput);
    if (!symbol) throw new Error("Symbol is required.");
    return this.provider === "alphavantage" ? this.getAlphaVantageDailyCandles(symbol) : this.getYahooDailyCandles(symbol);
  }

  private async getAlphaVantageQuote(symbol: string): Promise<MarketQuote> {
    const payload = await fetchAlphaVantageJson<AlphaVantageGlobalQuoteResponse>({
      function: "GLOBAL_QUOTE",
      symbol,
    });
    const quote = payload["Global Quote"];
    const price = parseNumber(quote?.["05. price"]);
    if (price == null) throw new Error(`No current price returned for ${symbol}.`);

    return {
      symbol: normalizeSymbol(quote?.["01. symbol"] ?? symbol),
      price,
      currency: "USD",
      provider: "alphavantage",
      asOf: quote?.["07. latest trading day"] ? new Date(`${quote["07. latest trading day"]}T21:00:00Z`).getTime() : Date.now(),
    };
  }

  private async getAlphaVantageDailyCandles(symbol: string): Promise<MarketCandle[]> {
    const payload = await fetchAlphaVantageJson<AlphaVantageDailyResponse>({
      function: "TIME_SERIES_DAILY",
      symbol,
      outputsize: "full",
    });
    const series = payload["Time Series (Daily)"] ?? {};
    const candles = Object.entries(series)
      .map(([date, bar]) => ({
        date,
        open: parseNumber(bar["1. open"]),
        high: parseNumber(bar["2. high"]),
        low: parseNumber(bar["3. low"]),
        close: parseNumber(bar["4. close"]),
        volume: parseNumber(bar["5. volume"]) ?? 0,
      }))
      .filter(
        (bar): bar is MarketCandle =>
          bar.open != null && bar.high != null && bar.low != null && bar.close != null,
      )
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-260);

    if (candles.length === 0) throw new Error(`No daily candle history returned for ${symbol}.`);
    return candles;
  }

  private async getYahooQuote(symbol: string): Promise<MarketQuote> {
    const url = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
    url.searchParams.set("symbols", symbol);
    url.searchParams.set("lang", config.yahooLang);
    url.searchParams.set("region", config.yahooRegion);

    try {
      const payload = await fetchYahooJson<YahooQuoteResponse>(url.toString());
      const quote = payload.quoteResponse?.result?.[0];
      const price = quote?.regularMarketPrice;
      if (!quote || !Number.isFinite(price)) {
        throw new Error(payload.quoteResponse?.error?.description ?? `No current price returned for ${symbol}.`);
      }

      return {
        symbol: normalizeSymbol(quote.symbol ?? symbol),
        price: price as number,
        currency: quote.currency ?? "USD",
        provider: "yahoo",
        asOf: fromUnixSeconds(quote.regularMarketTime),
      };
    } catch {
      return this.getYahooChartQuote(symbol);
    }
  }

  private async getYahooChartQuote(symbol: string): Promise<MarketQuote> {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    url.searchParams.set("range", "1d");
    url.searchParams.set("interval", "1m");
    url.searchParams.set("includePrePost", "false");

    const payload = await fetchYahooJson<YahooChartResponse>(url.toString());
    const result = payload.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const closes = quote?.close?.filter((value): value is number => Number.isFinite(value)) ?? [];
    const latestClose = closes.at(-1);
    const price = result?.meta?.regularMarketPrice ?? latestClose;
    if (!result || !Number.isFinite(price)) {
      throw new Error(payload.chart?.error?.description ?? `No current price returned for ${symbol}.`);
    }

    return {
      symbol: normalizeSymbol(result.meta?.symbol ?? symbol),
      price: price as number,
      currency: result.meta?.currency ?? "USD",
      provider: "yahoo",
      asOf: fromUnixSeconds(result.meta?.regularMarketTime),
    };
  }

  private async getYahooDailyCandles(symbol: string): Promise<MarketCandle[]> {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    url.searchParams.set("range", "1y");
    url.searchParams.set("interval", "1d");
    url.searchParams.set("includePrePost", "false");

    const payload = await fetchYahooJson<YahooChartResponse>(url.toString());
    const result = payload.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const timestamps = result?.timestamp ?? [];
    if (!result || !quote || timestamps.length === 0) {
      throw new Error(payload.chart?.error?.description ?? `No daily candle history returned for ${symbol}.`);
    }

    const candles = timestamps
      .map((timestamp, index) => ({
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        open: quote.open?.[index] ?? null,
        high: quote.high?.[index] ?? null,
        low: quote.low?.[index] ?? null,
        close: quote.close?.[index] ?? null,
        volume: quote.volume?.[index] ?? 0,
      }))
      .filter(
        (bar): bar is MarketCandle =>
          Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close),
      )
      .slice(-260);

    if (candles.length === 0) throw new Error(`No daily candle history returned for ${symbol}.`);
    return candles;
  }
}

const isMarketDataProviderId = (value: string): value is MarketDataProviderId =>
  value === "yahoo" || value === "alphavantage";

const resolveMarketDataProvider = (value: unknown) => {
  const requestedProvider = String(value ?? config.marketDataProvider).toLowerCase();
  if (!isMarketDataProviderId(requestedProvider)) {
    throw new Error(`Unsupported market data provider: ${requestedProvider}`);
  }
  return requestedProvider;
};

app.use(cors({ origin: true }));
app.use(express.json());

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
    response.json({ provider, generatedAt: Date.now(), ...result });
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

export const api = onRequest({ region: "us-central1", timeoutSeconds: 30, memory: "512MiB" }, app);
