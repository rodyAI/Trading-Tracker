import type { RawStockRecord } from "../../../shared/src/types.js";
import { config } from "../config.js";
import type { ScreenerDataProvider } from "./screenerDataProvider.js";

interface AlphaVantageOverviewResponse {
  Symbol?: string;
  Name?: string;
  Country?: string;
  Industry?: string;
  MarketCapitalization?: string;
  SharesOutstanding?: string;
  Currency?: string;
}

interface AlphaVantageIncomeStatementResponse {
  quarterlyReports?: Array<{
    operatingIncome?: string;
  }>;
}

interface AlphaVantageBalanceSheetResponse {
  quarterlyReports?: Array<{
    cashAndCashEquivalentsAtCarryingValue?: string;
    shortTermInvestments?: string;
    currentDebt?: string;
    currentLongTermDebt?: string;
    longTermDebt?: string;
    longTermDebtNoncurrent?: string;
  }>;
}

interface AlphaVantageDailyResponse {
  ["Time Series (Daily)"]?: Record<
    string,
    {
      ["4. close"]?: string;
      ["5. volume"]?: string;
    }
  >;
}

interface AlphaVantageErrorResponse {
  Note?: string;
  Information?: string;
  ErrorMessage?: string;
}

let lastAlphaVantageRequestAt = 0;

