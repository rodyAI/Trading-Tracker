import type { MarketDataProviderId } from "@shared/types";
import { fetchDailyCandles, fetchQuotes } from "../api/client";

export const refreshTradeQuotes = (symbols: string[], provider?: MarketDataProviderId) => fetchQuotes(symbols, provider);

export const loadTradeCandles = (symbol: string, provider?: MarketDataProviderId) =>
  fetchDailyCandles(symbol, provider);
