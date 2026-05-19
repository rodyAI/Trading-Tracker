export type ScreenerProviderId = "sample" | "yahoo" | "alphavantage";
export type MarketDataProviderId = "yahoo" | "alphavantage";

export interface RawStockRecord {
  ticker: string;
  companyName: string;
  country?: string | null;
  industry?: string | null;
  currentPrice?: number | null;
  sharesOutstanding?: number | null;
  operatingIncomeLtm?: number | null;
  cashAndEquivalents?: number | null;
  shortTermInvestments?: number | null;
  shortTermBorrowings?: number | null;
  currentPortionLongTermDebt?: number | null;
  longTermDebt?: number | null;
  averageDailyVolume?: number | null;
  isChinese?: boolean | null;
  currency?: string | null;
  source?: string | null;
}

export interface ScreenedStockRecord {
  ticker: string;
  companyName: string;
  country: string;
  industry: string;
  enterpriseValue: number;
  marketCap: number;
  evToEbit: number;
  ebitLtm: number;
  currentPrice: number;
  sharesOutstanding: number;
  cashAndEquivalents: number;
  shortTermInvestments: number;
  shortTermBorrowings: number;
  currentPortionLongTermDebt: number;
  longTermDebt: number;
  averageDailyVolume: number;
  averageDailyTradedValue: number;
  isChinese: boolean;
  currency: string;
  source: string;
}

export interface RejectionReason {
  code:
    | "missing-required-fields"
    | "market-cap"
    | "ev-ebit"
    | "ebit-ltm"
    | "industry"
    | "china"
    | "traded-value";
  message: string;
}

export interface ScreenedStockResult extends ScreenedStockRecord {
  passed: boolean;
  rejectionReasons: RejectionReason[];
}

export interface ScreenerRunResponse {
  provider: ScreenerProviderId;
  generatedAt: number;
  universeSize: number;
  passedCount: number;
  assumptions: string[];
  results: ScreenedStockResult[];
}

export interface MarketQuote {
  symbol: string;
  price: number;
  currency: string;
  provider: MarketDataProviderId;
  asOf: number;
}

export interface MarketCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface QuoteBatchResponse {
  provider: MarketDataProviderId;
  generatedAt: number;
  quotes: MarketQuote[];
  errors: Array<{
    symbol: string;
    message: string;
    attempts?: Array<{
      source: string;
      status: "failed";
      message: string;
    }>;
  }>;
}

export interface CandleResponse {
  symbol: string;
  provider: MarketDataProviderId;
  generatedAt: number;
  candles: MarketCandle[];
}
