import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);

const YAHOO_HEADERS = {
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
};
const YAHOO_SESSION_TTL_MS = 4 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const SESSION_TIMEOUT_MS = 5_000;
let yahooSessionCache = null;
const PRESET_COMPANY_NAMES = {
  TSLA: "Tesla, Inc.",
  AAPL: "Apple Inc.",
  NVDA: "NVIDIA Corporation",
  MSFT: "Microsoft Corporation",
  AMZN: "Amazon.com, Inc.",
};
const FMP_API_KEY = process.env.FMP_API_KEY || "demo";
const SECTOR_ETF_BY_KEYWORD = [
  [/technology|software|semiconductor|hardware|consumer electronics/i, "XLK"],
  [/communication|internet content|interactive media|entertainment/i, "XLC"],
  [/consumer cyclical|auto|retail|e-commerce|restaurants/i, "XLY"],
  [/consumer defensive|food|beverage|household/i, "XLP"],
  [/financial|bank|insurance|asset management/i, "XLF"],
  [/healthcare|biotech|pharmaceutical|medical/i, "XLV"],
  [/industrial|aerospace|defense|machinery/i, "XLI"],
  [/energy|oil|gas|renewable/i, "XLE"],
  [/utilities/i, "XLU"],
  [/real estate|reit/i, "XLRE"],
  [/materials|chemicals|metals|mining/i, "XLB"],
];

const metric = (value) => {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object" && Number.isFinite(value.raw)) return value.raw;
  return null;
};

const fetchWithTimeout = (url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
};

const formatDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
};

const formatDateTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};

