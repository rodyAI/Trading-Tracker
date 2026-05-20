type MarketDataProviderId = "yahoo" | "alphavantage";

interface Env {
  ALLOWED_ORIGINS?: string;
  MARKET_DATA_PROVIDER?: MarketDataProviderId;
  YAHOO_LANG?: string;
  YAHOO_REGION?: string;
  ALPHA_VANTAGE_API_KEY?: string;
  ALPHA_VANTAGE_BASE_URL?: string;
}

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

interface FailedAttempt {
  source: string;
  status: "failed";
  message: string;
}

class MarketDataError extends Error {
  attempts: FailedAttempt[];

  constructor(message: string, attempts: FailedAttempt[]) {
    super(message);
    this.name = "MarketDataError";
    this.attempts = attempts;
  }
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

const normalizeSymbol = (symbol: string) => symbol.trim().toUpperCase();

const parseNumber = (value: string | number | null | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const fromUnixSeconds = (seconds: number | undefined) =>
  typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : Date.now();

const json = (payload: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });

const getCorsHeaders = (request: Request, env: Env) => {
  const origin = request.headers.get("Origin") ?? "";
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
};

const fetchJson = async <T>(url: string, headers: HeadersInit = {}) => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "trading-tracker-market-worker/1.0",
      ...headers,
    },
  });

  if (!response.ok) throw new Error(`Market data request failed with ${response.status}.`);
  return (await response.json()) as T;
};

const getYahooChartUrl = (symbol: string, range: string, interval: string, env: Env) => {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("includePrePost", "false");
  url.searchParams.set("lang", env.YAHOO_LANG ?? "en-US");
  url.searchParams.set("region", env.YAHOO_REGION ?? "US");
  return url.toString();
};

const fetchYahooJson = <T>(url: string, env: Env) =>
  fetchJson<T>(url, {
    "Accept-Language": env.YAHOO_LANG ?? "en-US",
    Referer: "https://finance.yahoo.com/",
  });

