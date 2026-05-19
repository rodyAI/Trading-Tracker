import type {
  CandleResponse,
  MarketCandle,
  MarketDataProviderId,
  MarketQuote,
  QuoteBatchResponse,
} from "@shared/types";

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

interface BiQuoteResponse {
  symbol?: string;
  bid?: number;
  ask?: number;
  mid?: number;
  high?: number;
  low?: number;
  timestamp?: string;
}

const normalizeSymbol = (symbol: string) => symbol.trim().toUpperCase();

const fromUnixSeconds = (seconds: number | undefined) =>
  typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : Date.now();

const parseNumber = (value: string | number | null | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const fetchJson = async <T>(url: string) => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Market data request failed with ${response.status}.`);
  }

  return (await response.json()) as T;
};

const getYahooChartUrl = (symbol: string, range: string, interval: string) => {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("includePrePost", "false");
  return url.toString();
};

const getProxiedUrl = (url: string) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`;

const getYahooChartQuote = async (symbol: string): Promise<MarketQuote> => {
  const payload = await fetchJson<YahooChartResponse>(getYahooChartUrl(symbol, "1d", "1m"));
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
};

const getYahooQuote = async (symbolInput: string): Promise<MarketQuote> => {
  const symbol = normalizeSymbol(symbolInput);
  if (!symbol) throw new Error("Symbol is required.");

  const url = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
  url.searchParams.set("symbols", symbol);
  url.searchParams.set("lang", "en-US");
  url.searchParams.set("region", "US");

  try {
    const payload = await fetchJson<YahooQuoteResponse>(url.toString());
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
    return getYahooChartQuote(symbol);
  }
};

const getBiQuoteFallback = async (symbolInput: string): Promise<MarketQuote> => {
  const symbol = normalizeSymbol(symbolInput);
  const payload = await fetchJson<BiQuoteResponse>(getProxiedUrl(`https://biquote.io/api/${encodeURIComponent(symbol)}`));
  const price = parseNumber(payload.mid) ?? parseNumber(payload.ask) ?? parseNumber(payload.bid);

  if (price == null) {
    throw new Error(`No fallback quote returned for ${symbol}.`);
  }

  return {
    symbol: normalizeSymbol(payload.symbol ?? symbol),
    price,
    currency: "USD",
    provider: "yahoo",
    asOf: payload.timestamp ? new Date(payload.timestamp).getTime() : Date.now(),
  };
};

const getStockAnalysisFallback = async (symbolInput: string): Promise<MarketQuote> => {
  const symbol = normalizeSymbol(symbolInput);
  const response = await fetch(getProxiedUrl(`https://stockanalysis.com/stocks/${symbol.toLowerCase()}/`), {
    headers: {
      Accept: "text/html",
    },
  });

  if (!response.ok) {
    throw new Error(`StockAnalysis fallback request failed with ${response.status}.`);
  }

  const html = await response.text();
  const chartPoints = [...html.matchAll(/\{c:([0-9.]+)(?:,o:([0-9.]+))?,t:(\d+)\}/g)];
  const latestPoint = chartPoints.at(-1);
  const price = parseNumber(latestPoint?.[1]);
  const timestamp = parseNumber(latestPoint?.[3]);

  if (price == null) {
    throw new Error(`No StockAnalysis fallback quote returned for ${symbol}.`);
  }

  return {
    symbol,
    price,
    currency: "USD",
    provider: "yahoo",
    asOf: timestamp != null ? timestamp * 1000 : Date.now(),
  };
};

const getBrowserQuote = async (symbol: string) => {
  try {
    return await getYahooQuote(symbol);
  } catch (yahooError) {
    try {
      return await getBiQuoteFallback(symbol);
    } catch (fallbackError) {
      try {
        return await getStockAnalysisFallback(symbol);
      } catch (stockAnalysisError) {
        const yahooMessage = yahooError instanceof Error ? yahooError.message : "Yahoo-compatible market data failed.";
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "Fallback quote source failed.";
        const stockAnalysisMessage =
          stockAnalysisError instanceof Error ? stockAnalysisError.message : "StockAnalysis fallback failed.";
        throw new Error(
          `${yahooMessage} Browser-safe fallback also failed: ${fallbackMessage} StockAnalysis fallback also failed: ${stockAnalysisMessage}`,
        );
      }
    }
  }
};

const getYahooDailyCandles = async (symbolInput: string): Promise<MarketCandle[]> => {
  const symbol = normalizeSymbol(symbolInput);
  if (!symbol) throw new Error("Symbol is required.");

  const payload = await fetchJson<YahooChartResponse>(getYahooChartUrl(symbol, "1y", "1d"));
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
};

export const refreshTradeQuotes = async (
  symbols: string[],
  _provider?: MarketDataProviderId,
): Promise<QuoteBatchResponse> => {
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
  const quotes: MarketQuote[] = [];
  const errors: Array<{ symbol: string; message: string }> = [];

  for (const symbol of uniqueSymbols) {
    try {
      quotes.push(await getBrowserQuote(symbol));
    } catch (error) {
      errors.push({
        symbol,
        message: error instanceof Error ? error.message : "Unable to fetch current price. No mock price was used.",
      });
    }
  }

  return {
    provider: "yahoo",
    generatedAt: Date.now(),
    quotes,
    errors,
  };
};

export const loadTradeCandles = async (
  symbol: string,
  _provider?: MarketDataProviderId,
): Promise<CandleResponse> => ({
  symbol: normalizeSymbol(symbol),
  provider: "yahoo",
  generatedAt: Date.now(),
  candles: await getYahooDailyCandles(symbol),
});