const fallbackText = (value, text = "Data unavailable") => value || text;
const formatPercent = (value) => (Number.isFinite(value) ? `${value.toFixed(1)}%` : "Data unavailable");
const formatRatioText = (value) => (Number.isFinite(value) ? value.toFixed(2) : "Data unavailable");

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const average = (values) => {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const parseXmlTag = (block, tag) => {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
};

const parseLooseNumber = (value, multiplier = 1) => {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value * multiplier : null;
  const cleaned = String(value)
    .replace(/[,$%]/g, "")
    .replace(/\((.*?)\)/, "-$1")
    .trim();
  if (!cleaned || cleaned === "-" || cleaned.toLowerCase() === "n/a") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed * multiplier : null;
};

const getSetCookieHeaders = (headers) => {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const singleHeader = headers.get("set-cookie");
  return singleHeader ? [singleHeader] : [];
};

const toCookieHeader = (setCookieHeaders) =>
  setCookieHeaders
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");

const getYahooSession = async (ticker) => {
  if (yahooSessionCache && Date.now() - yahooSessionCache.createdAt < YAHOO_SESSION_TTL_MS) {
    return yahooSessionCache;
  }

  const seedUrls = [`https://fc.yahoo.com`, `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`];
  let cookieHeader = "";

  for (const seedUrl of seedUrls) {
    try {
      const seedResponse = await fetchWithTimeout(seedUrl, {
        headers: {
          ...YAHOO_HEADERS,
          Referer: "https://finance.yahoo.com/",
        },
        redirect: "follow",
      }, SESSION_TIMEOUT_MS);
      const cookies = toCookieHeader(getSetCookieHeaders(seedResponse.headers));
      if (cookies) {
        cookieHeader = cookies;
        break;
      }
    } catch {
      // Try the next seed URL.
    }
  }

  if (!cookieHeader) {
    throw new Error("Unable to establish a Yahoo Finance session cookie.");
  }

  const crumbResponse = await fetchWithTimeout("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: {
      ...YAHOO_HEADERS,
      Cookie: cookieHeader,
      Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`,
    },
    redirect: "follow",
  }, SESSION_TIMEOUT_MS);

  if (!crumbResponse.ok) {
    throw new Error(`Yahoo crumb request failed (${crumbResponse.status})`);
  }

  const crumb = (await crumbResponse.text()).trim();
  if (!crumb || crumb.includes("Too Many Requests") || crumb.includes("<html")) {
    throw new Error("Unable to retrieve a valid Yahoo Finance crumb.");
  }

  yahooSessionCache = {
    cookieHeader,
    crumb,
    createdAt: Date.now(),
  };

  return yahooSessionCache;
};

const withYahooSession = async (url, session) => {
  const target = new URL(url);
  if (session?.crumb && (target.hostname.includes("query1.finance.yahoo.com") || target.hostname.includes("query2.finance.yahoo.com"))) {
    target.searchParams.set("crumb", session.crumb);
  }
  return fetchWithTimeout(target.toString(), {
    headers: {
      ...YAHOO_HEADERS,
      ...(session?.cookieHeader ? { Cookie: session.cookieHeader } : {}),
      Referer: "https://finance.yahoo.com/",
    },
    redirect: "follow",
  });
};

const fetchJson = async (url, session) => {
  const response = await withYahooSession(url, session);
  if (!response.ok) throw new Error(`Upstream request failed (${response.status})`);
  return response.json();
};

const fetchText = async (url, session) => {
  const response = await withYahooSession(url, session);
  if (!response.ok) throw new Error(`Upstream request failed (${response.status})`);
  return response.text();
};

const fetchPublicText = async (url) => {
  const response = await fetchWithTimeout(url, {
    headers: {
      ...YAHOO_HEADERS,
      Referer: "https://finance.yahoo.com/",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Upstream request failed (${response.status})`);
  return response.text();
};

const fetchCsv = async (url) => {
  const response = await fetchWithTimeout(url, {
    headers: {
      ...YAHOO_HEADERS,
      Accept: "text/csv,text/plain;q=0.9,*/*;q=0.8",
      Referer: "https://stooq.com/",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Upstream request failed (${response.status})`);
  return response.text();
};

const fetchNasdaqJson = async (url) => {
  const response = await fetchWithTimeout(url, {
    headers: {
      ...YAHOO_HEADERS,
      Accept: "application/json, text/plain, */*",
      Origin: "https://www.nasdaq.com",
      Referer: "https://www.nasdaq.com/",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Nasdaq request failed (${response.status})`);
  const payload = await response.json();
  if (payload?.status?.rCode && payload.status.rCode !== 200) {
    throw new Error(payload?.status?.developerMessage || "Nasdaq request returned no usable data");
  }
  return payload;
};

const extractRootAppData = (html) => {
  const marker = "root.App.main = ";
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const afterMarker = html.slice(start + marker.length);
  const end = afterMarker.indexOf(";\n");
  const candidate = (end >= 0 ? afterMarker.slice(0, end) : afterMarker).trim();
  if (!candidate) return null;

  try {
    return JSON.parse(candidate);
  } catch {
    const match = html.match(/root\.App\.main\s*=\s*(\{[\s\S]*?\})\s*;\s*(?:<\/script>|$)/);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
};

const deepMerge = (base, extra) => {
  if (!extra || typeof extra !== "object") return base;
  const output = { ...(base || {}) };

  for (const [key, value] of Object.entries(extra)) {
    if (Array.isArray(value)) {
      output[key] = value;
      continue;
    }

    if (value && typeof value === "object") {
      output[key] = deepMerge(output[key], value);
      continue;
    }

    output[key] = value;
  }

  return output;
};

const emptySummaryStore = () => ({
  price: {},
  financialData: {},
  summaryDetail: {},
  defaultKeyStatistics: {},
  summaryProfile: {},
  calendarEvents: {},
  earnings: {},
  incomeStatementHistoryQuarterly: { incomeStatementHistory: [] },
  balanceSheetHistoryQuarterly: { balanceSheetStatements: [] },
  cashflowStatementHistoryQuarterly: { cashflowStatements: [] },
});

const buildChartPointsFromYahooChart = (chartPayload) => {
  const chartResult = chartPayload.chart?.result?.[0];
  const timestamps = chartResult?.timestamp || [];
  const quote = chartResult?.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const volumes = quote.volume || [];
  return timestamps
    .map((timestamp, index) => {
      const close = closes[index];
      if (!Number.isFinite(close)) return null;
      const date = new Date(timestamp * 1000);
      return {
        date: date.toISOString().slice(0, 10),
        displayDate: formatDate(date),
        label: new Intl.DateTimeFormat("en-US", { month: "short" }).format(date),
        close,
        volume: Number.isFinite(volumes[index]) ? volumes[index] : null,
      };
    })
    .filter(Boolean);
};

const buildChartPointsFromStooqCsv = (csvText) => {
  const rows = csvText
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(","))
    .filter((columns) => columns.length >= 5 && columns[0] && columns[4] && columns[4] !== "N/D");

  return rows.map((columns) => {
    const date = columns[0].trim();
    const close = Number(columns[4]);
    if (!date || !Number.isFinite(close)) return null;
    const parsedDate = new Date(`${date}T00:00:00Z`);
    return {
      date,
      displayDate: formatDate(parsedDate),
      label: new Intl.DateTimeFormat("en-US", { month: "short" }).format(parsedDate),
      close,
      volume: Number(columns[5]) || null,
    };
  }).filter(Boolean);
};

const fetchAlternativeChartPoints = async (ticker) => {
  const end = new Date();
  const start = new Date();
  start.setFullYear(end.getFullYear() - 1);

  const stooqTicker = `${ticker.toLowerCase()}.us`;
  const stooqUrl = new URL("https://stooq.com/q/d/l/");
  stooqUrl.searchParams.set("s", stooqTicker);
  stooqUrl.searchParams.set("i", "d");
  stooqUrl.searchParams.set("d1", start.toISOString().slice(0, 10).replace(/-/g, ""));
  stooqUrl.searchParams.set("d2", end.toISOString().slice(0, 10).replace(/-/g, ""));

  try {
    const csvText = await fetchCsv(stooqUrl.toString());
    const points = buildChartPointsFromStooqCsv(csvText);
    if (points.length) {
      return {
        points,
        sourceLabel: "Stooq daily history",
      };
    }
  } catch {
    // Try the next fallback.
  }

  try {
    const nasdaqUrl = new URL(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/historical`);
    nasdaqUrl.searchParams.set("assetclass", "stocks");
    nasdaqUrl.searchParams.set("fromdate", start.toISOString().slice(0, 10));
    nasdaqUrl.searchParams.set("todate", end.toISOString().slice(0, 10));
    nasdaqUrl.searchParams.set("limit", "9999");
    const payload = await fetchNasdaqJson(nasdaqUrl.toString());
    const rows = payload?.data?.tradesTable?.rows || [];
    const points = rows
      .map((row) => {
        const [month, day, year] = String(row.date || "").split("/");
        const date = year && month && day ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : null;
        const close = parseLooseNumber(row.close);
        if (!date || !Number.isFinite(close)) return null;
        const parsedDate = new Date(`${date}T00:00:00Z`);
        return {
          date,
          displayDate: formatDate(parsedDate),
          label: new Intl.DateTimeFormat("en-US", { month: "short" }).format(parsedDate),
          close,
          volume: parseLooseNumber(row.volume),
        };
      })
      .filter(Boolean)
      .reverse();

    if (points.length) {
      return {
        points,
        sourceLabel: "Nasdaq public historical prices",
      };
    }
  } catch {
    // Try the next fallback.
  }

  const fmpUrl = new URL(`https://financialmodelingprep.com/api/v3/historical-price-full/${encodeURIComponent(ticker)}`);
  fmpUrl.searchParams.set("from", start.toISOString().slice(0, 10));
  fmpUrl.searchParams.set("to", end.toISOString().slice(0, 10));
  fmpUrl.searchParams.set("apikey", FMP_API_KEY);

  try {
    const payload = await fetchWithTimeout(fmpUrl.toString(), {
      headers: {
        ...YAHOO_HEADERS,
        Accept: "application/json",
      },
      redirect: "follow",
    }).then((response) => {
      if (!response.ok) throw new Error(`Upstream request failed (${response.status})`);
      return response.json();
    });

    const points = Array.isArray(payload?.historical)
      ? payload.historical
          .map((row) => {
            const date = row.date;
            const close = Number(row.close ?? row.adjClose);
            if (!date || !Number.isFinite(close)) return null;
            const parsedDate = new Date(`${date}T00:00:00Z`);
            return {
              date,
              displayDate: formatDate(parsedDate),
              label: new Intl.DateTimeFormat("en-US", { month: "short" }).format(parsedDate),
              close,
              volume: Number(row.volume) || null,
            };
          })
          .filter(Boolean)
          .reverse()
      : [];

    if (points.length) {
      return {
        points,
        sourceLabel: FMP_API_KEY === "demo" ? "Financial Modeling Prep demo history" : "Financial Modeling Prep history",
      };
    }
  } catch {
    // Try the next fallback.
  }

  const adgUrl = `https://stocks.adgstudios.co.za/json/${encodeURIComponent(ticker)}`;
  try {
    const payload = await fetchWithTimeout(adgUrl, {
      headers: {
        ...YAHOO_HEADERS,
        Accept: "application/json",
      },
      redirect: "follow",
    }).then((response) => {
      if (!response.ok) throw new Error(`Upstream request failed (${response.status})`);
      return response.json();
    });

    const points = Array.isArray(payload)
      ? payload
          .map((row) => {
            const date = row.date || row.Date;
            const close = Number(row.close ?? row.Close);
            if (!date || !Number.isFinite(close)) return null;
            const parsedDate = new Date(`${date}T00:00:00Z`);
            return {
              date,
              displayDate: formatDate(parsedDate),
              label: new Intl.DateTimeFormat("en-US", { month: "short" }).format(parsedDate),
              close,
              volume: Number(row.volume ?? row.Volume) || null,
            };
          })
          .filter(Boolean)
      : [];

    if (points.length) {
      return {
        points,
        sourceLabel: "ADG Studios historical prices",
      };
    }
  } catch {
    // No further fallback.
  }

  try {
    const end = new Date();
    const start = new Date();
    start.setFullYear(end.getFullYear() - 1);
    const nasdaqUrl = new URL(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/historical`);
    nasdaqUrl.searchParams.set("assetclass", "stocks");
    nasdaqUrl.searchParams.set("fromdate", start.toISOString().slice(0, 10));
    nasdaqUrl.searchParams.set("todate", end.toISOString().slice(0, 10));
    nasdaqUrl.searchParams.set("limit", "9999");
    const payload = await fetchNasdaqJson(nasdaqUrl.toString());
    const rows = payload?.data?.tradesTable?.rows || [];
    const points = rows
      .map((row) => {
        const [month, day, year] = String(row.date || "").split("/");
        const date = year && month && day ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : null;
        const close = parseLooseNumber(row.close);
        if (!date || !Number.isFinite(close)) return null;
        const parsedDate = new Date(`${date}T00:00:00Z`);
        return {
          date,
          displayDate: formatDate(parsedDate),
          label: new Intl.DateTimeFormat("en-US", { month: "short" }).format(parsedDate),
          close,
          volume: parseLooseNumber(row.volume),
        };
      })
      .filter(Boolean)
      .reverse();

    if (points.length) {
      return {
        points,
        sourceLabel: "Nasdaq public historical prices",
      };
    }
  } catch {
    // No further fallback.
  }

  throw new Error(`Alternative price history was unavailable for ${ticker}.`);
};

const fetchYahooChartPoints = async (ticker, range, session) => {
  const chartUrl = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  chartUrl.searchParams.set("range", range);
  chartUrl.searchParams.set("interval", "1d");
  chartUrl.searchParams.set("includePrePost", "false");
  chartUrl.searchParams.set("events", "div,splits");
  chartUrl.searchParams.set("lang", "en-US");
  chartUrl.searchParams.set("region", "US");
  const payload = await fetchJson(chartUrl.toString(), session);
  return buildChartPointsFromYahooChart(payload);
};

const findStatus = (riskValue, thresholds) => {
  if (riskValue <= thresholds.good) return "favorable";
  if (riskValue >= thresholds.bad) return "weak";
  return "mixed";
};

const scoreFromThresholds = (value, favorable, cautious, adverse, direction = "higher-better") => {
  if (!Number.isFinite(value)) return 55;
  if (direction === "lower-better") {
    if (value <= favorable) return 12;
    if (value <= cautious) return 38;
    if (value <= adverse) return 68;
    return 88;
  }

  if (value >= favorable) return 12;
  if (value >= cautious) return 38;
  if (value >= adverse) return 68;
  return 88;
};

const nearestReturn = (points, daysAgo) => {
  if (!points?.length) return null;
  const latest = points.at(-1);
  const targetTime = new Date(latest.date).getTime() - daysAgo * 24 * 60 * 60 * 1000;
  const candidate = [...points].reverse().find((point) => new Date(point.date).getTime() <= targetTime) || points[0];
  return Number.isFinite(candidate?.close) && Number.isFinite(latest?.close) && candidate.close !== 0
    ? ((latest.close - candidate.close) / candidate.close) * 100
    : null;
};

const simpleMovingAverage = (points, length) => {
  const closes = points.slice(-length).map((point) => point.close).filter(Number.isFinite);
  return closes.length >= Math.min(length, 20) ? average(closes) : null;
};

const calculateRsi = (points, length = 14) => {
  const closes = points.map((point) => point.close).filter(Number.isFinite);
  if (closes.length <= length) return null;
  let gains = 0;
  let losses = 0;
  const slice = closes.slice(-length - 1);
  for (let index = 1; index < slice.length; index += 1) {
    const change = slice[index] - slice[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
};

const buildTechnical = (points, currentPrice) => {
  const sma50 = simpleMovingAverage(points, 50);
  const sma200 = simpleMovingAverage(points, 200);
  const rsi14 = calculateRsi(points);
  const recent = points.slice(-63);
  const support = recent.length ? Math.min(...recent.map((point) => point.close).filter(Number.isFinite)) : null;
  const resistance = recent.length ? Math.max(...recent.map((point) => point.close).filter(Number.isFinite)) : null;
  const latestVolume = points.at(-1)?.volume;
  const avgVolume30 = average(points.slice(-30).map((point) => point.volume).filter(Number.isFinite));
  const volumeRatio = Number.isFinite(latestVolume) && Number.isFinite(avgVolume30) && avgVolume30 > 0 ? latestVolume / avgVolume30 : null;
  const trend =
    Number.isFinite(currentPrice) && Number.isFinite(sma50) && Number.isFinite(sma200)
      ? currentPrice > sma50 && sma50 > sma200
        ? "Uptrend"
        : currentPrice < sma50 && sma50 < sma200
          ? "Downtrend"
          : "Mixed trend"
      : "Data unavailable";
  const trendTone = trend === "Uptrend" ? "green" : trend === "Downtrend" ? "red" : "amber";
  const rsiLabel = !Number.isFinite(rsi14) ? "Unavailable" : rsi14 >= 70 ? "Overbought" : rsi14 <= 30 ? "Oversold" : "Neutral";
  const rsiTone = rsiLabel === "Overbought" ? "red" : rsiLabel === "Oversold" ? "amber" : "green";
  const volumeTrend = Number.isFinite(volumeRatio)
    ? volumeRatio >= 1.25
      ? "Above average"
      : volumeRatio <= 0.75
        ? "Below average"
        : "Normal"
    : "Data unavailable";

  return {
    sma50,
    sma200,
    rsi14,
    rsiLabel,
    rsiTone,
    support,
    resistance,
    volumeTrend,
    volumeTone: volumeTrend === "Above average" ? "amber" : "green",
    trend,
    trendTone,
    summary:
      trend === "Data unavailable"
        ? "Technical signals were unavailable because the price history was incomplete."
        : `${trend}. Price is ${Number.isFinite(sma50) && currentPrice >= sma50 ? "above" : "below"} the 50-day average and ${
            Number.isFinite(sma200) && currentPrice >= sma200 ? "above" : "below"
          } the 200-day average. RSI is ${rsiLabel.toLowerCase()}, so technical risk is a supporting signal rather than the core driver of the rating.`,
  };
};

const pickSectorEtf = (sector = "", industry = "") => {
  const haystack = `${sector} ${industry}`;
  return SECTOR_ETF_BY_KEYWORD.find(([pattern]) => pattern.test(haystack))?.[1] || "SPY";
};

const buildRating = (scoring, quote, dataQualityPenalty = 0) => {
  const risk = scoring.totalScore;
  const growthSupport = Number.isFinite(quote.revenueGrowth) && quote.revenueGrowth > 10;
  let label = "Hold";
  if (risk <= 25 && growthSupport) label = "Strong Buy";
  else if (risk <= 42) label = "Buy";
  else if (risk <= 64) label = "Hold";
  else if (risk <= 82) label = "Sell";
  else label = "Strong Sell";

  const tone = label.includes("Buy") ? "green" : label.includes("Sell") ? "red" : "amber";
  const confidence = clamp(Math.round(8 - dataQualityPenalty - (risk > 75 ? 1 : 0)), 3, 9);
  const investorType = risk <= 30 ? "Conservative" : risk <= 55 ? "Balanced" : risk <= 78 ? "Aggressive" : "Speculative";
  const timeHorizon = risk <= 45 ? "Long-term" : risk <= 70 ? "Medium-term" : "Short-term";
  const barPosition = { "Strong Sell": 10, Sell: 30, Hold: 50, Buy: 72, "Strong Buy": 92 }[label];
  return { label, tone, confidence, investorType, timeHorizon, barPosition };
};

const buildSources = (ticker, sectorEtf, sourceLabel) => [
  { label: "Yahoo Finance quote, fundamentals, chart, and headline feed", url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}` },
  { label: "Yahoo Finance key statistics", url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/key-statistics` },
  { label: "Yahoo Finance financial statements", url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/financials` },
  { label: "Stooq historical prices fallback", url: `https://stooq.com/q/?s=${encodeURIComponent(ticker.toLowerCase())}.us` },
  { label: `Sector ETF proxy ${sectorEtf}`, url: `https://finance.yahoo.com/quote/${encodeURIComponent(sectorEtf)}` },
  { label: sourceLabel, url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}` },
];

const rssClassify = (items) => {
  const catalysts = [];
  const risks = [];
  let latestEarnings = null;
  let latestDelivery = null;

  const positiveTerms = ["beat", "surge", "wins", "approval", "launch", "raises", "record", "growth", "expands"];
  const negativeTerms = ["miss", "probe", "cut", "delay", "recall", "tariff", "lawsuit", "risk", "slump", "warning"];

  for (const item of items) {
    const haystack = `${item.title} ${item.description}`.toLowerCase();
    if (!latestEarnings && /(earnings|results|quarter|revenue|eps)/i.test(haystack)) latestEarnings = item;
    if (!latestDelivery && /(delivery|deliveries|shipments|production)/i.test(haystack)) latestDelivery = item;

    if (positiveTerms.some((term) => haystack.includes(term)) && catalysts.length < 4) {
      catalysts.push(`${item.title} (${item.displayDate})`);
      continue;
    }

    if (negativeTerms.some((term) => haystack.includes(term)) && risks.length < 4) {
      risks.push(`${item.title} (${item.displayDate})`);
    }
  }

  return {
    catalysts,
    risks,
    latestEarnings,
    latestDelivery,
  };
};

const buildQuarterlySeries = (summary) => {
  const income = summary.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
  const balance = summary.balanceSheetHistoryQuarterly?.balanceSheetStatements || [];
  const cashflow = summary.cashflowStatementHistoryQuarterly?.cashflowStatements || [];

  return income.slice(0, 4).map((statement, index) => {
    const revenue = metric(statement.totalRevenue);
    const operatingIncome = metric(statement.operatingIncome);
    const netIncome = metric(statement.netIncome);
    const grossProfit = metric(statement.grossProfit);
    const shareCount =
      metric(statement.basicAverageShares) ||
      metric(statement.dilutedAverageShares) ||
      metric(summary.price?.sharesOutstanding);
    const eps = Number.isFinite(metric(statement.dilutedEPS))
      ? metric(statement.dilutedEPS)
      : Number.isFinite(netIncome) && Number.isFinite(shareCount) && shareCount > 0
        ? netIncome / shareCount
        : null;
    const operatingMargin = Number.isFinite(revenue) && revenue !== 0 && Number.isFinite(operatingIncome) ? (operatingIncome / revenue) * 100 : null;
    const grossMargin = Number.isFinite(revenue) && revenue !== 0 && Number.isFinite(grossProfit) ? (grossProfit / revenue) * 100 : null;
    const cf = cashflow[index] || {};
    const freeCashFlow = metric(cf.freeCashFlow);
    const bs = balance[index] || {};
    const cash = metric(bs.cashAndCashEquivalents) || metric(bs.cash);
    const debt =
      (metric(bs.longTermDebt) || 0) +
      (metric(bs.shortLongTermDebt) || 0) +
      (metric(bs.currentLongTermDebt) || 0) +
      (metric(bs.shortTermDebt) || 0);
    const dateText = statement.endDate?.fmt || statement.endDate?.raw || statement.maxAge;
    return {
      label: formatDate(dateText) || `Q${index + 1}`,
      revenue,
      revenueGrowthYoY: index === 0 && metric(summary.financialData?.revenueGrowth) != null ? metric(summary.financialData?.revenueGrowth) * 100 : null,
      operatingIncome,
      netIncome,
      eps,
      grossMargin,
      operatingMargin,
      freeCashFlow,
      cash,
      debt,
    };
  });
};

const scoreReport = (data) => {
  const valuationMetrics = [
    scoreFromThresholds(data.trailingPE, 22, 35, 60, "lower-better"),
    scoreFromThresholds(data.forwardPE, 20, 32, 55, "lower-better"),
    scoreFromThresholds(data.enterpriseToEbitda, 12, 18, 26, "lower-better"),
    scoreFromThresholds(data.enterpriseToRevenue, 3, 6, 10, "lower-better"),
    scoreFromThresholds(data.priceToSales, 4, 8, 14, "lower-better"),
    scoreFromThresholds(data.priceToBook, 4, 8, 14, "lower-better"),
    scoreFromThresholds(data.freeCashFlowYield, 5, 1, -2),
  ];
  const financialHealthMetrics = [
    scoreFromThresholds(data.netCashToMarketCap, 0.03, 0, -0.05),
    scoreFromThresholds(data.currentRatio, 1.6, 1.1, 0.8),
    scoreFromThresholds(data.debtToEquity, 0.6, 1.2, 2.2, "lower-better"),
    scoreFromThresholds(data.freeCashFlowMargin, 8, 3, 0),
    scoreFromThresholds(data.netMargin, 15, 5, 0),
  ];
  const growthMetrics = [
    scoreFromThresholds(data.revenueGrowth, 16, 7, 0),
    scoreFromThresholds(data.earningsGrowth, 15, 5, 0),
    scoreFromThresholds(data.earningsQuarterlyGrowth, 15, 5, 0),
    scoreFromThresholds(data.operatingMargin, 16, 8, 0),
  ];

  const valuationScore = average(valuationMetrics) ?? 55;
  const financialHealthScore = average(financialHealthMetrics) ?? 55;
  const growthScore = average(growthMetrics) ?? 55;

  const breakdown = [
    { label: "Valuation", weight: 35, rawScore: valuationScore, weightedContribution: (valuationScore * 35) / 100 },
    {
      label: "Financial Health",
      weight: 35,
      rawScore: financialHealthScore,
      weightedContribution: (financialHealthScore * 35) / 100,
    },
    { label: "Growth", weight: 30, rawScore: growthScore, weightedContribution: (growthScore * 30) / 100 },
  ];

  const totalScore = breakdown.reduce((sum, item) => sum + item.weightedContribution, 0);
  const label = totalScore <= 25 ? "Low" : totalScore <= 50 ? "Moderate" : totalScore <= 75 ? "Elevated" : "High";
  const verdict = totalScore <= 30 ? "Attractive" : totalScore <= 55 ? "Watchlist" : totalScore <= 75 ? "Cautious" : "High Risk";

  return {
    totalScore,
    label,
    verdict,
    breakdown,
    summary:
      totalScore <= 30
        ? "Balance sheet and growth signals offset valuation pressure, producing a lower-risk setup."
        : totalScore <= 55
          ? "The setup is investable but still asks for monitoring around valuation, execution, or balance-sheet trends."
          : totalScore <= 75
            ? "Multiple metrics sit in caution territory, so the stock needs cleaner execution to compress risk."
            : "The weighted model flags elevated valuation, balance-sheet, or growth stress relative to the current setup.",
  };
};

const buildCards = (data, scoring, newsSummary, chartMeta) => {
  const valuationRisk = scoring.breakdown[0].rawScore;
  const financialRisk = scoring.breakdown[1].rawScore;
  const growthRisk = scoring.breakdown[2].rawScore;

  return [
    {
      title: "Valuation",
      status: findStatus(valuationRisk, { good: 35, bad: 70 }),
      badge: valuationRisk <= 35 ? "Reasonable" : valuationRisk >= 70 ? "Stretched" : "Mixed",
      points: [
        `Trailing P/E ${data.trailingPE != null ? data.trailingPE.toFixed(1) : "unavailable"}.`,
        `EV / EBITDA ${data.enterpriseToEbitda != null ? data.enterpriseToEbitda.toFixed(1) : "unavailable"} and EV / Sales ${data.enterpriseToRevenue != null ? data.enterpriseToRevenue.toFixed(1) : "unavailable"}.`,
        `Price-to-sales ${data.priceToSales != null ? data.priceToSales.toFixed(1) : "unavailable"} leaves the stock ${valuationRisk > 60 ? "priced for clean execution." : "within a more defendable range."}`,
      ],
      source: "Source: Yahoo Finance valuation fields.",
    },
    {
      title: "Profitability",
      status: findStatus(100 - scoreFromThresholds(data.operatingMargin, 18, 10, 0), { good: 40, bad: 70 }),
      badge: data.operatingMargin >= 15 ? "Strong" : data.operatingMargin <= 5 ? "Weak" : "Mixed",
      points: [
        `Gross margin ${data.grossMargin != null ? `${data.grossMargin.toFixed(1)}%` : "unavailable"}.`,
        `Operating margin ${data.operatingMargin != null ? `${data.operatingMargin.toFixed(1)}%` : "unavailable"}.`,
        `Return on equity ${data.returnOnEquity != null ? `${data.returnOnEquity.toFixed(1)}%` : "unavailable"} shows ${data.returnOnEquity > 15 ? "healthy capital efficiency." : "limited efficiency."}`,
      ],
      source: "Source: Yahoo Finance financialData.",
    },
    {
      title: "Financial Health",
      status: findStatus(financialRisk, { good: 35, bad: 70 }),
      badge: financialRisk <= 35 ? "Resilient" : financialRisk >= 70 ? "Fragile" : "Watch",
      points: [
        `Cash ${data.totalCash != null ? `$${(data.totalCash / 1e9).toFixed(1)}B` : "unavailable"} vs debt ${data.totalDebt != null ? `$${(data.totalDebt / 1e9).toFixed(1)}B` : "unavailable"}.`,
        `Current ratio ${data.currentRatio != null ? data.currentRatio.toFixed(2) : "unavailable"} and debt / equity ${data.debtToEquity != null ? data.debtToEquity.toFixed(2) : "unavailable"}.`,
        `${data.netCashToMarketCap > 0 ? "Net cash supports flexibility." : "Debt load trims optionality."}`,
      ],
      source: "Source: Yahoo Finance balance-sheet fields.",
    },
    {
      title: "Growth",
      status: findStatus(growthRisk, { good: 35, bad: 70 }),
      badge: growthRisk <= 35 ? "Accelerating" : growthRisk >= 70 ? "Slowing" : "Mixed",
      points: [
        `Revenue growth ${data.revenueGrowth != null ? `${data.revenueGrowth.toFixed(1)}%` : "unavailable"}.`,
        `Earnings growth ${data.earningsGrowth != null ? `${data.earningsGrowth.toFixed(1)}%` : "unavailable"} with quarterly growth ${data.earningsQuarterlyGrowth != null ? `${data.earningsQuarterlyGrowth.toFixed(1)}%` : "unavailable"}.`,
        `${data.revenueGrowth > 10 ? "Top-line momentum remains constructive." : "Growth needs reacceleration to support the multiple."}`,
      ],
      source: "Source: Yahoo Finance growth fields.",
    },
    {
      title: "Sentiment / Momentum",
      status: chartMeta.returnPercent > 18 ? "strong" : chartMeta.returnPercent < -8 ? "weak" : "mixed",
      badge: chartMeta.returnPercent > 18 ? "Positive" : chartMeta.returnPercent < -8 ? "Pressure" : "Balanced",
      points: [
        `12-month return ${chartMeta.returnPercent != null ? `${chartMeta.returnPercent.toFixed(1)}%` : "unavailable"}.`,
        `Drawdown from high ${chartMeta.drawdownFromHigh != null ? `${chartMeta.drawdownFromHigh.toFixed(1)}%` : "unavailable"}.`,
        `${newsSummary.catalysts.length ? "Recent headlines still provide upside catalysts." : "Headline support is limited and price action matters more here."}`,
      ],
      source: "Source: Yahoo/Stooq price history and public headlines.",
    },
    {
      title: "Risk Flags",
      status: scoring.totalScore > 70 ? "high-risk" : scoring.totalScore < 35 ? "strong" : "mixed",
      badge: scoring.totalScore > 70 ? "Flagged" : scoring.totalScore < 35 ? "Contained" : "Watch",
      points: [
        data.beta != null ? `Beta ${data.beta.toFixed(2)} implies ${data.beta > 1.6 ? "above-market volatility." : "manageable volatility."}` : "Beta unavailable.",
        `${data.freeCashFlowMargin < 0 ? "Free cash flow is negative, which raises financing sensitivity." : "Free cash flow remains positive, cushioning execution swings."}`,
        newsSummary.risks[0] || "No clear recent headline risk was detected in the fetched feed.",
      ],
      source: "Source: weighted risk model plus fetched data quality.",
    },
  ];
};

const buildBottomLine = (quote, scoring, chartMeta, newsSummary) => {
  const positiveDriver =
    quote.revenueGrowth > 10
      ? "revenue growth is still healthy"
      : quote.netCashToMarketCap > 0
        ? "balance-sheet flexibility remains a support"
        : "the current setup still has optionality";
  const riskDriver =
    scoring.breakdown[0].rawScore > 65
      ? "valuation remains the main source of downside sensitivity"
      : scoring.breakdown[1].rawScore > 65
        ? "financial resilience needs closer monitoring"
        : "growth durability is the main question";

  return `${quote.companyName} lands in ${scoring.verdict} territory because ${positiveDriver}, but ${riskDriver}. ${
    chartMeta.drawdownFromHigh > 20
      ? "Price is still meaningfully below its 12-month high, so sentiment has room to improve if execution stabilizes."
      : "Momentum is not deeply broken, which helps the setup if coming updates cooperate."
  } ${newsSummary.latestEarnings ? "The latest headline flow still matters for near-term direction." : "Without a strong recent headline catalyst, the fundamentals carry more weight."}`;
};

const parseRssItems = (xmlText) => {
  const items = xmlText.match(/<item>([\s\S]*?)<\/item>/gi) || [];
  return items.slice(0, 10).map((item) => ({
    title: parseXmlTag(item, "title"),
    link: parseXmlTag(item, "link"),
    pubDate: parseXmlTag(item, "pubDate"),
    displayDate: formatDate(parseXmlTag(item, "pubDate")) || "Recent",
    description: parseXmlTag(item, "description"),
  }));
};

const buildChartEvents = (chartPoints, summary, newsSummary) => {
  const events = [];
  const highest = [...chartPoints].sort((a, b) => b.close - a.close)[0];
  const lowest = [...chartPoints].sort((a, b) => a.close - b.close)[0];

  if (highest) {
    events.push({
      label: "12M high",
      detail: `Highest close in the last year at ${highest.close.toFixed(2)}.`,
      displayDate: highest.displayDate,
      chartDate: highest.date,
      color: "#57d0ff",
    });
  }

  if (lowest) {
    events.push({
      label: "12M low",
      detail: `Lowest close in the last year at ${lowest.close.toFixed(2)}.`,
      displayDate: lowest.displayDate,
      chartDate: lowest.date,
      color: "#ff6f7d",
    });
  }

  const earningsDateRaw = summary.calendarEvents?.earnings?.earningsDate?.[0]?.fmt || summary.calendarEvents?.earnings?.earningsDate?.[0];
  if (earningsDateRaw) {
    const chartDate = chartPoints.find((point) => point.date === new Date(earningsDateRaw).toISOString().slice(0, 10));
    if (chartDate) {
      events.push({
        label: "Earnings",
        detail: "Latest earnings date returned by the provider.",
        displayDate: chartDate.displayDate,
        chartDate: chartDate.date,
        color: "#ffbf5f",
      });
    }
  }

  if (newsSummary.latestDelivery) {
    const deliveryDate = new Date(newsSummary.latestDelivery.pubDate).toISOString().slice(0, 10);
    const chartDate = chartPoints.find((point) => point.date === deliveryDate);
    if (chartDate) {
      events.push({
        label: "Delivery",
        detail: newsSummary.latestDelivery.title,
        displayDate: chartDate.displayDate,
        chartDate: chartDate.date,
        color: "#4fd68b",
      });
    }
  }

  return events.slice(0, 4);
};

const buildPayloadFromStores = (ticker, summary, chartPoints, sourceLabel = "Yahoo Finance page data and public chart endpoints") => {
  const priceStore = summary.price || {};
  const financialData = summary.financialData || {};
  const summaryDetail = summary.summaryDetail || {};
  const defaultKeyStatistics = summary.defaultKeyStatistics || {};
  const summaryProfile = summary.summaryProfile || {};
  const quarterly = buildQuarterlySeries(summary);

  chartPoints.forEach((point, index) => {
    const previous = chartPoints[index - 1];
    point.deltaLabel = previous
      ? `${(((point.close - previous.close) / previous.close) * 100).toFixed(1)}% vs prior close`
      : "Starting point";
  });

  const currentPrice = metric(priceStore.regularMarketPrice) || chartPoints.at(-1)?.close || null;
  const previousClose = metric(summaryDetail.previousClose);
  const dailyChangePercent =
    Number.isFinite(currentPrice) && Number.isFinite(previousClose) && previousClose !== 0
      ? ((currentPrice - previousClose) / previousClose) * 100
      : 0;
  const marketCap = metric(priceStore.marketCap);
  const totalCash = metric(financialData.totalCash);
  const totalDebt = metric(financialData.totalDebt);
  const currentRatio = metric(financialData.currentRatio);
  const debtToEquity = metric(financialData.debtToEquity);
  const freeCashflow = metric(financialData.freeCashflow) || metric(financialData.freeCashFlow);
  const revenue = metric(financialData.totalRevenue);
  const grossMargin = metric(financialData.grossMargins) != null ? metric(financialData.grossMargins) * 100 : null;
  const operatingMargin = metric(financialData.operatingMargins) != null ? metric(financialData.operatingMargins) * 100 : null;
  const revenueGrowth = metric(financialData.revenueGrowth) != null ? metric(financialData.revenueGrowth) * 100 : null;
  const earningsGrowth = metric(financialData.earningsGrowth) != null ? metric(financialData.earningsGrowth) * 100 : null;
  const earningsQuarterlyGrowth =
    metric(defaultKeyStatistics.earningsQuarterlyGrowth) != null ? metric(defaultKeyStatistics.earningsQuarterlyGrowth) * 100 : null;
  const trailingPE = metric(summaryDetail.trailingPE);
  const forwardPE = metric(summaryDetail.forwardPE);
  const enterpriseToEbitda = metric(defaultKeyStatistics.enterpriseToEbitda);
  const enterpriseToRevenue = metric(defaultKeyStatistics.enterpriseToRevenue);
  const priceToSales = metric(summaryDetail.priceToSalesTrailing12Months);
  const priceToBook = metric(defaultKeyStatistics.priceToBook);
  const beta = metric(summaryDetail.beta);
  const returnOnEquity = metric(financialData.returnOnEquity) != null ? metric(financialData.returnOnEquity) * 100 : null;
  const profitMargins = metric(financialData.profitMargins) != null ? metric(financialData.profitMargins) * 100 : null;
  const netCashToMarketCap =
    Number.isFinite(totalCash) && Number.isFinite(totalDebt) && Number.isFinite(marketCap) && marketCap > 0 ? (totalCash - totalDebt) / marketCap : 0;
  const freeCashFlowMargin =
    Number.isFinite(freeCashflow) && Number.isFinite(revenue) && revenue !== 0 ? (freeCashflow / revenue) * 100 : null;
  const freeCashFlowYield = Number.isFinite(freeCashflow) && Number.isFinite(marketCap) && marketCap > 0 ? (freeCashflow / marketCap) * 100 : null;
  const sectorEtf = pickSectorEtf(summaryProfile.sector, summaryProfile.industry);

  const quoteData = {
    ticker,
    companyName: priceStore.longName || priceStore.shortName || PRESET_COMPANY_NAMES[ticker] || ticker,
    exchange: priceStore.exchangeName || priceStore.fullExchangeName || priceStore.exchange || null,
    source: sourceLabel,
    currentPrice,
    previousClose,
    dailyChangePercent,
    updatedAtLabel: formatDateTime(priceStore.regularMarketTime ? priceStore.regularMarketTime * 1000 : Date.now()),
    marketCap,
    sectorLabel: fallbackText(summaryProfile.sector, "Sector unavailable"),
    industry: fallbackText(summaryProfile.industry, "Industry unavailable"),
    currency: priceStore.currency || "USD",
    fiftyTwoWeekHigh: metric(summaryDetail.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: metric(summaryDetail.fiftyTwoWeekLow),
    trailingPE,
    forwardPE,
    enterpriseToEbitda,
    enterpriseToRevenue,
    priceToSales,
    priceToBook,
    revenueGrowth,
    earningsGrowth,
    earningsQuarterlyGrowth,
    grossMargin,
    operatingMargin,
    netMargin: profitMargins,
    totalCash,
    totalDebt,
    netCashToMarketCap,
    netCashLabel:
      Number.isFinite(totalCash) && Number.isFinite(totalDebt)
        ? totalCash >= totalDebt
          ? `Net cash +${((totalCash - totalDebt) / 1e9).toFixed(1)}B`
          : `Net debt ${((totalDebt - totalCash) / 1e9).toFixed(1)}B`
        : "Capital structure unavailable",
    currentRatio,
    debtToEquity,
    freeCashFlowMargin,
    freeCashFlowYield,
    beta,
    returnOnEquity,
  };

  const scoring = scoreReport(quoteData);
  const chartMeta = {
    points: chartPoints,
    low: Math.min(...chartPoints.map((point) => point.close)),
    high: Math.max(...chartPoints.map((point) => point.close)),
    returnPercent: chartPoints.length > 1 ? ((chartPoints.at(-1).close - chartPoints[0].close) / chartPoints[0].close) * 100 : 0,
    drawdownFromHigh:
      ((Math.max(...chartPoints.map((point) => point.close)) - chartPoints.at(-1).close) /
        Math.max(...chartPoints.map((point) => point.close))) *
      100,
  };

  const earningsDateRaw = summary.calendarEvents?.earnings?.earningsDate?.[0]?.fmt || summary.earnings?.financialsChart?.quarterly?.[0]?.date;
  const newsSummary = {
    catalysts: [
      revenueGrowth > 10 ? "Revenue growth remains supportive of the operating story." : "Any reacceleration in revenue would improve sentiment.",
      totalCash > totalDebt ? "Net cash flexibility still supports downside resilience." : "Capital structure repair would strengthen the setup.",
      earningsDateRaw ? `Next earnings marker sits around ${formatDate(earningsDateRaw)}.` : "The next earnings release is still the key near-term catalyst.",
    ],
    risks: [
      scoring.breakdown[0].rawScore > 65 ? "Valuation remains demanding relative to current fundamentals." : "Multiple support depends on continued execution.",
      freeCashFlowMargin < 0 ? "Free cash flow remains weak, raising sensitivity to misses." : "A margin slip would change the risk profile quickly.",
      beta > 1.6 ? "High beta implies elevated headline-driven volatility." : "Macro sensitivity remains a watch item.",
    ],
    latestEarnings: null,
    latestDelivery: null,
  };

  chartMeta.events = buildChartEvents(chartPoints, summary, newsSummary);
  const cards = buildCards(quoteData, scoring, newsSummary, chartMeta);
  const bottomLine = buildBottomLine(quoteData, scoring, chartMeta, newsSummary);
  const technical = buildTechnical(chartPoints, quoteData.currentPrice);
  const performance = {
    oneMonth: nearestReturn(chartPoints, 30),
    sixMonth: nearestReturn(chartPoints, 182),
    oneYear: chartMeta.returnPercent,
    fiveYear: null,
    sp500OneYear: null,
    sectorEtfOneYear: null,
    sectorEtf,
  };
  const missingCount = [
    quoteData.trailingPE,
    quoteData.forwardPE,
    quoteData.enterpriseToEbitda,
    quoteData.priceToSales,
    quoteData.priceToBook,
    quoteData.freeCashFlowYield,
    quoteData.debtToEquity,
    quoteData.netMargin,
    quoteData.revenueGrowth,
  ].filter((value) => !Number.isFinite(value)).length;
  const rating = buildRating(scoring, quoteData, Math.min(3, missingCount / 3));

  return {
    quote: quoteData,
    scoring,
    rating,
    chart: chartMeta,
    technical,
    performance,
    quarterly,
    cards,
    sources: buildSources(ticker, sectorEtf, sourceLabel),
    narrative: {
      latestSummary: quarterly[0]
        ? `The latest available quarter shows revenue ${quarterly[0].revenue != null ? "around " + (quarterly[0].revenue / 1e9).toFixed(1) + "B" : "unavailable"}, operating margin ${quarterly[0].operatingMargin != null ? quarterly[0].operatingMargin.toFixed(1) + "%" : "unavailable"}, and free cash flow ${quarterly[0].freeCashFlow != null ? "$" + (quarterly[0].freeCashFlow / 1e9).toFixed(1) + "B" : "unavailable"}.`
        : "Detailed earnings text was not available from the fallback source, so the report is leaning on the latest page-level financial fields.",
      latestMeta: earningsDateRaw ? formatDate(earningsDateRaw) : "Most recent financial snapshot",
      deliverySummary: /TSLA/i.test(ticker)
        ? "Delivery-specific headline data was unavailable from the fallback path, so use Tesla's next production and delivery release as a key checkpoint."
        : "No delivery-specific update is relevant for this ticker, so the report emphasizes earnings, valuation, and balance-sheet signals.",
      deliveryMeta: "Fallback provider context",
      importantDates: earningsDateRaw ? `Next or latest earnings marker: ${formatDate(earningsDateRaw)}.` : "Earnings calendar data unavailable from the fallback source.",
      companyOverview: `${quoteData.companyName} operates in ${quoteData.industry || "an unavailable industry"} within ${quoteData.sectorLabel}. The report uses provider profile data when available; otherwise this description is intentionally limited.`,
      competitorSummary: "Peer and revenue-source detail was not fully available from the fallback source, so peer comparisons are treated as estimated and sector-level.",
      newsContext: newsSummary.latestEarnings ? newsSummary.latestEarnings.title : "Recent headline detail was limited in fallback mode.",
      financialHealth: `Revenue growth is ${formatPercent(revenueGrowth)}, free cash flow margin is ${formatPercent(freeCashFlowMargin)}, and net margin is ${formatPercent(profitMargins)}.`,
      balanceSheet: `Cash is ${Number.isFinite(totalCash) ? "$" + (totalCash / 1e9).toFixed(1) + "B" : "unavailable"} versus debt of ${Number.isFinite(totalDebt) ? "$" + (totalDebt / 1e9).toFixed(1) + "B" : "unavailable"}.`,
      marginSummary: `Gross margin is ${formatPercent(grossMargin)}, operating margin is ${formatPercent(operatingMargin)}, and ROE is ${formatPercent(returnOnEquity)}.`,
      valuation: `Trailing P/E is ${formatRatioText(trailingPE)}, forward P/E is ${formatRatioText(forwardPE)}, price-to-sales is ${formatRatioText(priceToSales)}, price-to-book is ${formatRatioText(priceToBook)}, EV/EBITDA is ${formatRatioText(enterpriseToEbitda)}, and FCF yield is ${formatPercent(freeCashFlowYield)}.`,
      peerValuation: `Sector ETF proxy: ${sectorEtf}. Peer-level medians are estimated because no paid peer dataset is connected; treat this as directional, not definitive.`,
      reasonableValuation: `A more reasonable entry would require either a lower multiple, clearer growth acceleration, or stronger free-cash-flow yield than the current ${formatPercent(freeCashFlowYield)}.`,
      growthPotential: `Growth risk is scored from revenue growth, earnings growth, margins, and business quality. Current revenue growth is ${formatPercent(revenueGrowth)}.`,
      competitivePosition: `Competitive position is inferred from sector, industry, margins, and headline context; product concentration and regulatory exposure should be checked directly in company filings.`,
      detailedRisks: newsSummary.risks.concat([
        "Valuation risk: multiple compression can hurt returns even if the company performs adequately.",
        "Macroeconomic risk: rates, demand cycles, and risk appetite can change the equity multiple.",
        "Data risk: some fields may be unavailable, delayed, or source-dependent.",
      ]),
      bullCase: `${quoteData.companyName} could work if growth stays durable, margins hold, and the market becomes more comfortable with the current valuation.`,
      bearCase: `${quoteData.companyName} could underperform if growth slows, free cash flow weakens, or the current multiple proves too demanding.`,
      catalysts: newsSummary.catalysts,
      risks: newsSummary.risks,
      latestEarningsHeadline: null,
      latestDeliveryHeadline: null,
      bottomLine,
    },
  };
};

const tableRowValue = (table, label, column = "value2", multiplier = 1) => {
  const row = table?.rows?.find((item) => String(item.value1 || "").toLowerCase() === label.toLowerCase());
  return parseLooseNumber(row?.[column], multiplier);
};

const createNasdaqFallbackPayload = async (ticker, chartPoints, sourceLabel) => {
  const [infoPayload, summaryPayload, profilePayload, quarterlyPayload, annualPayload] = await Promise.all([
    fetchNasdaqJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/info?assetclass=stocks`).catch(() => null),
    fetchNasdaqJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/summary?assetclass=stocks`).catch(() => null),
    fetchNasdaqJson(`https://api.nasdaq.com/api/company/${encodeURIComponent(ticker)}/company-profile`).catch(() => null),
    fetchNasdaqJson(`https://api.nasdaq.com/api/company/${encodeURIComponent(ticker)}/financials?frequency=2`).catch(() => null),
    fetchNasdaqJson(`https://api.nasdaq.com/api/company/${encodeURIComponent(ticker)}/financials?frequency=1`).catch(() => null),
  ]);

  const info = infoPayload?.data || {};
  const summary = summaryPayload?.data?.summaryData || {};
  const profile = profilePayload?.data || {};
  const quarterlyIncome = quarterlyPayload?.data?.incomeStatementTable || {};
  const quarterlyBalance = quarterlyPayload?.data?.balanceSheetTable || {};
  const quarterlyCash = quarterlyPayload?.data?.cashFlowTable || {};
  const quarterlyRatios = quarterlyPayload?.data?.financialRatiosTable || {};
  const annualIncome = annualPayload?.data?.incomeStatementTable || {};
  const annualBalance = annualPayload?.data?.balanceSheetTable || {};
  const annualCash = annualPayload?.data?.cashFlowTable || {};
  const annualRatios = annualPayload?.data?.financialRatiosTable || {};
  const latestPrice = parseLooseNumber(info.primaryData?.lastSalePrice) || chartPoints.at(-1)?.close || null;
  const previousClose = parseLooseNumber(summary.PreviousClose?.value);
  const marketCap = parseLooseNumber(summary.MarketCap?.value);
  const rangeText = summary.FiftTwoWeekHighLow?.value || info.keyStats?.fiftyTwoWeekHighLow?.value || "";
  const rangeParts = rangeText.split(/[/-]/).map((part) => parseLooseNumber(part));
  const fiftyTwoWeekHigh = Math.max(...rangeParts.filter(Number.isFinite));
  const fiftyTwoWeekLow = Math.min(...rangeParts.filter(Number.isFinite));
  const revenue = tableRowValue(annualIncome, "Total Revenue", "value2", 1000);
  const netIncome = tableRowValue(annualIncome, "Net Income", "value2", 1000);
  const grossMargin = tableRowValue(annualRatios, "Gross Margin");
  const operatingMargin = tableRowValue(annualRatios, "Operating Margin");
  const netMargin = tableRowValue(annualRatios, "Profit Margin");
  const returnOnEquity = tableRowValue(annualRatios, "After Tax ROE");
  const currentRatio = tableRowValue(annualRatios, "Current Ratio");
  const cash =
    (tableRowValue(annualBalance, "Cash and Cash Equivalents", "value2", 1000) || 0) +
    (tableRowValue(annualBalance, "Short-Term Investments", "value2", 1000) || 0);
  const debt =
    (tableRowValue(annualBalance, "Long-Term Debt", "value2", 1000) || 0) +
    (tableRowValue(annualBalance, "Short-Term Debt / Current Portion of Long-Term Debt", "value2", 1000) || 0);
  const operatingCashFlow = tableRowValue(annualCash, "Net Cash Flow-Operating", "value2", 1000);
  const capitalExpenditures = tableRowValue(annualCash, "Capital Expenditures", "value2", 1000);
  const freeCashflow =
    Number.isFinite(operatingCashFlow) && Number.isFinite(capitalExpenditures) ? operatingCashFlow + capitalExpenditures : null;
  const revenuePrevious = tableRowValue(annualIncome, "Total Revenue", "value3", 1000);
  const revenueGrowth = Number.isFinite(revenue) && Number.isFinite(revenuePrevious) && revenuePrevious !== 0 ? ((revenue - revenuePrevious) / revenuePrevious) * 100 : null;
  const totalEquity = tableRowValue(annualBalance, "Total Equity", "value2", 1000);
  const debtToEquity =
    tableRowValue(annualRatios, "Total Debt to Equity") ||
    (Number.isFinite(debt) && Number.isFinite(totalEquity) && totalEquity !== 0 ? debt / totalEquity : null);
  const freeCashFlowMargin = Number.isFinite(freeCashflow) && Number.isFinite(revenue) && revenue !== 0 ? (freeCashflow / revenue) * 100 : null;
  const freeCashFlowYield = Number.isFinite(freeCashflow) && Number.isFinite(marketCap) && marketCap > 0 ? (freeCashflow / marketCap) * 100 : null;
  const sector = profile.Sector?.value || summary.Sector?.value || "Sector unavailable";
  const industry = profile.Industry?.value || summary.Industry?.value || "Industry unavailable";
  const sectorEtf = pickSectorEtf(sector, industry);

  const columns = ["value2", "value3", "value4", "value5"];
  const quarterly = columns.map((column, index) => {
    const header = quarterlyIncome.headers?.[column];
    const revenueQ = tableRowValue(quarterlyIncome, "Total Revenue", column, 1000);
    const grossProfitQ = tableRowValue(quarterlyIncome, "Gross Profit", column, 1000);
    const operatingIncomeQ = tableRowValue(quarterlyIncome, "Operating Income", column, 1000);
    const netIncomeQ = tableRowValue(quarterlyIncome, "Net Income", column, 1000);
    return {
      label: formatDate(header) || `Q${index + 1}`,
      revenue: revenueQ,
      revenueGrowthYoY: index === 0 ? revenueGrowth : null,
      grossMargin: Number.isFinite(revenueQ) && Number.isFinite(grossProfitQ) && revenueQ !== 0 ? (grossProfitQ / revenueQ) * 100 : tableRowValue(quarterlyRatios, "Gross Margin", column),
      operatingMargin:
        Number.isFinite(revenueQ) && Number.isFinite(operatingIncomeQ) && revenueQ !== 0 ? (operatingIncomeQ / revenueQ) * 100 : tableRowValue(quarterlyRatios, "Operating Margin", column),
      netIncome: netIncomeQ,
      eps: tableRowValue(quarterlyIncome, "Diluted EPS", column),
      freeCashFlow:
        Number.isFinite(tableRowValue(quarterlyCash, "Net Cash Flow-Operating", column, 1000)) &&
        Number.isFinite(tableRowValue(quarterlyCash, "Capital Expenditures", column, 1000))
          ? tableRowValue(quarterlyCash, "Net Cash Flow-Operating", column, 1000) +
            tableRowValue(quarterlyCash, "Capital Expenditures", column, 1000)
          : null,
      cash:
        (tableRowValue(quarterlyBalance, "Cash and Cash Equivalents", column, 1000) || 0) +
        (tableRowValue(quarterlyBalance, "Short-Term Investments", column, 1000) || 0),
      debt:
        (tableRowValue(quarterlyBalance, "Long-Term Debt", column, 1000) || 0) +
        (tableRowValue(quarterlyBalance, "Short-Term Debt / Current Portion of Long-Term Debt", column, 1000) || 0),
    };
  });

  chartPoints.forEach((point, index) => {
    const previous = chartPoints[index - 1];
    point.deltaLabel = previous ? `${(((point.close - previous.close) / previous.close) * 100).toFixed(1)}% vs prior close` : "Starting point";
  });

  const quoteData = {
    ticker,
    companyName: profile.CompanyName?.value || info.companyName || PRESET_COMPANY_NAMES[ticker] || ticker,
    exchange: summary.Exchange?.value || info.exchange || "Nasdaq public data",
    source: `Nasdaq public quote, summary, profile, financials, and ${sourceLabel}`,
    currentPrice: latestPrice,
    previousClose,
    dailyChangePercent: Number.isFinite(latestPrice) && Number.isFinite(previousClose) && previousClose !== 0 ? ((latestPrice - previousClose) / previousClose) * 100 : parseLooseNumber(info.primaryData?.percentageChange),
    updatedAtLabel: info.primaryData?.lastTradeTimestamp || formatDateTime(Date.now()),
    marketCap,
    sectorLabel: sector,
    industry,
    currency: "USD",
    fiftyTwoWeekHigh: Number.isFinite(fiftyTwoWeekHigh) ? fiftyTwoWeekHigh : null,
    fiftyTwoWeekLow: Number.isFinite(fiftyTwoWeekLow) ? fiftyTwoWeekLow : null,
    trailingPE: null,
    forwardPE: null,
    enterpriseToEbitda: null,
    enterpriseToRevenue: null,
    priceToSales: Number.isFinite(marketCap) && Number.isFinite(revenue) && revenue > 0 ? marketCap / revenue : null,
    priceToBook: null,
    revenueGrowth,
    earningsGrowth: null,
    earningsQuarterlyGrowth: null,
    grossMargin,
    operatingMargin,
    netMargin,
    totalCash: cash,
    totalDebt: debt,
    netCashToMarketCap: Number.isFinite(cash) && Number.isFinite(debt) && Number.isFinite(marketCap) && marketCap > 0 ? (cash - debt) / marketCap : 0,
    netCashLabel:
      Number.isFinite(cash) && Number.isFinite(debt)
        ? cash >= debt
          ? `Net cash +${((cash - debt) / 1e9).toFixed(1)}B`
          : `Net debt ${((debt - cash) / 1e9).toFixed(1)}B`
        : "Capital structure unavailable",
    currentRatio: Number.isFinite(currentRatio) ? currentRatio / 100 : null,
    debtToEquity,
    freeCashFlowMargin,
    freeCashFlowYield,
    beta: null,
    returnOnEquity,
  };

  const scoring = scoreReport(quoteData);
  const chartMeta = {
    points: chartPoints,
    low: Math.min(...chartPoints.map((point) => point.close)),
    high: Math.max(...chartPoints.map((point) => point.close)),
    returnPercent: chartPoints.length > 1 ? ((chartPoints.at(-1).close - chartPoints[0].close) / chartPoints[0].close) * 100 : 0,
    drawdownFromHigh:
      ((Math.max(...chartPoints.map((point) => point.close)) - chartPoints.at(-1).close) / Math.max(...chartPoints.map((point) => point.close))) * 100,
  };
  chartMeta.events = buildChartEvents(chartPoints, {}, { latestDelivery: null }).concat([
    {
      label: "Current",
      detail: `Latest Nasdaq quote near ${latestPrice?.toFixed?.(2) || "unavailable"}.`,
      displayDate: chartPoints.at(-1)?.displayDate || "Latest",
      chartDate: chartPoints.at(-1)?.date,
      color: "#f4f7fb",
    },
  ]);
  const technical = buildTechnical(chartPoints, quoteData.currentPrice);
  const performance = {
    oneMonth: nearestReturn(chartPoints, 30),
    sixMonth: nearestReturn(chartPoints, 182),
    oneYear: chartMeta.returnPercent,
    fiveYear: null,
    sp500OneYear: null,
    sectorEtfOneYear: null,
    sectorEtf,
  };
  const missingCount = [quoteData.trailingPE, quoteData.forwardPE, quoteData.enterpriseToEbitda, quoteData.priceToBook].filter((value) => !Number.isFinite(value)).length;
  const rating = buildRating(scoring, quoteData, Math.min(3, missingCount / 2));
  const newsSummary = {
    catalysts: [
      revenueGrowth > 0 ? "Recent annual revenue growth is positive in Nasdaq financials." : "Revenue reacceleration would improve the setup.",
      freeCashFlowYield > 2 ? "Free cash flow yield provides some valuation support." : "Higher free cash flow yield would strengthen the bull case.",
      summary.OneYrTarget?.value ? `Nasdaq summary lists a one-year target of ${summary.OneYrTarget.value}.` : "Upcoming earnings and guidance are key catalysts.",
    ],
    risks: [
      "Valuation multiples such as P/E and EV/EBITDA were unavailable from the Nasdaq fallback, reducing confidence.",
      debt > cash ? "Debt exceeds cash in fallback financials." : "Margin or cash-flow deterioration would reduce balance-sheet comfort.",
      "Headline, regulatory, and macro risks require direct monitoring because Yahoo headline feed was unavailable.",
    ],
    latestEarnings: null,
    latestDelivery: null,
  };
  const cards = buildCards(quoteData, scoring, newsSummary, chartMeta);

  return {
    quote: quoteData,
    scoring,
    rating,
    chart: chartMeta,
    technical,
    performance,
    quarterly,
    cards,
    sources: buildSources(ticker, sectorEtf, quoteData.source).concat([
      { label: "Nasdaq public quote summary", url: `https://www.nasdaq.com/market-activity/stocks/${encodeURIComponent(ticker.toLowerCase())}` },
    ]),
    narrative: {
      latestSummary: `Nasdaq fallback financials show latest available quarterly revenue of ${Number.isFinite(quarterly[0]?.revenue) ? "$" + (quarterly[0].revenue / 1e9).toFixed(1) + "B" : "unavailable"} and net income of ${Number.isFinite(quarterly[0]?.netIncome) ? "$" + (quarterly[0].netIncome / 1e9).toFixed(1) + "B" : "unavailable"}.`,
      latestMeta: quarterly[0]?.label || "Latest Nasdaq financial snapshot",
      deliverySummary: /TSLA/i.test(ticker)
        ? "Delivery-specific data was not returned by the Nasdaq fallback; check the company's next production and delivery release directly."
        : "No delivery-specific update is relevant for this ticker.",
      deliveryMeta: "Nasdaq fallback context",
      importantDates: info.notifications?.[0]?.eventTypes?.[0]?.message || "Upcoming dates unavailable from fallback source.",
      companyOverview: profile.CompanyDescription?.value || `${quoteData.companyName} operates in ${industry} within ${sector}.`,
      competitorSummary: `Main competitors should be selected from the ${industry} peer group; ${sectorEtf} is used as a sector proxy for broad comparison.`,
      newsContext: "Yahoo public headline feed was unavailable, so this fallback relies on Nasdaq quote, profile, and financial endpoints.",
      financialHealth: `Revenue growth is ${formatPercent(revenueGrowth)}, free cash flow margin is ${formatPercent(freeCashFlowMargin)}, and net margin is ${formatPercent(netMargin)}.`,
      balanceSheet: `Cash is ${Number.isFinite(cash) ? "$" + (cash / 1e9).toFixed(1) + "B" : "unavailable"} versus debt of ${Number.isFinite(debt) ? "$" + (debt / 1e9).toFixed(1) + "B" : "unavailable"}.`,
      marginSummary: `Gross margin is ${formatPercent(grossMargin)}, operating margin is ${formatPercent(operatingMargin)}, and ROE is ${formatPercent(returnOnEquity)}.`,
      valuation: `P/E, forward P/E, price-to-book, and EV/EBITDA were unavailable in the Nasdaq fallback. Price-to-sales is ${formatRatioText(quoteData.priceToSales)} and FCF yield is ${formatPercent(freeCashFlowYield)}.`,
      peerValuation: `Sector ETF proxy: ${sectorEtf}. Sector-average and peer valuation are directional because a licensed peer database is not connected.`,
      reasonableValuation: `A more reasonable setup would need clearer valuation data, a stronger FCF yield than ${formatPercent(freeCashFlowYield)}, or a lower price-to-sales ratio.`,
      growthPotential: `Growth potential is judged from revenue growth (${formatPercent(revenueGrowth)}), margins, market opportunity, and company profile context.`,
      competitivePosition: `Competitive advantages are inferred from scale, margins, sector position, and the company profile; verify product concentration and customer concentration in filings.`,
      detailedRisks: newsSummary.risks.concat([
        "Business risk: demand shifts, execution misses, and margin pressure can lower estimates.",
        "Valuation risk: missing multiple data lowers confidence and may hide overvaluation.",
        "Regulatory risk: company and sector-specific rules can affect growth or margins.",
        "Macroeconomic risk: rates, currency, and demand cycles can move valuation multiples.",
      ]),
      catalysts: newsSummary.catalysts,
      risks: newsSummary.risks,
      bullCase: `${quoteData.companyName} could move higher if revenue growth, margins, and free cash flow remain durable while valuation data becomes more supportive.`,
      bearCase: `${quoteData.companyName} could fall if growth slows, margins compress, or missing valuation fields mask a stretched setup.`,
      bottomLine: buildBottomLine(quoteData, scoring, chartMeta, newsSummary),
    },
  };
};

const createFallbackReportPayload = async (ticker) => {
  const pageUrls = [
    `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`,
    `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/key-statistics?p=${encodeURIComponent(ticker)}`,
    `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/financials?p=${encodeURIComponent(ticker)}`,
    `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/balance-sheet?p=${encodeURIComponent(ticker)}`,
    `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/cash-flow?p=${encodeURIComponent(ticker)}`,
  ];

  const pages = await Promise.all(pageUrls.map((url) => fetchPublicText(url).catch(() => "")));
  const stores = pages.reduce((accumulator, html) => {
    const parsed = html ? extractRootAppData(html) : null;
    const nextStores = parsed?.context?.dispatcher?.stores?.QuoteSummaryStore;
    return nextStores ? deepMerge(accumulator, nextStores) : accumulator;
  }, emptySummaryStore());

  let alternativeChart;
  try {
    alternativeChart = await fetchAlternativeChartPoints(ticker);
  } catch {
    const fallbackPrice = metric(stores.price?.regularMarketPrice) || metric(stores.summaryDetail?.previousClose);
    if (!Number.isFinite(fallbackPrice)) {
      throw new Error(`Alternative price history was unavailable for ${ticker}.`);
    }

    const today = new Date();
    alternativeChart = {
      points: [
        {
          date: today.toISOString().slice(0, 10),
          displayDate: formatDate(today),
          label: new Intl.DateTimeFormat("en-US", { month: "short" }).format(today),
          close: fallbackPrice,
          deltaLabel: "History unavailable. Displaying latest known price snapshot.",
        },
      ],
      sourceLabel: "Latest price snapshot only",
    };
  }

  if (!Object.keys(stores.price || {}).length) {
    return createNasdaqFallbackPayload(ticker, alternativeChart.points, alternativeChart.sourceLabel);
  }

  return buildPayloadFromStores(
    ticker,
    stores,
    alternativeChart.points,
    Object.keys(stores.price || {}).length
      ? `Yahoo Finance page data + ${alternativeChart.sourceLabel}`
      : `${alternativeChart.sourceLabel} with limited fundamentals`,
  );
};

const createReportPayload = async (ticker) => {
  let yahooSession = null;
  try {
    yahooSession = await getYahooSession(ticker);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/crumb request failed \(429\)|valid Yahoo Finance crumb|session cookie/i.test(message)) {
      throw error;
    }
  }

  if (!yahooSession) {
    return createFallbackReportPayload(ticker);
  }

  const quoteUrl = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
  quoteUrl.searchParams.set("symbols", ticker);
  quoteUrl.searchParams.set("lang", "en-US");
  quoteUrl.searchParams.set("region", "US");

  const summaryUrl = new URL(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}`);
  summaryUrl.searchParams.set(
    "modules",
    [
      "price",
      "summaryProfile",
      "defaultKeyStatistics",
      "summaryDetail",
      "financialData",
      "calendarEvents",
      "earnings",
      "assetProfile",
      "incomeStatementHistoryQuarterly",
      "balanceSheetHistoryQuarterly",
      "cashflowStatementHistoryQuarterly",
    ].join(","),
  );
  summaryUrl.searchParams.set("lang", "en-US");
  summaryUrl.searchParams.set("region", "US");

  const chartUrl = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  chartUrl.searchParams.set("range", "1y");
  chartUrl.searchParams.set("interval", "1d");
  chartUrl.searchParams.set("includePrePost", "false");
  chartUrl.searchParams.set("events", "div,splits");
  chartUrl.searchParams.set("lang", "en-US");
  chartUrl.searchParams.set("region", "US");

  const rssUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;

  let quotePayload;
  let summaryPayload;
  let chartPayload;
  let rssText;

  try {
    [quotePayload, summaryPayload, chartPayload, rssText] = await Promise.all([
      fetchJson(quoteUrl.toString(), yahooSession),
      fetchJson(summaryUrl.toString(), yahooSession),
      fetchJson(chartUrl.toString(), yahooSession),
      fetchText(rssUrl, yahooSession).catch(() => ""),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/401|429|Invalid Cookie|Invalid Crumb|Upstream request failed/i.test(message)) {
      return createFallbackReportPayload(ticker);
    }
    throw error;
  }

  const quote = quotePayload.quoteResponse?.result?.[0];
  const summary = summaryPayload.quoteSummary?.result?.[0];
  const chartResult = chartPayload.chart?.result?.[0];
  if (!quote || !summary || !chartResult) {
    throw new Error(`No usable live data found for ${ticker}.`);
  }

  const chartPoints = buildChartPointsFromYahooChart(chartPayload);

  if (!chartPoints.length) {
    throw new Error(`Price history is unavailable for ${ticker}.`);
  }

  chartPoints.forEach((point, index) => {
    const previous = chartPoints[index - 1];
    point.deltaLabel = previous
      ? `${((point.close - previous.close) / previous.close * 100).toFixed(1)}% vs prior close`
      : "Starting point";
  });

  const rssItems = rssText ? parseRssItems(rssText) : [];
  const newsSummary = rssClassify(rssItems);

  const quarterly = buildQuarterlySeries(summary);

  const currentPrice = metric(summary.price?.regularMarketPrice) || metric(quote.regularMarketPrice);
  const currentClose = chartPoints[chartPoints.length - 1].close;
  const previousClose = metric(summary.summaryDetail?.previousClose) || metric(quote.regularMarketPreviousClose);
  const dailyChangePercent = Number.isFinite(currentPrice) && Number.isFinite(previousClose) && previousClose !== 0 ? ((currentPrice - previousClose) / previousClose) * 100 : 0;
  const marketCap = metric(summary.price?.marketCap) || metric(quote.marketCap);
  const totalCash = metric(summary.financialData?.totalCash);
  const totalDebt = metric(summary.financialData?.totalDebt);
  const currentRatio = metric(summary.financialData?.currentRatio);
  const debtToEquity = metric(summary.financialData?.debtToEquity);
  const freeCashflow = metric(summary.financialData?.freeCashflow);
  const revenue = metric(summary.financialData?.totalRevenue);
  const grossMargin = metric(summary.financialData?.grossMargins) != null ? metric(summary.financialData?.grossMargins) * 100 : null;
  const operatingMargin = metric(summary.financialData?.operatingMargins) != null ? metric(summary.financialData?.operatingMargins) * 100 : null;
  const revenueGrowth = metric(summary.financialData?.revenueGrowth) != null ? metric(summary.financialData?.revenueGrowth) * 100 : null;
  const earningsGrowth = metric(summary.financialData?.earningsGrowth) != null ? metric(summary.financialData?.earningsGrowth) * 100 : null;
  const earningsQuarterlyGrowth =
    metric(summary.defaultKeyStatistics?.earningsQuarterlyGrowth) != null
      ? metric(summary.defaultKeyStatistics?.earningsQuarterlyGrowth) * 100
      : null;
  const trailingPE = metric(summary.summaryDetail?.trailingPE) || metric(quote.trailingPE);
  const forwardPE = metric(summary.summaryDetail?.forwardPE) || metric(quote.forwardPE);
  const enterpriseToEbitda = metric(summary.defaultKeyStatistics?.enterpriseToEbitda);
  const enterpriseToRevenue = metric(summary.defaultKeyStatistics?.enterpriseToRevenue);
  const priceToSales = metric(summary.summaryDetail?.priceToSalesTrailing12Months) || metric(quote.priceToSalesTrailing12Months);
  const priceToBook = metric(summary.defaultKeyStatistics?.priceToBook) || metric(quote.priceToBook);
  const beta = metric(summary.summaryDetail?.beta);
  const returnOnEquity = metric(summary.financialData?.returnOnEquity) != null ? metric(summary.financialData?.returnOnEquity) * 100 : null;
  const profitMargins = metric(summary.financialData?.profitMargins) != null ? metric(summary.financialData?.profitMargins) * 100 : null;
  const netCashToMarketCap =
    Number.isFinite(totalCash) && Number.isFinite(totalDebt) && Number.isFinite(marketCap) && marketCap > 0 ? (totalCash - totalDebt) / marketCap : 0;
  const freeCashFlowMargin =
    Number.isFinite(freeCashflow) && Number.isFinite(revenue) && revenue !== 0 ? (freeCashflow / revenue) * 100 : null;
  const freeCashFlowYield = Number.isFinite(freeCashflow) && Number.isFinite(marketCap) && marketCap > 0 ? (freeCashflow / marketCap) * 100 : null;
  const sectorEtf = pickSectorEtf(summary.summaryProfile?.sector, summary.summaryProfile?.industry);

  const [fiveYearPoints, spyPoints, sectorPoints] = await Promise.all([
    fetchYahooChartPoints(ticker, "5y", yahooSession).catch(() => []),
    fetchYahooChartPoints("SPY", "1y", yahooSession).catch(() => []),
    fetchYahooChartPoints(sectorEtf, "1y", yahooSession).catch(() => []),
  ]);

  const quoteData = {
    ticker,
    companyName: quote.longName || quote.shortName || PRESET_COMPANY_NAMES[ticker] || ticker,
    exchange: quote.fullExchangeName || quote.exchange || null,
    source: "Yahoo Finance quote, quoteSummary, chart, and public RSS headlines",
    currentPrice: currentPrice || currentClose,
    previousClose,
    dailyChangePercent,
    updatedAtLabel: formatDateTime(quote.regularMarketTime ? quote.regularMarketTime * 1000 : Date.now()),
    marketCap,
    sectorLabel: fallbackText(summary.summaryProfile?.sector, "Sector unavailable"),
    industry: fallbackText(summary.summaryProfile?.industry, "Industry unavailable"),
    currency: quote.currency || summary.price?.currency || "USD",
    fiftyTwoWeekHigh: metric(summary.summaryDetail?.fiftyTwoWeekHigh) || metric(quote.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: metric(summary.summaryDetail?.fiftyTwoWeekLow) || metric(quote.fiftyTwoWeekLow),
    trailingPE,
    forwardPE,
    enterpriseToEbitda,
    enterpriseToRevenue,
    priceToSales,
    priceToBook,
    revenueGrowth,
    earningsGrowth,
    earningsQuarterlyGrowth,
    grossMargin,
    operatingMargin,
    netMargin: profitMargins,
    totalCash,
    totalDebt,
    netCashToMarketCap,
    netCashLabel:
      Number.isFinite(totalCash) && Number.isFinite(totalDebt)
        ? totalCash >= totalDebt
          ? `Net cash ${(totalCash - totalDebt) / 1e9 >= 0 ? "+" : ""}${((totalCash - totalDebt) / 1e9).toFixed(1)}B`
          : `Net debt ${((totalDebt - totalCash) / 1e9).toFixed(1)}B`
        : "Capital structure unavailable",
    currentRatio,
    debtToEquity,
    freeCashFlowMargin,
    freeCashFlowYield,
    beta,
    returnOnEquity,
  };

  const scoring = scoreReport(quoteData);
  const chartMeta = {
    points: chartPoints,
    low: Math.min(...chartPoints.map((point) => point.close)),
    high: Math.max(...chartPoints.map((point) => point.close)),
    returnPercent: ((chartPoints[chartPoints.length - 1].close - chartPoints[0].close) / chartPoints[0].close) * 100,
    drawdownFromHigh:
      ((Math.max(...chartPoints.map((point) => point.close)) - chartPoints[chartPoints.length - 1].close) /
        Math.max(...chartPoints.map((point) => point.close))) *
      100,
  };
  chartMeta.events = buildChartEvents(chartPoints, summary, newsSummary);
  chartMeta.events.unshift({
    label: "Current",
    detail: `Latest available close near ${chartPoints.at(-1).close.toFixed(2)}.`,
    displayDate: chartPoints.at(-1).displayDate,
    chartDate: chartPoints.at(-1).date,
    color: "#f4f7fb",
  });
  chartMeta.events = chartMeta.events.slice(0, 5);

  const latestEarnings = newsSummary.latestEarnings;
  const latestDelivery = newsSummary.latestDelivery;
  const cards = buildCards(quoteData, scoring, newsSummary, chartMeta);
  const bottomLine = buildBottomLine(quoteData, scoring, chartMeta, newsSummary);
  const technical = buildTechnical(chartPoints, quoteData.currentPrice);
  const performance = {
    oneMonth: nearestReturn(chartPoints, 30),
    sixMonth: nearestReturn(chartPoints, 182),
    oneYear: chartMeta.returnPercent,
    fiveYear: nearestReturn(fiveYearPoints, 365 * 5),
    sp500OneYear: nearestReturn(spyPoints, 365),
    sectorEtfOneYear: nearestReturn(sectorPoints, 365),
    sectorEtf,
  };
  const missingCount = [
    quoteData.trailingPE,
    quoteData.forwardPE,
    quoteData.enterpriseToEbitda,
    quoteData.priceToSales,
    quoteData.priceToBook,
    quoteData.freeCashFlowYield,
    quoteData.debtToEquity,
    quoteData.netMargin,
    quoteData.revenueGrowth,
  ].filter((value) => !Number.isFinite(value)).length;
  const rating = buildRating(scoring, quoteData, Math.min(3, missingCount / 3));

  return {
    quote: quoteData,
    scoring,
    rating,
    chart: chartMeta,
    technical,
    performance,
    quarterly,
    cards,
    sources: buildSources(ticker, sectorEtf, quoteData.source),
    narrative: {
      latestSummary: latestEarnings
        ? `${latestEarnings.title}. ${latestEarnings.description || "Recent earnings headline detected in the public feed."}`
        : `Latest reported quarter points to revenue ${quarterly[0]?.revenue != null ? "around " + Math.round(quarterly[0].revenue / 1e9 * 10) / 10 + "B" : "data unavailable"}, operating margin ${quarterly[0]?.operatingMargin != null ? quarterly[0].operatingMargin.toFixed(1) + "%" : "unavailable"}, and free cash flow ${quarterly[0]?.freeCashFlow != null ? "$" + (quarterly[0].freeCashFlow / 1e9).toFixed(1) + "B" : "unavailable"}.`,
      latestMeta: latestEarnings ? latestEarnings.displayDate : quarterly[0]?.label || "Most recent quarter",
      deliverySummary: latestDelivery
        ? `${latestDelivery.title}. ${latestDelivery.description || "Latest operational headline found in the public feed."}`
        : /TSLA/i.test(ticker)
          ? "No fresh delivery headline was detected in the fetched feed, so monitor Tesla's next production and delivery release directly."
          : "No delivery-specific update is relevant for this ticker, so the report emphasizes earnings and balance-sheet trends.",
      deliveryMeta: latestDelivery ? latestDelivery.displayDate : "Recent operating context",
      importantDates:
        earningsDateRaw || summary.calendarEvents?.earnings?.earningsDate?.[0]?.fmt
          ? `Earnings marker: ${formatDate(earningsDateRaw || summary.calendarEvents?.earnings?.earningsDate?.[0]?.fmt)}. Monitor company investor relations for confirmed dates.`
          : "Upcoming company-specific dates were unavailable in the fetched data.",
      companyOverview: `${quoteData.companyName} operates in ${quoteData.industry || "an unavailable industry"} within ${quoteData.sectorLabel}. Main revenue sources and products should be verified in the latest 10-K/10-Q; this dashboard emphasizes market, valuation, and financial data returned by public feeds.`,
      competitorSummary: `Relevant competitors are generally drawn from the ${quoteData.industry || quoteData.sectorLabel} peer set. The report uses ${sectorEtf} as a sector proxy because no paid peer-comparison dataset is connected.`,
      newsContext:
        latestEarnings || latestDelivery
          ? [latestEarnings?.title, latestDelivery?.title].filter(Boolean).join(" ")
          : "No dominant recent earnings, delivery, or operating headline was detected in the fetched public feed.",
      financialHealth: `Revenue growth is ${formatPercent(revenueGrowth)}, net income trend is shown in the quarterly table, and free cash flow margin is ${formatPercent(freeCashFlowMargin)}.`,
      balanceSheet: `Cash is ${Number.isFinite(totalCash) ? "$" + (totalCash / 1e9).toFixed(1) + "B" : "unavailable"} versus debt of ${Number.isFinite(totalDebt) ? "$" + (totalDebt / 1e9).toFixed(1) + "B" : "unavailable"}. Current ratio is ${formatRatioText(currentRatio)} and debt-to-equity is ${formatRatioText(debtToEquity)}.`,
      marginSummary: `Gross margin is ${formatPercent(grossMargin)}, operating margin is ${formatPercent(operatingMargin)}, net margin is ${formatPercent(profitMargins)}, and ROE is ${formatPercent(returnOnEquity)}.`,
      valuation: `P/E ${formatRatioText(trailingPE)}, forward P/E ${formatRatioText(forwardPE)}, price-to-sales ${formatRatioText(priceToSales)}, price-to-book ${formatRatioText(priceToBook)}, EV/EBITDA ${formatRatioText(enterpriseToEbitda)}, and FCF yield ${formatPercent(freeCashFlowYield)}.`,
      peerValuation: `Sector ETF proxy: ${sectorEtf}. Peer and sector-average comparisons are directional because this self-contained tool does not use a licensed peer-multiple database.`,
      reasonableValuation: `A better buy setup would usually need a lower P/E or EV/EBITDA, stronger FCF yield than ${formatPercent(freeCashFlowYield)}, or evidence that growth is accelerating enough to justify the multiple.`,
      growthPotential: `Growth potential depends on revenue growth (${formatPercent(revenueGrowth)}), earnings growth (${formatPercent(earningsGrowth)}), market expansion, and execution against recent company updates.`,
      competitivePosition: `Competitive position is inferred from industry, margins, scale, and headline context. Durable margins, high ROE, and recurring demand lower business risk; product concentration, regulation, or customer concentration raise it.`,
      detailedRisks: (newsSummary.risks.length ? newsSummary.risks : []).concat([
        scoring.breakdown[0].rawScore > 60
          ? "Valuation risk: the current multiple leaves limited room for disappointment."
          : "Valuation risk: multiple expansion may be limited without stronger growth.",
        totalDebt > totalCash
          ? "Balance-sheet risk: debt exceeds cash, which can reduce flexibility if cash flow weakens."
          : "Balance-sheet risk: cash is supportive, but liquidity can change quickly after acquisitions, buybacks, or downturns.",
        "Competition risk: peers can pressure pricing, margins, and market share.",
        "Regulatory and legal risk: company-specific investigations, antitrust, product rules, or export controls can affect estimates.",
        "Macroeconomic risk: rates, consumer demand, enterprise budgets, currency, and risk appetite can move the stock.",
        "Stock-specific risk: high beta, crowded positioning, or headline sensitivity can amplify drawdowns.",
      ]),
      bullCase: `${quoteData.companyName} could move higher if revenue and earnings growth beat expectations, margins stay resilient, and investors accept the current valuation as justified by durable competitive advantages.`,
      bearCase: `${quoteData.companyName} could fall if growth decelerates, margins compress, free cash flow weakens, or the market resets the multiple closer to lower-growth peers.`,
      catalysts:
        newsSummary.catalysts.length > 0
          ? newsSummary.catalysts
          : [
              quoteData.revenueGrowth > 10 ? "Revenue growth remains supportive of the current narrative." : "Any reacceleration in revenue could improve the setup.",
              quoteData.totalCash > quoteData.totalDebt ? "Net cash flexibility supports buybacks, capex, or downside protection." : "Balance-sheet repair would improve optionality.",
              chartMeta.drawdownFromHigh > 15 ? "A stabilization rebound from current levels could reset sentiment." : "Momentum staying intact would keep bulls engaged.",
            ],
      risks:
        newsSummary.risks.length > 0
          ? newsSummary.risks
          : [
              scoring.breakdown[0].rawScore > 65 ? "Valuation remains demanding relative to current growth." : "Multiple expansion may be limited without cleaner execution.",
              quoteData.freeCashFlowMargin < 0 ? "Negative free cash flow raises execution sensitivity." : "Margin compression would quickly change the risk profile.",
              quoteData.beta > 1.6 ? "High beta means headline-driven volatility can stay elevated." : "Macro sensitivity still matters even with moderate beta.",
            ],
      latestEarningsHeadline: latestEarnings?.title || null,
      latestDeliveryHeadline: latestDelivery?.title || null,
      bottomLine,
    },
  };
};

app.use(express.static(__dirname));

app.get("/api/report", async (request, response) => {
  const ticker = String(request.query.ticker || "TSLA")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z.\-]/g, "")
    .slice(0, 12);

  if (!ticker) {
    response.status(400).json({ error: "Ticker is required." });
    return;
  }

  try {
    const report = await createReportPayload(ticker);
    response.json(report);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : `Unable to build report for ${ticker}.`,
    });
  }
});

app.get("*", (_request, response) => {
  response.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`Risk Score Report running at http://localhost:${port}`);
});
