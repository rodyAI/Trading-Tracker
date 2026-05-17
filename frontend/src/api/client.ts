import type {
  CandleResponse,
  MarketDataProviderId,
  QuoteBatchResponse,
  ScreenerProviderId,
  ScreenerRunResponse,
} from "@shared/types";
import type { TrackedTrade } from "../utils/tradeCalculations";

const resolveApiBase = () => {
  const configuredBase = import.meta.env.VITE_API_BASE_URL;
  if (configuredBase) return configuredBase;
  if (typeof window === "undefined") return "http://localhost:8787/api";
  return `${window.location.protocol}//${window.location.hostname}:8787/api`;
};

const API_BASE = resolveApiBase();

const getErrorMessage = async (response: Response, fallback: string) => {
  let message = fallback;
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload.error) message = payload.error;
  } catch {
    // Ignore JSON parse errors and keep the default message.
  }
  return message;
};

export const runScreen = async (provider: ScreenerProviderId) => {
  const url = new URL(`${API_BASE}/screener/run`);
  url.searchParams.set("provider", provider);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await getErrorMessage(response, "Failed to run screen"));
  }

  return (await response.json()) as ScreenerRunResponse;
};

export const fetchQuotes = async (symbols: string[], provider?: MarketDataProviderId) => {
  const url = new URL(`${API_BASE}/market/quotes`);
  if (provider) url.searchParams.set("provider", provider);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, "Failed to fetch current prices"));
  }

  return (await response.json()) as QuoteBatchResponse;
};

export const fetchDailyCandles = async (symbol: string, provider?: MarketDataProviderId) => {
  const url = new URL(`${API_BASE}/market/candles/${encodeURIComponent(symbol)}`);
  if (provider) url.searchParams.set("provider", provider);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Failed to fetch daily candles for ${symbol}`));
  }

  return (await response.json()) as CandleResponse;
};

export const fetchStoredTrades = async () => {
  const response = await fetch(`${API_BASE}/trades`);
  if (!response.ok) {
    throw new Error(await getErrorMessage(response, "Failed to load trades"));
  }

  return (await response.json()) as { trades: TrackedTrade[] };
};

export const saveStoredTrade = async (trade: TrackedTrade) => {
  const response = await fetch(`${API_BASE}/trades/${encodeURIComponent(trade.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(trade),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, "Failed to save trade"));
  }

  return (await response.json()) as { trade: TrackedTrade };
};

export const replaceStoredTrades = async (trades: TrackedTrade[]) => {
  const response = await fetch(`${API_BASE}/trades`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trades }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, "Failed to replace trades"));
  }

  return (await response.json()) as { trades: TrackedTrade[] };
};

export const importStoredTrades = async (trades: TrackedTrade[]) => {
  const response = await fetch(`${API_BASE}/trades/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trades }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, "Failed to import trades"));
  }

  return (await response.json()) as { trades: TrackedTrade[] };
};

export const deleteStoredTrade = async (id: string) => {
  const response = await fetch(`${API_BASE}/trades/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(await getErrorMessage(response, "Failed to delete trade"));
  }
};
