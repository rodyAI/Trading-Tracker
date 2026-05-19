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

const normalizeSymbol = (symbol: string) => symbol.trim().toUpperCase();

const fromUnixSeconds = (seconds: number | undefined) =>
  typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : Date.now();

const fetchYahooJson = async <T>(url: string) => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Yahoo-compatible market data request failed with ${response.status}.`);
  }

  return (await response.json()) as T;
};

const yahooUnavailableMessage =
  "Yahoo-compatible market data could not be loaded directly from the browser. This can happen if the provider blocks browser requests. No mock price was used.";

const getYahooChartQuote = async (symbol: string): Promise<MarketQuote> => {
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
};

const getYahooQuote = async (symbolInput: string): Promise<MarketQuote> => {
  const symbol = normalizeSymbol(symbolInput);
  if (!symbol) throw new Error("Symbol is required.");

  const url = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
  url.searchParams.set("symbols", symbol);
  url.searchParams.set("lang", "en-US");
  url.searchParams.set("region", "US");

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
    return getYahooChartQuote(symbol);
  }
};

const getYahooDailyCandles = async (symbolInput: string): Promise<MarketCandle[]> => {
  const symbol = normalizeSymbol(symbolInput);
  if (!symbol) throw new Error("Symbol is required.");

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
};

export const refreshTradeQuotes = async (
  symbols: string[],
  _provider?: MarketDataProviderId,
): Promise<QuoteBatchResponse> => {
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
  const quotes: MarketQuote[] = [];
  const errors: Array<{ symbol: string; message: string }> = [];

  await Promise.all(
    uniqueSymbols.map(async (symbol) => {
      try {
        quotes.push(await getYahooQuote(symbol));
      } catch (error) {
        errors.push({
          symbol,
          message: error instanceof Error ? error.message : yahooUnavailableMessage,
        });
      }
    }),
  );

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
