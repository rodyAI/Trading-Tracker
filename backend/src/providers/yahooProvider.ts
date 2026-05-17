import type { RawStockRecord } from "../../../shared/src/types.js";
import { config } from "../config.js";
import type { ScreenerDataProvider } from "./screenerDataProvider.js";

interface YahooQuoteSummaryResponse {
  quoteSummary: {
    result?: Array<{
      price?: {
        shortName?: string;
        longName?: string;
        regularMarketPrice?: { raw?: number };
        sharesOutstanding?: { raw?: number };
        currency?: string;
      };
      summaryProfile?: {
        country?: string;
        industry?: string;
      };
      summaryDetail?: {
        averageVolume?: { raw?: number };
        averageVolume10days?: { raw?: number };
      };
      defaultKeyStatistics?: {};
      financialData?: {
        totalCash?: { raw?: number };
      };
      balanceSheetHistoryQuarterly?: {
        balanceSheetStatements?: Array<{
          cash?: { raw?: number };
          cashAndCashEquivalents?: { raw?: number };
          shortTermInvestments?: { raw?: number };
          shortLongTermDebt?: { raw?: number };
          shortTermDebt?: { raw?: number };
          currentLongTermDebt?: { raw?: number };
          longTermDebt?: { raw?: number };
        }>;
      };
      incomeStatementHistoryQuarterly?: {
        incomeStatementHistory?: Array<{
          operatingIncome?: { raw?: number };
        }>;
      };
    }>;
    error?: {
      description?: string;
    };
  };
}

interface YahooQuoteResponse {
  quoteResponse: {
    result?: Array<{
      symbol?: string;
      shortName?: string;
      longName?: string;
      regularMarketPrice?: number;
      marketCap?: number;
      sharesOutstanding?: number;
      averageDailyVolume3Month?: number;
      averageDailyVolume10Day?: number;
      financialCurrency?: string;
    }>;
  };
}

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": config.yahooLang,
      "User-Agent": "local-stock-screener/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Yahoo request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
};

const fetchYahooSummary = async (symbol: string): Promise<RawStockRecord | null> => {
  const summaryUrl = new URL(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`);
  summaryUrl.searchParams.set(
    "modules",
    "price,summaryProfile,summaryDetail,financialData,balanceSheetHistoryQuarterly,incomeStatementHistoryQuarterly",
  );
  summaryUrl.searchParams.set("lang", config.yahooLang);
  summaryUrl.searchParams.set("region", config.yahooRegion);

  const quoteUrl = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
  quoteUrl.searchParams.set("symbols", symbol);
  quoteUrl.searchParams.set("lang", config.yahooLang);
  quoteUrl.searchParams.set("region", config.yahooRegion);

  const [payload, quotePayload] = await Promise.all([
    fetchJson<YahooQuoteSummaryResponse>(summaryUrl.toString()),
    fetchJson<YahooQuoteResponse>(quoteUrl.toString()),
  ]);

  const result = payload.quoteSummary.result?.[0];
  const quote = quotePayload.quoteResponse.result?.[0];
  if (!result) {
    return null;
  }

  const operatingIncomeSeries =
    result.incomeStatementHistoryQuarterly?.incomeStatementHistory
      ?.map((statement) => statement.operatingIncome?.raw)
      .filter((value): value is number => Number.isFinite(value))
      .slice(0, 4) ?? [];

  const country = result.summaryProfile?.country ?? null;
  const balanceSheet = result.balanceSheetHistoryQuarterly?.balanceSheetStatements?.[0];
  const currentPrice = result.price?.regularMarketPrice?.raw ?? quote?.regularMarketPrice ?? null;
  const marketCap = quote?.marketCap ?? null;
  const sharesOutstanding =
    result.price?.sharesOutstanding?.raw ??
    quote?.sharesOutstanding ??
    (marketCap != null && currentPrice != null && currentPrice > 0 ? marketCap / currentPrice : null);
  const averageDailyVolume =
    result.summaryDetail?.averageVolume?.raw ??
    result.summaryDetail?.averageVolume10days?.raw ??
    quote?.averageDailyVolume3Month ??
    quote?.averageDailyVolume10Day ??
    null;

  return {
    ticker: symbol,
    companyName: result.price?.longName ?? result.price?.shortName ?? quote?.longName ?? quote?.shortName ?? symbol,
    country,
    industry: result.summaryProfile?.industry ?? null,
    currentPrice,
    sharesOutstanding,
    operatingIncomeLtm:
      operatingIncomeSeries.length === 4 ? operatingIncomeSeries.reduce((sum, value) => sum + value, 0) : null,
    cashAndEquivalents:
      balanceSheet?.cashAndCashEquivalents?.raw ?? balanceSheet?.cash?.raw ?? result.financialData?.totalCash?.raw ?? null,
    shortTermInvestments: balanceSheet?.shortTermInvestments?.raw ?? 0,
    shortTermBorrowings: balanceSheet?.shortLongTermDebt?.raw ?? balanceSheet?.shortTermDebt?.raw ?? 0,
    currentPortionLongTermDebt: balanceSheet?.currentLongTermDebt?.raw ?? 0,
    longTermDebt: balanceSheet?.longTermDebt?.raw ?? 0,
    averageDailyVolume,
    isChinese: country?.toLowerCase().includes("china") ?? false,
    currency: result.price?.currency ?? quote?.financialCurrency ?? "USD",
    source: "Yahoo Finance quoteSummary",
  };
};

export class YahooScreenerProvider implements ScreenerDataProvider {
  id = "yahoo" as const;

  async getStocks() {
    const symbols = config.yahooScreenerSymbols;
    const stocks = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          return await fetchYahooSummary(symbol);
        } catch {
          return null;
        }
      }),
    );

    return stocks.filter((stock): stock is RawStockRecord => stock !== null);
  }

  getAssumptions() {
    return [
      "Yahoo mode screens only the configured symbol universe from SCREENER_SYMBOLS; it is not a full-market crawl.",
      "Workbook-style formulas are used: market cap = price × shares outstanding, EV = market cap + short-term debt + current portion of long-term debt + long-term debt - cash - short-term investments.",
      "EBIT LTM is matched to the workbook by using the sum of the latest four quarterly operating income values returned by Yahoo.",
      "Yahoo quote data is used as a fallback for price, shares outstanding, market cap-derived shares, and average volume because quoteSummary often omits those fields.",
      "Yahoo Finance is an unofficial source and may rate-limit or omit fields for some tickers.",
    ];
  }
}