const parseNumber = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const average = (values: number[]) => {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const alphaVantageMaxSymbolsPerRun = () => {
  const requestCostPerSymbol = 4;
  return Math.max(1, Math.floor(config.alphaVantageSoftDailyLimit / requestCostPerSymbol));
};

const buildUrl = (params: Record<string, string>) => {
  const url = new URL(config.alphaVantageBaseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("apikey", config.alphaVantageApiKey);
  return url.toString();
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJson = async <T>(params: Record<string, string>): Promise<T> => {
  const minIntervalMs = 1_100;
  const now = Date.now();
  const waitMs = Math.max(0, minIntervalMs - (now - lastAlphaVantageRequestAt));
  if (waitMs > 0) {
    await wait(waitMs);
  }

  const response = await fetch(buildUrl(params), {
    headers: {
      Accept: "application/json",
      "User-Agent": "local-stock-screener/1.0",
    },
  });
  lastAlphaVantageRequestAt = Date.now();

  if (!response.ok) {
    throw new Error(`Alpha Vantage request failed with ${response.status}`);
  }

  const payload = (await response.json()) as T & AlphaVantageErrorResponse;
  if (payload.Note || payload.Information || payload.ErrorMessage) {
    throw new Error(payload.Note ?? payload.Information ?? payload.ErrorMessage ?? "Alpha Vantage request failed");
  }

  return payload;
};

const fetchOverview = (symbol: string) =>
  fetchJson<AlphaVantageOverviewResponse>({ function: "OVERVIEW", symbol });

const fetchIncomeStatement = (symbol: string) =>
  fetchJson<AlphaVantageIncomeStatementResponse>({ function: "INCOME_STATEMENT", symbol });

const fetchBalanceSheet = (symbol: string) =>
  fetchJson<AlphaVantageBalanceSheetResponse>({ function: "BALANCE_SHEET", symbol });

const fetchDaily = (symbol: string) =>
  fetchJson<AlphaVantageDailyResponse>({ function: "TIME_SERIES_DAILY", symbol, outputsize: "compact" });

const toRawRecord = async (symbol: string): Promise<RawStockRecord | null> => {
  const overview = await fetchOverview(symbol);
  const incomeStatement = await fetchIncomeStatement(symbol);
  const balanceSheet = await fetchBalanceSheet(symbol);
  const daily = await fetchDaily(symbol);

  const quarterlyOperatingIncome = (incomeStatement.quarterlyReports ?? [])
    .map((report) => parseNumber(report.operatingIncome))
    .filter((value): value is number => value != null)
    .slice(0, 4);

  const latestBalanceSheet = balanceSheet.quarterlyReports?.[0];
  const dailySeries = Object.entries(daily["Time Series (Daily)"] ?? {})
    .sort(([leftDate], [rightDate]) => rightDate.localeCompare(leftDate))
    .map(([, bar]) => ({
      close: parseNumber(bar["4. close"]),
      volume: parseNumber(bar["5. volume"]),
    }))
    .filter((bar): bar is { close: number; volume: number } => bar.close != null && bar.volume != null);

  const latestBar = dailySeries[0];
  const averageDailyVolume = average(dailySeries.slice(0, 30).map((bar) => bar.volume));
  const currentPrice = latestBar?.close ?? null;
  const sharesOutstanding =
    parseNumber(overview.SharesOutstanding) ??
    (() => {
      const marketCap = parseNumber(overview.MarketCapitalization);
      return marketCap != null && currentPrice != null && currentPrice > 0 ? marketCap / currentPrice : null;
    })();

  if (!latestBar || averageDailyVolume == null) {
    return null;
  }

  return {
    ticker: overview.Symbol?.trim().toUpperCase() ?? symbol,
    companyName: overview.Name?.trim() ?? symbol,
    country: overview.Country ?? null,
    industry: overview.Industry ?? null,
    currentPrice,
    sharesOutstanding,
    operatingIncomeLtm:
      quarterlyOperatingIncome.length === 4 ? quarterlyOperatingIncome.reduce((sum, value) => sum + value, 0) : null,
    cashAndEquivalents: parseNumber(latestBalanceSheet?.cashAndCashEquivalentsAtCarryingValue),
    shortTermInvestments: parseNumber(latestBalanceSheet?.shortTermInvestments) ?? 0,
    shortTermBorrowings: parseNumber(latestBalanceSheet?.currentDebt) ?? 0,
    currentPortionLongTermDebt: parseNumber(latestBalanceSheet?.currentLongTermDebt) ?? 0,
    longTermDebt:
      parseNumber(latestBalanceSheet?.longTermDebt) ?? parseNumber(latestBalanceSheet?.longTermDebtNoncurrent) ?? 0,
    averageDailyVolume,
    isChinese: overview.Country?.toLowerCase().includes("china") ?? false,
    currency: overview.Currency ?? "USD",
    source: "Alpha Vantage",
  };
};

export class AlphaVantageScreenerProvider implements ScreenerDataProvider {
  id = "alphavantage" as const;

  async getStocks() {
    if (!config.alphaVantageApiKey) {
      throw new Error("ALPHA_VANTAGE_API_KEY is required when SCREENER_PROVIDER=alphavantage.");
    }

    const maxSymbolsFromSoftLimit = alphaVantageMaxSymbolsPerRun();
    const symbols = config.alphaVantageSymbols.slice(0, maxSymbolsFromSoftLimit);
    const records: RawStockRecord[] = [];
    const failures: string[] = [];

    for (const symbol of symbols) {
      try {
        const record = await toRawRecord(symbol);
        if (record) records.push(record);
      } catch (error) {
        failures.push(`${symbol}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    if (records.length === 0 && failures.length > 0) {
      throw new Error(`Alpha Vantage returned no usable records. First failure: ${failures[0]}`);
    }

    return records;
  }

  getAssumptions() {
    const maxSymbolsFromSoftLimit = alphaVantageMaxSymbolsPerRun();

    return [
      "Alpha Vantage mode uses the free-plan friendly endpoints OVERVIEW, INCOME_STATEMENT, BALANCE_SHEET, and TIME_SERIES_DAILY.",
      `Because the free Alpha Vantage limit is ${config.alphaVantageSoftDailyLimit} requests per day, this provider only evaluates up to ${maxSymbolsFromSoftLimit} configured symbols per run.`,
      "Requests are intentionally serialized with a small delay to avoid Alpha Vantage free-plan burst throttling.",
      "Average daily volume is computed from the most recent 30 trading days in the compact daily time series, so a full year of history is not required for this screener.",
      "Workbook-style formulas are still applied locally: market cap = price × shares outstanding, EV = market cap + short-term debt + current portion of long-term debt + long-term debt - cash - short-term investments.",
    ];
  }
}