const getYahooChartQuote = async (symbol: string, env: Env): Promise<MarketQuote> => {
  const payload = await fetchYahooJson<YahooChartResponse>(getYahooChartUrl(symbol, "1d", "1m", env), env);
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

const getYahooQuoteApi = async (symbol: string, env: Env): Promise<MarketQuote> => {
  const url = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
  url.searchParams.set("symbols", symbol);
  url.searchParams.set("lang", env.YAHOO_LANG ?? "en-US");
  url.searchParams.set("region", env.YAHOO_REGION ?? "US");

  const payload = await fetchYahooJson<YahooQuoteResponse>(url.toString(), env);
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
};

const redactProviderMessage = (message: string, apiKey: string | undefined) => {
  const redactedKey = apiKey ? message.replaceAll(apiKey, "[redacted]") : message;
  return redactedKey.replace(/API key as [A-Z0-9]+/gi, "API key as [redacted]");
};

const assertAlphaVantagePayload = (payload: AlphaVantageGlobalQuoteResponse | AlphaVantageDailyResponse, env: Env) => {
  const message = payload.Note ?? payload.Information ?? payload.ErrorMessage;
  if (message) throw new Error(redactProviderMessage(message, env.ALPHA_VANTAGE_API_KEY));
};

const alphaVantageUrl = (params: Record<string, string>, env: Env) => {
  if (!env.ALPHA_VANTAGE_API_KEY) throw new Error("ALPHA_VANTAGE_API_KEY is not configured.");

  const url = new URL(env.ALPHA_VANTAGE_BASE_URL ?? "https://www.alphavantage.co/query");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("apikey", env.ALPHA_VANTAGE_API_KEY);
  return url.toString();
};

const fetchAlphaVantageJson = async <T extends AlphaVantageGlobalQuoteResponse | AlphaVantageDailyResponse>(
  params: Record<string, string>,
  env: Env,
) => {
  const payload = await fetchJson<T>(alphaVantageUrl(params, env));
  assertAlphaVantagePayload(payload, env);
  return payload;
};

const getAlphaVantageQuote = async (symbol: string, env: Env): Promise<MarketQuote> => {
  const payload = await fetchAlphaVantageJson<AlphaVantageGlobalQuoteResponse>(
    {
      function: "GLOBAL_QUOTE",
      symbol,
    },
    env,
  );
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
};

const getAlphaVantageDailyCandles = async (symbol: string, env: Env): Promise<MarketCandle[]> => {
  const payload = await fetchAlphaVantageJson<AlphaVantageDailyResponse>(
    {
      function: "TIME_SERIES_DAILY",
      symbol,
    },
    env,
  );
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
};

const getStockAnalysisQuote = async (symbol: string): Promise<MarketQuote> => {
  const response = await fetch(`https://stockanalysis.com/stocks/${symbol.toLowerCase()}/`, {
    headers: {
      Accept: "text/html",
      "User-Agent": "trading-tracker-market-worker/1.0",
    },
  });

  if (!response.ok) throw new Error(`StockAnalysis fallback request failed with ${response.status}.`);

  const html = await response.text();
  const chartPoints = [...html.matchAll(/\{c:([0-9.]+)(?:,o:([0-9.]+))?,t:(\d+)\}/g)];
  const latestPoint = chartPoints.at(-1);
  const price = parseNumber(latestPoint?.[1]);
  const timestamp = parseNumber(latestPoint?.[3]);

  if (price == null) throw new Error(`No StockAnalysis fallback quote returned for ${symbol}.`);

  return {
    symbol,
    price,
    currency: "USD",
    provider: "yahoo",
    asOf: timestamp != null ? timestamp * 1000 : Date.now(),
  };
};

const getQuote = async (symbol: string, provider: MarketDataProviderId, env: Env) => {
  const attempts: FailedAttempt[] = [];

  const providers: Array<{ source: string; fetchQuote: () => Promise<MarketQuote> }> =
    provider === "alphavantage"
      ? [
          { source: "Alpha Vantage global quote", fetchQuote: () => getAlphaVantageQuote(symbol, env) },
          { source: "Yahoo quote API", fetchQuote: () => getYahooQuoteApi(symbol, env) },
          { source: "Yahoo chart API", fetchQuote: () => getYahooChartQuote(symbol, env) },
          { source: "StockAnalysis page chart", fetchQuote: () => getStockAnalysisQuote(symbol) },
        ]
      : [
          { source: "Yahoo quote API", fetchQuote: () => getYahooQuoteApi(symbol, env) },
          { source: "Yahoo chart API", fetchQuote: () => getYahooChartQuote(symbol, env) },
          { source: "Alpha Vantage global quote", fetchQuote: () => getAlphaVantageQuote(symbol, env) },
          { source: "StockAnalysis page chart", fetchQuote: () => getStockAnalysisQuote(symbol) },
        ];

  for (const attempt of providers) {
    try {
      return await attempt.fetchQuote();
    } catch (error) {
      attempts.push({
        source: attempt.source,
        status: "failed",
        message: error instanceof Error ? error.message : "Unknown quote error.",
      });
    }
  }

  throw new MarketDataError(
    `Could not fetch a real price for ${symbol}. Tried ${attempts.map((attempt) => attempt.source).join(", ")}.`,
    attempts,
  );
};

const getDailyCandles = async (symbol: string, provider: MarketDataProviderId, env: Env) => {
  const attempts: FailedAttempt[] = [];
  const providers: Array<{ source: string; fetchCandles: () => Promise<MarketCandle[]> }> =
    provider === "alphavantage"
      ? [
          { source: "Alpha Vantage daily candles", fetchCandles: () => getAlphaVantageDailyCandles(symbol, env) },
          { source: "Yahoo daily chart API", fetchCandles: () => getYahooDailyCandles(symbol, env) },
        ]
      : [
          { source: "Yahoo daily chart API", fetchCandles: () => getYahooDailyCandles(symbol, env) },
          { source: "Alpha Vantage daily candles", fetchCandles: () => getAlphaVantageDailyCandles(symbol, env) },
        ];

  for (const attempt of providers) {
    try {
      return await attempt.fetchCandles();
    } catch (error) {
      attempts.push({
        source: attempt.source,
        status: "failed",
        message: error instanceof Error ? error.message : "Unknown candle error.",
      });
    }
  }

  throw new MarketDataError(
    `Could not fetch daily candle history for ${symbol}. Tried ${attempts.map((attempt) => attempt.source).join(", ")}.`,
    attempts,
  );
};

const getYahooDailyCandles = async (symbol: string, env: Env): Promise<MarketCandle[]> => {
  const payload = await fetchYahooJson<YahooChartResponse>(getYahooChartUrl(symbol, "1y", "1d", env), env);
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

const resolveProvider = (request: Request, env: Env) => {
  const url = new URL(request.url);
  const requestedProvider = String(url.searchParams.get("provider") ?? env.MARKET_DATA_PROVIDER ?? "yahoo").toLowerCase();
  if (requestedProvider !== "yahoo" && requestedProvider !== "alphavantage") {
    throw new Error(`Unsupported market data provider: ${requestedProvider}`);
  }
  return requestedProvider;
};

const handleQuotes = async (request: Request, env: Env, corsHeaders: HeadersInit) => {
  const body = (await request.json().catch(() => ({}))) as { symbols?: unknown };
  const symbols = Array.isArray(body.symbols) ? body.symbols.map(String) : [];
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];

  if (uniqueSymbols.length === 0) {
    return json({ error: "At least one symbol is required." }, 400, corsHeaders);
  }

  const provider = resolveProvider(request, env);
  const quotes: MarketQuote[] = [];
  const errors: Array<{ symbol: string; message: string; attempts?: FailedAttempt[] }> = [];

  await Promise.all(
    uniqueSymbols.map(async (symbol) => {
      try {
        quotes.push(await getQuote(symbol, provider, env));
      } catch (error) {
        errors.push({
          symbol,
          message: error instanceof Error ? error.message : "Unable to fetch current price.",
          attempts: error instanceof MarketDataError ? error.attempts : undefined,
        });
      }
    }),
  );

  return json({ provider, generatedAt: Date.now(), quotes, errors }, 200, corsHeaders);
};

const handleCandles = async (request: Request, env: Env, corsHeaders: HeadersInit, symbolInput: string) => {
  const symbol = normalizeSymbol(symbolInput);
  if (!symbol) return json({ error: "Symbol is required." }, 400, corsHeaders);

  const provider = resolveProvider(request, env);
  const candles = await getDailyCandles(symbol, provider, env);
  return json({ symbol, provider, generatedAt: Date.now(), candles }, 200, corsHeaders);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const corsHeaders = getCorsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    try {
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/api/market/quotes") {
        return await handleQuotes(request, env, corsHeaders);
      }

      const candleMatch = url.pathname.match(/^\/api\/market\/candles\/([^/]+)$/);
      if (request.method === "GET" && candleMatch) {
        return await handleCandles(request, env, corsHeaders, decodeURIComponent(candleMatch[1]));
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true }, 200, corsHeaders);
      }

      return json({ error: "Not found" }, 404, corsHeaders);
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : "Market data request failed.",
          attempts: error instanceof MarketDataError ? error.attempts : undefined,
        },
        500,
        corsHeaders,
      );
    }
  },
};
