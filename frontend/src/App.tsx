import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketCandle, MarketDataProviderId } from "@shared/types";
import { buildInfo } from "./buildInfo";
import {
  signInWithEmail,
  signInWithGoogle,
  signOutCurrentUser,
  signUpWithEmail,
  firebaseRuntimeInfo,
  isFirebaseConfigured,
  missingFirebaseConfigKeys,
  subscribeToAuth,
  type User,
} from "./firebase/client";
import {
  deleteUserTrade,
  importUserTrades,
  loadTradePersistenceDiagnostics,
  loadUserTradesFromServer,
  saveUserTrade,
} from "./services/firebaseTradeStore";
import {
  loadPortfolioSettingsFromServer,
  savePortfolioSettings,
} from "./services/firebasePortfolioSettings";
import { loadTradeCandles, refreshTradeQuotes } from "./services/marketDataService";
import {
  TRADE_CATEGORIES,
  TradeCategory,
  TradeFormValues,
  TrackedTrade,
  calculateProfitLossDollars,
  calculateProfitLossPercent,
  calculateRewardAmount,
  calculateRiskAmount,
  calculateRiskRewardRatio,
  getTradeStatus,
  isNearStopOrTarget,
  recommendTakeProfit,
  validateTradeForm,
} from "./utils/tradeCalculations";

type SortKey = "symbol" | "profitLoss" | "riskReward" | "status";
type SortDirection = "asc" | "desc";

const PROVIDER_STORAGE_KEY = "swing-trading-tracker-provider";
const PORTFOLIO_SETTINGS_STORAGE_PREFIX = "swing-trading-tracker-portfolio-settings";
const REFRESH_STEP_TIMEOUT_MS = 30_000;
const formatTimeoutSeconds = (timeoutMs = REFRESH_STEP_TIMEOUT_MS) => Math.round(timeoutMs / 1000);

const emptyForm: TradeFormValues = {
  category: "Swing",
  symbol: "",
  quantity: "",
  entryPrice: "",
  stopLoss: "",
  takeProfit: "",
  notes: "",
  entryDate: "",
  tags: "",
  excludeFromPortfolioTotals: false,
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const priceFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat("en-US");

const formatCurrency = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "Unavailable" : currencyFormatter.format(value);

const formatPrice = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "Unavailable" : priceFormatter.format(value);

const formatPercent = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "Unavailable" : `${percentFormatter.format(value)}%`;

const createId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const tradeMetrics = (trade: TrackedTrade) => {
  const resolvedPrice = trade.isClosed ? trade.exitPrice : trade.currentPrice;
  const profitLoss =
    resolvedPrice == null
      ? null
      : calculateProfitLossDollars(resolvedPrice, trade.entryPrice, trade.quantity);
  const profitLossPercent =
    resolvedPrice == null ? null : calculateProfitLossPercent(resolvedPrice, trade.entryPrice);
  const riskAmount = calculateRiskAmount(trade.entryPrice, trade.stopLoss, trade.quantity);
  const rewardAmount = calculateRewardAmount(trade.entryPrice, trade.takeProfit, trade.quantity);
  const riskRewardRatio = calculateRiskRewardRatio(riskAmount, rewardAmount);
  const status = getTradeStatus(trade);

  return {
    profitLoss,
    profitLossPercent,
    riskAmount,
    rewardAmount,
    riskRewardRatio,
    status,
  };
};

const summarizeTrades = (items: TrackedTrade[]) => {
  const openTrades = items.filter((trade) => !trade.isClosed);
  const closedTrades = items.filter((trade) => trade.isClosed);
  const invested = openTrades.reduce((sum, trade) => sum + trade.entryPrice * trade.quantity, 0);
  const unrealized = items.reduce((sum, trade) => {
    if (trade.isClosed || trade.currentPrice == null) return sum;
    return sum + calculateProfitLossDollars(trade.currentPrice, trade.entryPrice, trade.quantity);
  }, 0);
  const realizedBasis = closedTrades.reduce((sum, trade) => sum + trade.entryPrice * trade.quantity, 0);
  const realized = closedTrades.reduce((sum, trade) => {
    if (trade.exitPrice == null) return sum;
    return sum + calculateProfitLossDollars(trade.exitPrice, trade.entryPrice, trade.quantity);
  }, 0);
  const totalBasis = invested + realizedBasis;
  const totalProfitLoss = unrealized + realized;

  return {
    invested,
    unrealized,
    unrealizedPercent: invested > 0 ? (unrealized / invested) * 100 : null,
    realized,
    realizedPercent: realizedBasis > 0 ? (realized / realizedBasis) * 100 : null,
    totalProfitLoss,
    totalProfitLossPercent: totalBasis > 0 ? (totalProfitLoss / totalBasis) * 100 : null,
    openCount: openTrades.length,
    closedCount: closedTrades.length,
  };
};

const shouldIncludeInPortfolioTotals = (trade: TrackedTrade, excludedCategories: Set<TradeCategory>) =>
  !trade.excludeFromPortfolioTotals && !excludedCategories.has(trade.category ?? "Swing");

const portfolioSettingsStorageKey = (user: User) => `${PORTFOLIO_SETTINGS_STORAGE_PREFIX}-${user.uid}`;

const cacheExcludedCategories = (user: User, excludedCategories: TradeCategory[]) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    portfolioSettingsStorageKey(user),
    JSON.stringify({ excludedCategories }),
  );
};

const withTimeout = async <T,>(promise: Promise<T>, message: string, timeoutMs = REFRESH_STEP_TIMEOUT_MS) => {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
};

const formatRecommendationDataError = (symbol: string, provider: MarketDataProviderId, error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown candle data error.";
  return `Candle data could not be loaded for ${symbol} using ${provider}. The sell recommendation fell back to the default model. Error details: ${message}`;
};

const isRecommendationDataError = (trade: TrackedTrade) =>
  trade.recommendationExplanation?.startsWith("Candle data could not be loaded") ||
  trade.recommendationExplanation?.startsWith("Candle data was unavailable");

const getRecommendationExplanation = (trade: TrackedTrade) =>
  trade.recommendationExplanation || "Recommendation not calculated for this session yet.";

const isVisibleTrade = (trade: TrackedTrade) => trade.isDeleted !== true;

const mergeLocalMarketData = (trade: TrackedTrade, existing: TrackedTrade | undefined): TrackedTrade => {
  if (!existing || existing.symbol !== trade.symbol) return trade;

  return {
    ...trade,
    currentPrice: existing.currentPrice ?? null,
    currentPriceAsOf: existing.currentPriceAsOf ?? null,
    currentPriceProvider: existing.currentPriceProvider ?? null,
    priceError: existing.priceError ?? null,
    recommendedTakeProfit: existing.recommendedTakeProfit ?? null,
    recommendationExplanation: existing.recommendationExplanation ?? "",
    chartCandles: existing.chartCandles ?? [],
  };
};

const todayIsoDate = () => new Date().toISOString().slice(0, 10);

const getDefaultExitPrice = (trade: TrackedTrade) =>
  trade.currentPrice ?? trade.takeProfit ?? trade.recommendedTakeProfit ?? trade.entryPrice;

const parseExitPrice = (value: string | null) => {
  if (value == null) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const getChartCandles = (candles: MarketCandle[]) => candles.slice(-80);

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [trades, setTrades] = useState<TrackedTrade[]>([]);
  const [form, setForm] = useState<TradeFormValues>(emptyForm);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof TradeFormValues, string>>>({});
  const [provider, setProvider] = useState<MarketDataProviderId>(() => {
    if (typeof window === "undefined") return "yahoo";
    const saved = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    return saved === "alphavantage" || saved === "yahoo" ? saved : "yahoo";
  });
  const [sortKey, setSortKey] = useState<SortKey>("symbol");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [activeCategory, setActiveCategory] = useState<TradeCategory>("Swing");
  const [importCategory, setImportCategory] = useState<TradeCategory>("Swing");
  const [excludedPortfolioCategories, setExcludedPortfolioCategories] = useState<TradeCategory[]>([]);
  const [isImportChooserOpen, setIsImportChooserOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Ready. Add a trade or refresh prices.");
  const [globalError, setGlobalError] = useState("");
  const [persistenceDiagnostics, setPersistenceDiagnostics] = useState("");
  const [deleteResult, setDeleteResult] = useState("");
  const [lastServerSync, setLastServerSync] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRecalculatingRecommendations, setIsRecalculatingRecommendations] = useState(false);
  const [recommendationProgress, setRecommendationProgress] = useState<{ current: number; total: number } | null>(null);
  const [recalculatingTradeIds, setRecalculatingTradeIds] = useState<Set<string>>(() => new Set());
  const [isLoadingTrades, setIsLoadingTrades] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const initialRefreshUserRef = useRef<string | null>(null);
  const isRefreshingRef = useRef(false);
  const isRecalculatingRecommendationsRef = useRef(false);

  const syncServerState = useCallback(async () => {
    if (!user) return;

    const [serverTrades, serverSettings] = await Promise.all([
      loadUserTradesFromServer(user),
      loadPortfolioSettingsFromServer(user),
    ]);

    setTrades((currentTrades) =>
      serverTrades.map((trade) =>
        mergeLocalMarketData(
          trade,
          currentTrades.find((currentTrade) => currentTrade.id === trade.id),
        ),
      ),
    );
    setExcludedPortfolioCategories(serverSettings.excludedCategories);
    cacheExcludedCategories(user, serverSettings.excludedCategories);
    setLastServerSync(new Date().toLocaleTimeString());
  }, [user]);

  useEffect(() => {
    return subscribeToAuth((nextUser) => {
      setUser(nextUser);
      setIsAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!user) {
      setTrades([]);
      setExcludedPortfolioCategories([]);
      setIsLoadingTrades(false);
      initialRefreshUserRef.current = null;
      setStatusMessage("Sign in to load your trades.");
      return undefined;
    }

    setIsLoadingTrades(true);
    setGlobalError("");
    setPersistenceDiagnostics("");
    void syncServerState()
      .then(() => {
        setIsLoadingTrades(false);
        setStatusMessage("Loaded latest server state.");
      })
      .catch((error) => {
        setIsLoadingTrades(false);
        setGlobalError(error instanceof Error ? error.message : "Failed to load latest server state.");
        setStatusMessage("Trade load failed.");
      });
    return undefined;
  }, [syncServerState, user]);

  useEffect(() => {
    if (!user || typeof window === "undefined") return undefined;

    const syncOnFocus = () => {
      void syncServerState().catch((error) => {
        setGlobalError(error instanceof Error ? error.message : "Failed to load latest server state.");
      });
    };

    window.addEventListener("focus", syncOnFocus);
    return () => window.removeEventListener("focus", syncOnFocus);
  }, [syncServerState, user]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
  }, [provider]);

  const enrichTradeRecommendation = useCallback(
    async (trade: TrackedTrade) => {
      try {
        const response = await withTimeout(
          loadTradeCandles(trade.symbol, provider),
          `Candle data request for ${trade.symbol} timed out after ${formatTimeoutSeconds()} seconds.`,
        );
        const recommendation = recommendTakeProfit(
          trade.entryPrice,
          trade.stopLoss,
          trade.quantity,
          response.candles,
        );
        return {
          ...trade,
          recommendedTakeProfit: recommendation.price,
          recommendationExplanation: recommendation.explanation,
          chartCandles: getChartCandles(response.candles),
        };
      } catch (error) {
        const recommendation = recommendTakeProfit(trade.entryPrice, trade.stopLoss, trade.quantity);
        return {
          ...trade,
          recommendedTakeProfit: recommendation.price,
          recommendationExplanation: formatRecommendationDataError(trade.symbol, provider, error),
          chartCandles: [],
        };
      }
    },
    [provider],
  );

  const refreshPrices = useCallback(async () => {
    if (isRefreshingRef.current) return;

    if (!user) {
      setStatusMessage("Sign in to refresh prices.");
      return;
    }

    const symbols = [
      ...new Set(trades.filter((trade) => isVisibleTrade(trade) && !trade.isClosed).map((trade) => trade.symbol).filter(Boolean)),
    ];
    if (symbols.length === 0) {
      setStatusMessage("No trades to refresh yet.");
      return;
    }

    isRefreshingRef.current = true;
    setIsRefreshing(true);
    setGlobalError("");

    try {
      const response = await withTimeout(
        refreshTradeQuotes(symbols, provider),
        "Price refresh timed out after 30 seconds. Try again in a moment.",
      );
      const quoteBySymbol = new Map(response.quotes.map((quote) => [quote.symbol.toUpperCase(), quote]));
      const errorBySymbol = new Map(response.errors.map((error) => [error.symbol.toUpperCase(), error.message]));

      const nextTrades = trades.filter(isVisibleTrade).map((trade) => {
        const quote = quoteBySymbol.get(trade.symbol.toUpperCase());
        const priceError = errorBySymbol.get(trade.symbol.toUpperCase()) ?? null;
        if (!quote) {
          return {
            ...trade,
            currentPrice: null,
            currentPriceAsOf: null,
            currentPriceProvider: null,
            priceError: priceError ?? "Current price could not be fetched.",
          };
        }
        return {
          ...trade,
          currentPrice: quote.price,
          currentPriceAsOf: quote.asOf,
          currentPriceProvider: quote.provider,
          priceError,
        };
      });
      setTrades(nextTrades);

      const failures = response.errors.length;
      setStatusMessage(
        `Refreshed ${response.quotes.length} quote${response.quotes.length === 1 ? "" : "s"} from ${response.provider}.`,
      );
      setGlobalError(failures ? `${failures} symbol${failures === 1 ? "" : "s"} could not be refreshed.` : "");
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "Unable to refresh current prices.");
      setStatusMessage("Price refresh failed.");
    } finally {
      isRefreshingRef.current = false;
      setIsRefreshing(false);
    }
  }, [provider, trades, user]);

  const recalculateSellRecommendations = useCallback(async () => {
    if (isRecalculatingRecommendationsRef.current) return;

    if (!user) {
      setStatusMessage("Sign in to recalculate sell recommendations.");
      return;
    }

    const tabTrades = trades.filter((trade) => isVisibleTrade(trade) && (trade.category ?? "Swing") === activeCategory);

    if (tabTrades.length === 0) {
      setStatusMessage(`No trades to recalculate in ${activeCategory}.`);
      return;
    }

    isRecalculatingRecommendationsRef.current = true;
    setIsRecalculatingRecommendations(true);
    setGlobalError("");
    setRecommendationProgress({ current: 0, total: tabTrades.length });

    const updatedRecommendations: TrackedTrade[] = [];
    const failures: string[] = [];

    try {
      for (const [index, trade] of tabTrades.entries()) {
        setRecommendationProgress({ current: index + 1, total: tabTrades.length });
        setStatusMessage(
          `Recalculating ${activeCategory} sell recommendations ${index + 1}/${tabTrades.length}: ${trade.symbol}`,
        );

        try {
          const recalculatedTrade = await enrichTradeRecommendation(trade);
          updatedRecommendations.push(recalculatedTrade);
        } catch (error) {
          failures.push(`${trade.symbol}: ${error instanceof Error ? error.message : "Recommendation calculation failed."}`);
        }
      }

      if (updatedRecommendations.length > 0) {
        setTrades((currentTrades) =>
          currentTrades.map((trade) => {
            const updatedTrade = updatedRecommendations.find((candidate) => candidate.id === trade.id);
            if (!updatedTrade) return trade;

            return {
              ...trade,
              recommendedTakeProfit: updatedTrade.recommendedTakeProfit,
              recommendationExplanation: updatedTrade.recommendationExplanation,
            };
          }),
        );
      }

      setStatusMessage(
        `Updated ${updatedRecommendations.length} ${activeCategory} sell recommendation${
          updatedRecommendations.length === 1 ? "" : "s"
        } locally.`,
      );
      setGlobalError(
        failures.length > 0 ? `Some recommendations could not be recalculated. ${failures.join(" ")}` : "",
      );
    } finally {
      isRecalculatingRecommendationsRef.current = false;
      setIsRecalculatingRecommendations(false);
      setRecommendationProgress(null);
    }
  }, [activeCategory, enrichTradeRecommendation, trades, user]);

  const handleRecalculateTrade = async (trade: TrackedTrade) => {
    if (trade.isClosed || recalculatingTradeIds.has(trade.id)) return;

    setRecalculatingTradeIds((current) => new Set(current).add(trade.id));
    setGlobalError("");
    setStatusMessage(`Recalculating ${trade.symbol} sell recommendation...`);

    try {
      const updatedTrade = await enrichTradeRecommendation(trade);
      setTrades((currentTrades) =>
        currentTrades.map((currentTrade) =>
          currentTrade.id === trade.id
            ? {
                ...currentTrade,
                recommendedTakeProfit: updatedTrade.recommendedTakeProfit,
                recommendationExplanation: updatedTrade.recommendationExplanation,
                chartCandles: updatedTrade.chartCandles ?? [],
              }
            : currentTrade,
        ),
      );
      setStatusMessage(`${trade.symbol} recommendation updated locally.`);
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : `Failed to recalculate ${trade.symbol}.`);
      setStatusMessage(`${trade.symbol} recommendation failed.`);
    } finally {
      setRecalculatingTradeIds((current) => {
        const next = new Set(current);
        next.delete(trade.id);
        return next;
      });
    }
  };

  const handleCloseTrade = async (trade: TrackedTrade) => {
    if (!user) {
      setStatusMessage("Sign in before closing trades.");
      return;
    }

    const defaultExitPrice = getDefaultExitPrice(trade);
    const input = window.prompt(`Exit price for ${trade.symbol}`, priceFormatter.format(defaultExitPrice).replace(/,/g, ""));
    const exitPrice = parseExitPrice(input);

    if (input == null) return;
    if (exitPrice == null) {
      setGlobalError("Exit price must be greater than 0.");
      return;
    }

    const closedTrade: TrackedTrade = {
      ...trade,
      isClosed: true,
      exitPrice,
      exitDate: todayIsoDate(),
      currentPrice: null,
      currentPriceAsOf: null,
      currentPriceProvider: null,
      priceError: null,
    };

    try {
      await saveUserTrade(user, closedTrade);
      setTrades((currentTrades) => currentTrades.map((currentTrade) => (currentTrade.id === trade.id ? closedTrade : currentTrade)));
      setStatusMessage(`${trade.symbol} closed at ${formatPrice(exitPrice)}.`);
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : `Failed to close ${trade.symbol}.`);
    }
  };

  const handleReopenTrade = async (trade: TrackedTrade) => {
    if (!user) {
      setStatusMessage("Sign in before reopening trades.");
      return;
    }

    const reopenedTrade: TrackedTrade = {
      ...trade,
      isClosed: false,
      exitPrice: null,
      exitDate: "",
    };

    try {
      await saveUserTrade(user, reopenedTrade);
      setTrades((currentTrades) => currentTrades.map((currentTrade) => (currentTrade.id === trade.id ? reopenedTrade : currentTrade)));
      setStatusMessage(`${trade.symbol} reopened.`);
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : `Failed to reopen ${trade.symbol}.`);
    }
  };

  const handleToggleTradePortfolioInclusion = async (trade: TrackedTrade) => {
    if (!user) {
      setStatusMessage("Sign in before changing total P/L settings.");
      return;
    }

    const updatedTrade = {
      ...trade,
      excludeFromPortfolioTotals: !trade.excludeFromPortfolioTotals,
    };

    try {
      await saveUserTrade(user, updatedTrade);
      setTrades((currentTrades) => currentTrades.map((currentTrade) => (currentTrade.id === trade.id ? updatedTrade : currentTrade)));
      setStatusMessage(
        `${trade.symbol} ${updatedTrade.excludeFromPortfolioTotals ? "excluded from" : "included in"} portfolio total P/L.`,
      );
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : `Failed to update ${trade.symbol} total P/L setting.`);
    }
  };

  const handleToggleCategoryPortfolioInclusion = async (category: TradeCategory) => {
    if (!user) {
      setStatusMessage("Sign in before changing total P/L settings.");
      return;
    }

    const nextCategories = excludedPortfolioCategories.includes(category)
      ? excludedPortfolioCategories.filter((item) => item !== category)
      : [...excludedPortfolioCategories, category];

    setExcludedPortfolioCategories(nextCategories);
    cacheExcludedCategories(user, nextCategories);
    try {
      const savedSettings = await savePortfolioSettings(user, { excludedCategories: nextCategories });
      setExcludedPortfolioCategories(savedSettings.excludedCategories);
      cacheExcludedCategories(user, savedSettings.excludedCategories);
      setStatusMessage(`${category} ${nextCategories.includes(category) ? "excluded from" : "included in"} portfolio total P/L.`);
    } catch (error) {
      setExcludedPortfolioCategories(excludedPortfolioCategories);
      cacheExcludedCategories(user, excludedPortfolioCategories);
      setGlobalError(error instanceof Error ? error.message : `Failed to update ${category} total P/L setting.`);
    }
  };

  useEffect(() => {
    if (!user || isLoadingTrades || trades.filter(isVisibleTrade).length === 0) return;
    if (initialRefreshUserRef.current === user.uid) return;

    initialRefreshUserRef.current = user.uid;
    void refreshPrices();
  }, [isLoadingTrades, refreshPrices, trades, user]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshPrices();
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [refreshPrices]);

  const handleFormChange = (field: keyof TradeFormValues) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
    setFormErrors((current) => ({ ...current, [field]: undefined }));
  };

  const handleFormCheckedChange = (field: keyof Pick<TradeFormValues, "excludeFromPortfolioTotals">) => (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    setForm((current) => ({ ...current, [field]: event.target.checked }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) {
      setStatusMessage("Sign in before saving trades.");
      return;
    }

    const validation = validateTradeForm(form);
    setFormErrors(validation.errors);
    if (!validation.values) return;

    const existingTrade = form.id ? trades.find((trade) => trade.id === form.id) : null;
    const baseTrade: TrackedTrade = {
      ...(existingTrade ?? {}),
      ...validation.values,
      id: form.id ?? createId(),
      category: validation.values.category,
      priceError: existingTrade?.symbol === validation.values.symbol ? existingTrade?.priceError : null,
      currentPrice: existingTrade?.symbol === validation.values.symbol ? existingTrade?.currentPrice : null,
      currentPriceAsOf: existingTrade?.symbol === validation.values.symbol ? existingTrade?.currentPriceAsOf : null,
      currentPriceProvider: existingTrade?.symbol === validation.values.symbol ? existingTrade?.currentPriceProvider : null,
      excludeFromPortfolioTotals: validation.values.excludeFromPortfolioTotals,
    };

    setStatusMessage("Saving trade and calculating the recommended sell price...");
    const tradeWithRecommendation = await enrichTradeRecommendation(baseTrade);
    try {
      await saveUserTrade(user, tradeWithRecommendation);
      setTrades((currentTrades) => {
        const exists = currentTrades.some((trade) => trade.id === tradeWithRecommendation.id);
        if (!exists) return [tradeWithRecommendation, ...currentTrades];
        return currentTrades.map((trade) => (trade.id === tradeWithRecommendation.id ? tradeWithRecommendation : trade));
      });

      setActiveCategory(tradeWithRecommendation.category ?? "Swing");
      setForm(emptyForm);
      setStatusMessage(`${tradeWithRecommendation.symbol} saved. Sell recommendation updated locally.`);
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "Failed to save trade to Firestore.");
      setStatusMessage("Trade save failed.");
    }
  };

  const handleEdit = (trade: TrackedTrade) => {
    setForm({
      id: trade.id,
      category: trade.category ?? "Swing",
      symbol: trade.symbol,
      quantity: String(trade.quantity),
      entryPrice: String(trade.entryPrice),
      stopLoss: trade.stopLoss == null ? "" : String(trade.stopLoss),
      takeProfit: trade.takeProfit == null ? "" : String(trade.takeProfit),
      notes: trade.notes ?? "",
      entryDate: trade.entryDate ?? "",
      tags: (trade.tags ?? []).join(", "),
      excludeFromPortfolioTotals: trade.excludeFromPortfolioTotals ?? false,
    });
    setFormErrors({});
    setActiveCategory(trade.category ?? "Swing");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleDelete = async (trade: TrackedTrade) => {
    if (!user) {
      setStatusMessage("Sign in before deleting trades.");
      return;
    }

    const confirmed = window.confirm(`Delete ${trade.symbol}? This removes it from Firestore and cannot be undone.`);
    if (!confirmed) return;

    setGlobalError("");
    setDeleteResult("");
    setStatusMessage(`Deleting ${trade.symbol} from Firestore...`);

    try {
      const result = await deleteUserTrade(user, trade);
      await syncServerState();
      if (form.id === trade.id) setForm(emptyForm);
      const duplicateText =
        result.remainingSameSymbolIds.length > 0
          ? ` Other ${result.symbol} document ids still exist: ${result.remainingSameSymbolIds.join(", ")}.`
          : "";
      const message = `${result.symbol} delete confirmed from ${result.path}. Document id ${result.id} ${
        result.existedBeforeDelete ? "was removed" : "was already absent"
      }.${duplicateText}`;
      setDeleteResult(message);
      setStatusMessage(`${trade.symbol} delete confirmed by Firestore.`);
      window.alert(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete trade.";
      const deleteMessage = `Delete failed for ${trade.symbol}: ${message}`;
      setGlobalError(message);
      setDeleteResult(deleteMessage);
      setStatusMessage(`${trade.symbol} delete failed.`);
      window.alert(deleteMessage);
    }
  };

  const handlePersistenceCheck = async () => {
    if (!user) {
      setStatusMessage("Sign in before checking server data.");
      return;
    }

    setGlobalError("");
    setStatusMessage("Checking Firestore server data...");

    try {
      const [tradeDiagnostics, portfolioSettings] = await Promise.all([
        loadTradePersistenceDiagnostics(user),
        loadPortfolioSettingsFromServer(user),
      ]);
      const rawTradeText =
        tradeDiagnostics.rawTrades.length === 0
          ? "none"
          : tradeDiagnostics.rawTrades
              .map(
                (trade) =>
                  `${trade.symbol}:${trade.id}${trade.isDeleted ? ":isDeleted" : ""}${
                    trade.hasDeletedMarker ? ":deletedMarker" : ""
                  }`,
              )
              .join(", ");
      const deletedMarkerText =
        tradeDiagnostics.deletedTradeIds.length === 0 ? "none" : tradeDiagnostics.deletedTradeIds.join(", ");
      const deletedSymbolText =
        tradeDiagnostics.deletedSymbols.length === 0 ? "none" : tradeDiagnostics.deletedSymbols.join(", ");
      const visibleTradeText =
        tradeDiagnostics.visibleTradeIds.length === 0 ? "none" : tradeDiagnostics.visibleTradeIds.join(", ");
      const excludedCategoryText =
        portfolioSettings.excludedCategories.length === 0 ? "none" : portfolioSettings.excludedCategories.join(", ");

      setPersistenceDiagnostics(
        [
          `UID: ${tradeDiagnostics.uid}`,
          `Firebase project: ${firebaseRuntimeInfo.projectId}`,
          `Firebase auth domain: ${firebaseRuntimeInfo.authDomain}`,
          `Firebase app id: ${firebaseRuntimeInfo.appId}`,
          `Raw trades: ${rawTradeText}`,
          `Deleted markers: ${deletedMarkerText}`,
          `Deleted symbols: ${deletedSymbolText}`,
          `Visible trade ids: ${visibleTradeText}`,
          `Server excluded tabs: ${excludedCategoryText}`,
        ].join("\n"),
      );
      setStatusMessage("Server data check complete.");
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "Failed to check Firestore server data.");
      setStatusMessage("Server data check failed.");
    }
  };

  const handleCancelEdit = () => {
    setForm(emptyForm);
    setFormErrors({});
  };

  const handleSort = (nextKey: SortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === "symbol" ? "asc" : "desc");
  };

  const sortedTrades = useMemo(() => {
    const compare = (left: TrackedTrade, right: TrackedTrade) => {
      if (sortKey === "symbol") return left.symbol.localeCompare(right.symbol);
      if (sortKey === "status") return tradeMetrics(left).status.localeCompare(tradeMetrics(right).status);
      if (sortKey === "profitLoss") {
        return (tradeMetrics(left).profitLoss ?? Number.NEGATIVE_INFINITY) - (tradeMetrics(right).profitLoss ?? Number.NEGATIVE_INFINITY);
      }
      return (
        (tradeMetrics(left).riskRewardRatio ?? Number.NEGATIVE_INFINITY) -
        (tradeMetrics(right).riskRewardRatio ?? Number.NEGATIVE_INFINITY)
      );
    };

    return trades.filter(isVisibleTrade).sort((left, right) => (sortDirection === "asc" ? compare(left, right) : -compare(left, right)));
  }, [sortDirection, sortKey, trades]);

  const tradesByCategory = useMemo(
    () =>
      TRADE_CATEGORIES.reduce(
        (groups, category) => ({
          ...groups,
          [category]: sortedTrades.filter((trade) => (trade.category ?? "Swing") === category),
        }),
        {} as Record<TradeCategory, TrackedTrade[]>,
      ),
    [sortedTrades],
  );
  const activeTrades = tradesByCategory[activeCategory] ?? [];
  const categorySummaries = useMemo(
    () =>
      TRADE_CATEGORIES.reduce(
        (summaries, category) => ({
          ...summaries,
          [category]: summarizeTrades(tradesByCategory[category]),
        }),
        {} as Record<TradeCategory, ReturnType<typeof summarizeTrades>>,
      ),
    [tradesByCategory],
  );
  const activeSummary = categorySummaries[activeCategory];
  const excludedPortfolioCategorySet = useMemo(
    () => new Set(excludedPortfolioCategories),
    [excludedPortfolioCategories],
  );
  const portfolioTotalTrades = useMemo(
    () => trades.filter((trade) => isVisibleTrade(trade) && shouldIncludeInPortfolioTotals(trade, excludedPortfolioCategorySet)),
    [excludedPortfolioCategorySet, trades],
  );
  const visibleTradeCount = trades.filter(isVisibleTrade).length;
  const excludedFromPortfolioTotalCount = visibleTradeCount - portfolioTotalTrades.length;

  const portfolio = useMemo(() => {
    return summarizeTrades(portfolioTotalTrades);
  }, [portfolioTotalTrades]);

  const exportCsv = () => {
    const header = [
      "Symbol",
      "Category",
      "Quantity",
      "Entry Price",
      "Stop Loss",
      "Take Profit",
      "Recommended Sell",
      "Current Price",
      "P/L $",
      "P/L %",
      "Risk $",
      "Reward $",
      "Risk/Reward",
      "Status",
      "Entry Date",
      "Tags",
      "Notes",
      "Closed",
      "Exit Price",
      "Exit Date",
      "Exclude From Portfolio Total",
    ];

    const rows = trades.filter(isVisibleTrade).map((trade) => {
      const metrics = tradeMetrics(trade);
      return [
        trade.symbol,
        trade.category ?? "Swing",
        trade.quantity,
        trade.entryPrice,
        trade.stopLoss ?? "",
        trade.takeProfit ?? "",
        trade.recommendedTakeProfit ?? "",
        trade.currentPrice ?? "",
        metrics.profitLoss ?? "",
        metrics.profitLossPercent ?? "",
        metrics.riskAmount,
        metrics.rewardAmount ?? "",
        metrics.riskRewardRatio ?? "",
        metrics.status,
        trade.entryDate ?? "",
        (trade.tags ?? []).join("|"),
        trade.notes ?? "",
        trade.isClosed ? "yes" : "no",
        trade.exitPrice ?? "",
        trade.exitDate ?? "",
        trade.excludeFromPortfolioTotals ? "yes" : "no",
      ];
    });

    const csv = [header, ...rows]
      .map((row) =>
        row
          .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
          .join(","),
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "swing-trades.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importCsv = async (file: File, targetCategory: TradeCategory) => {
    if (!user) {
      setStatusMessage("Sign in before importing trades.");
      return;
    }

    const text = await file.text();
    const [, ...lines] = text.split(/\r?\n/).filter(Boolean);
    const importedTrades: TrackedTrade[] = [];

    for (const line of lines) {
      const cells = line.match(/("([^"]|"")*"|[^,]+)/g)?.map((cell) => cell.replace(/^"|"$/g, "").replace(/""/g, '"')) ?? [];
      const importedCategory = TRADE_CATEGORIES.find((category) => category === cells[1]);
      const offset = importedCategory ? 1 : 0;
      const symbol = cells[0];
      const quantity = cells[1 + offset];
      const entryPrice = cells[2 + offset];
      const stopLoss = cells[3 + offset];
      const takeProfit = cells[4 + offset];
      const entryDate = cells[13 + offset];
      const tags = cells[14 + offset];
      const notes = cells[15 + offset];
      const closed = cells[16 + offset]?.toLowerCase() === "yes";
      const exitPrice = closed ? Number(cells[17 + offset]) : null;
      const exitDate = cells[18 + offset] ?? "";
      const excludeFromPortfolioTotals = cells[19 + offset]?.toLowerCase() === "yes";
      const validation = validateTradeForm({
        ...emptyForm,
        category: targetCategory,
        symbol: symbol ?? "",
        quantity: quantity ?? "",
        entryPrice: entryPrice ?? "",
        stopLoss: stopLoss ?? "",
        takeProfit: takeProfit ?? "",
        entryDate: entryDate ?? "",
        tags: (tags ?? "").replace(/\|/g, ","),
        notes: notes ?? "",
      });
      if (validation.values) {
        importedTrades.push(
          await enrichTradeRecommendation({
            id: createId(),
            ...validation.values,
            isClosed: closed,
            exitPrice: exitPrice != null && Number.isFinite(exitPrice) ? exitPrice : null,
            exitDate,
            excludeFromPortfolioTotals,
          }),
        );
      }
    }

    if (importedTrades.length > 0) {
      const savedTrades = await importUserTrades(user, importedTrades);
      const localTrades = savedTrades.map((savedTrade) => {
        const localTrade = importedTrades.find((trade) => trade.id === savedTrade.id);
        return localTrade ? mergeLocalMarketData(savedTrade, localTrade) : savedTrade;
      });
      setTrades((currentTrades) => [...localTrades, ...currentTrades]);
      setActiveCategory(targetCategory);
      setIsImportChooserOpen(false);
      setStatusMessage(
        `Imported ${savedTrades.length} trade${savedTrades.length === 1 ? "" : "s"} into ${targetCategory}. Recommendations updated locally.`,
      );
    } else {
      setGlobalError("No valid trades were found in the CSV.");
    }
  };

  const renderChartPreview = (trade: TrackedTrade) => {
    const candles = trade.chartCandles?.slice(-60) ?? [];
    if (candles.length < 2) {
      return <small className="chart-empty">Chart updates after recommendation recalculation.</small>;
    }

    const width = 220;
    const height = 84;
    const padding = 8;
    const closePrices = candles.map((candle) => candle.close);
    const levelPrices = [trade.entryPrice, trade.stopLoss, trade.takeProfit, trade.recommendedTakeProfit, trade.exitPrice].filter(
      (value): value is number => value != null && Number.isFinite(value),
    );
    const rawMin = Math.min(...closePrices, ...levelPrices);
    const rawMax = Math.max(...closePrices, ...levelPrices);
    const span = rawMax - rawMin || Math.max(rawMax * 0.02, 1);
    const min = rawMin - span * 0.12;
    const max = rawMax + span * 0.12;
    const xStep = (width - padding * 2) / Math.max(candles.length - 1, 1);
    const yFor = (price: number) => height - padding - ((price - min) / (max - min)) * (height - padding * 2);
    const points = candles.map((candle, index) => `${padding + index * xStep},${yFor(candle.close)}`).join(" ");
    const levels = [
      { label: "Entry", value: trade.entryPrice, className: "entry" },
      { label: "SL", value: trade.stopLoss, className: "stop" },
      { label: "TP", value: trade.takeProfit, className: "target" },
      { label: "Rec", value: trade.recommendedTakeProfit, className: "recommended" },
      { label: "Exit", value: trade.exitPrice, className: "exit" },
    ].filter((level): level is { label: string; value: number; className: string } => level.value != null && Number.isFinite(level.value));

    return (
      <div className="chart-preview" aria-label={`${trade.symbol} chart preview`}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img">
          <polyline className="price-line" points={points} />
          {levels.map((level) => {
            const y = yFor(level.value);
            return (
              <g key={`${level.label}-${level.value}`} className={`chart-level ${level.className}`}>
                <line x1={padding} x2={width - padding} y1={y} y2={y} />
                <text x={width - padding - 2} y={Math.max(10, y - 3)}>
                  {level.label}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="chart-legend">
          <span>Entry</span>
          {trade.stopLoss != null && <span>SL</span>}
          {trade.takeProfit != null && <span>TP</span>}
          {trade.recommendedTakeProfit != null && <span>Rec</span>}
          {trade.isClosed && trade.exitPrice != null && <span>Exit</span>}
        </div>
      </div>
    );
  };

  const renderTradeActions = (trade: TrackedTrade) => (
    <div className="row-actions">
      {!trade.isClosed && (
        <button
          type="button"
          className="icon-button"
          onClick={() => void handleRecalculateTrade(trade)}
          disabled={recalculatingTradeIds.has(trade.id)}
          aria-label={`Recalculate ${trade.symbol} recommendation`}
        >
          {recalculatingTradeIds.has(trade.id) ? "Recalc..." : "Recalc"}
        </button>
      )}
      <button type="button" className="icon-button" onClick={() => handleEdit(trade)} aria-label={`Edit ${trade.symbol}`}>
        Edit
      </button>
      {trade.isClosed ? (
        <button type="button" className="icon-button" onClick={() => void handleReopenTrade(trade)} aria-label={`Reopen ${trade.symbol}`}>
          Reopen
        </button>
      ) : (
        <button type="button" className="icon-button" onClick={() => void handleCloseTrade(trade)} aria-label={`Close ${trade.symbol}`}>
          Close
        </button>
      )}
      <button
        type="button"
        className="icon-button"
        onClick={() => void handleToggleTradePortfolioInclusion(trade)}
        aria-label={`${trade.excludeFromPortfolioTotals ? "Include" : "Exclude"} ${trade.symbol} in portfolio total P/L`}
      >
        {trade.excludeFromPortfolioTotals ? "Include Total" : "Exclude Total"}
      </button>
      <button type="button" className="icon-button danger-button" onClick={() => void handleDelete(trade)} aria-label={`Delete ${trade.symbol}`}>
        Delete
      </button>
    </div>
  );

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDirection === "asc" ? " ▲" : " ▼") : "");

  const renderTradeRow = (trade: TrackedTrade) => {
    const metrics = tradeMetrics(trade);
    const recommendationFailed = isRecommendationDataError(trade);
    const tone = isNearStopOrTarget(trade)
      ? "warning"
      : metrics.profitLoss != null && metrics.profitLoss >= 0
        ? "positive"
        : "negative";

    return (
      <tr key={trade.id} className={`trade-row ${tone}`}>
        <td>
          <strong>{trade.symbol}</strong>
          {trade.excludeFromPortfolioTotals && <small className="total-exclusion-note">Excluded from portfolio total P/L</small>}
          {trade.tags?.length ? (
            <div className="tag-list">
              {trade.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          ) : null}
        </td>
        <td>{numberFormatter.format(trade.quantity)}</td>
        <td>{formatPrice(trade.entryPrice)}</td>
        <td>{trade.stopLoss == null ? "Not set" : formatPrice(trade.stopLoss)}</td>
        <td>{trade.takeProfit == null ? "Not set" : formatPrice(trade.takeProfit)}</td>
        <td>
          <strong>{formatPrice(trade.recommendedTakeProfit)}</strong>
          <small className={recommendationFailed ? "recommendation-error" : undefined}>
            {getRecommendationExplanation(trade)}
          </small>
          {renderChartPreview(trade)}
        </td>
        <td>
          {trade.isClosed ? formatPrice(trade.exitPrice) : formatPrice(trade.currentPrice)}
          {trade.isClosed && <small>Closed {trade.exitDate || "without date"}</small>}
          {trade.priceError && <small className="field-error">{trade.priceError}</small>}
        </td>
        <td>{formatCurrency(metrics.profitLoss)}</td>
        <td>{formatPercent(metrics.profitLossPercent)}</td>
        <td>{formatCurrency(metrics.riskAmount)}</td>
        <td>{formatCurrency(metrics.rewardAmount)}</td>
        <td>{metrics.riskRewardRatio == null ? "Unavailable" : metrics.riskRewardRatio.toFixed(2)}</td>
        <td>
          <span className={`status-pill ${tone}`}>{metrics.status}</span>
        </td>
        <td>{renderTradeActions(trade)}</td>
      </tr>
    );
  };

  const renderTradeCard = (trade: TrackedTrade) => {
    const metrics = tradeMetrics(trade);
    const recommendationFailed = isRecommendationDataError(trade);
    const hasDataIssue = Boolean(trade.priceError || recommendationFailed);
    const tone = isNearStopOrTarget(trade)
      ? "warning"
      : metrics.profitLoss != null && metrics.profitLoss >= 0
        ? "positive"
        : "negative";

    return (
      <article key={trade.id} className={`trade-card ${tone}`}>
        <div className="card-heading">
          <div>
            <h3>{trade.symbol}</h3>
            <p>
              {numberFormatter.format(trade.quantity)} shares
              {trade.excludeFromPortfolioTotals ? " · Excluded from total" : ""}
            </p>
          </div>
          <span className={`status-pill ${tone}`}>{metrics.status}</span>
        </div>

        <div className="mobile-primary-grid">
          <span>
            {trade.isClosed ? "Exit" : "Current"}<strong>{formatPrice(trade.isClosed ? trade.exitPrice : trade.currentPrice)}</strong>
          </span>
          <span>
            P/L<strong>{formatCurrency(metrics.profitLoss)}</strong>
          </span>
          <span>
            P/L %<strong>{formatPercent(metrics.profitLossPercent)}</strong>
          </span>
          <span>
            Rec Sell<strong>{formatPrice(trade.recommendedTakeProfit)}</strong>
          </span>
        </div>

        {hasDataIssue && (
          <details className="mobile-error-details">
            <summary>Data issue</summary>
            {trade.priceError && <p className="field-error">{trade.priceError}</p>}
            {recommendationFailed && <p className="field-error">{getRecommendationExplanation(trade)}</p>}
          </details>
        )}

        <details className="mobile-details">
          <summary>Details</summary>
          <div className="metric-grid">
            <span>
              Entry<strong>{formatPrice(trade.entryPrice)}</strong>
            </span>
            <span>
              SL<strong>{trade.stopLoss == null ? "Not set" : formatPrice(trade.stopLoss)}</strong>
            </span>
            <span>
              TP<strong>{trade.takeProfit == null ? "Not set" : formatPrice(trade.takeProfit)}</strong>
            </span>
            <span>
              Risk<strong>{formatCurrency(metrics.riskAmount)}</strong>
            </span>
            <span>
              Reward<strong>{formatCurrency(metrics.rewardAmount)}</strong>
            </span>
            <span>
              R/R<strong>{metrics.riskRewardRatio == null ? "Unavailable" : metrics.riskRewardRatio.toFixed(2)}</strong>
            </span>
          </div>
          <div className={`recommendation-box ${recommendationFailed ? "failed" : ""}`}>
            <span>Recommended Sell</span>
            <strong>{formatPrice(trade.recommendedTakeProfit)}</strong>
            {!recommendationFailed && <p>{getRecommendationExplanation(trade)}</p>}
            {renderChartPreview(trade)}
          </div>
          {trade.notes && <p className="notes-text">{trade.notes}</p>}
          {renderTradeActions(trade)}
        </details>
      </article>
    );
  };

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError("");

    try {
      if (authMode === "signup") {
        await signUpWithEmail(authEmail, authPassword);
      } else {
        await signInWithEmail(authEmail, authPassword);
      }
      setAuthPassword("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed.");
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError("");
    try {
      await signInWithGoogle();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Google sign-in failed.");
    }
  };

  if (!isFirebaseConfigured) {
    return (
      <main className="page-shell auth-page">
        <section className="auth-shell panel">
          <div>
            <p className="eyebrow">Firebase Setup Required</p>
            <h1>Add your Firebase Web App config to start the tracker.</h1>
            <p className="lede">
              Create a Firebase project, enable Auth and Firestore, then copy the web app values into `.env`.
            </p>
          </div>
          <div className="setup-list">
            <span>Missing environment values</span>
            {missingFirebaseConfigKeys.map((key) => (
              <code key={key}>{key}</code>
            ))}
          </div>
        </section>
      </main>
    );
  }

  if (isAuthLoading) {
    return (
      <main className="page-shell">
        <section className="auth-shell panel">
          <p className="eyebrow">Swing Trading Tracker</p>
          <h1>Loading your secure tracker...</h1>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="page-shell auth-page">
        <section className="auth-shell panel">
          <div>
            <p className="eyebrow">Swing Trading Tracker</p>
            <h1>Sign in to access your trades from any device.</h1>
            <p className="lede">
              Your trades are saved in Firestore under your Firebase account. This tool is for tracking and educational
              purposes only and is not financial advice.
            </p>
          </div>

          <form className="auth-form" onSubmit={handleAuthSubmit}>
            <label>
              <span>Email</span>
              <input
                type="email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
                placeholder="you@example.com"
                required
              />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                placeholder="At least 6 characters"
                required
              />
            </label>
            <button type="submit" className="primary-button">
              {authMode === "signup" ? "Create Account" : "Sign In"}
            </button>
            <button type="button" className="secondary-button" onClick={handleGoogleSignIn}>
              Continue With Google
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setAuthMode((current) => (current === "signin" ? "signup" : "signin"))}
            >
              {authMode === "signin" ? "Create a new account" : "Use an existing account"}
            </button>
            {authError && <p className="error-text">{authError}</p>}
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <section className="top-band">
        <div>
          <p className="eyebrow">Swing Trading Tracker</p>
          <h1>Track long swing trades with live prices and risk math.</h1>
          <p className="lede">
            This tool is for tracking and educational purposes only and is not financial advice.
          </p>
          <div className="account-bar">
            <span>{user.email ?? "Signed in"}</span>
            <button type="button" className="secondary-button" onClick={() => void signOutCurrentUser()}>
              Sign Out
            </button>
          </div>
        </div>
        <div className="summary-grid">
          <article className={`summary-card ${portfolio.unrealized >= 0 ? "positive" : "negative"}`}>
            <span>Total unrealized P/L</span>
            <strong>{formatCurrency(portfolio.unrealized)}</strong>
            <small>{formatPercent(portfolio.unrealizedPercent)}</small>
          </article>
          <article className={`summary-card ${portfolio.realized >= 0 ? "positive" : "negative"}`}>
            <span>Total realized P/L</span>
            <strong>{formatCurrency(portfolio.realized)}</strong>
            <small>{formatPercent(portfolio.realizedPercent)}</small>
          </article>
          <article className="summary-card">
            <span>Tracked trades</span>
            <strong>{isLoadingTrades ? "..." : numberFormatter.format(visibleTradeCount)}</strong>
            <small>
              {portfolio.openCount} open / {portfolio.closedCount} closed included.{" "}
              {excludedFromPortfolioTotalCount} excluded from total P/L. {statusMessage}
            </small>
          </article>
        </div>
      </section>
      {(globalError || deleteResult) && (
        <section className="top-message-panel" aria-live="polite">
          {globalError && <p className="error-text">{globalError}</p>}
          {deleteResult && <p className="meta-text">{deleteResult}</p>}
        </section>
      )}

      <section className="workspace-grid">
        <form className="trade-form panel" onSubmit={handleSubmit}>
          <div className="section-heading">
            <h2>{form.id ? "Edit Trade" : "Add Trade"}</h2>
          </div>
          <div className="form-grid">
            <label>
              <span>Dashboard section</span>
              <select value={form.category} onChange={handleFormChange("category")}>
                {TRADE_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Ticker / symbol</span>
              <input value={form.symbol} onChange={handleFormChange("symbol")} placeholder="AAPL" />
              {formErrors.symbol && <small className="field-error">{formErrors.symbol}</small>}
            </label>
            <label>
              <span>Quantity</span>
              <input type="number" min="0" step="1" value={form.quantity} onChange={handleFormChange("quantity")} placeholder="100" />
              {formErrors.quantity && <small className="field-error">{formErrors.quantity}</small>}
            </label>
            <label>
              <span>Entry price</span>
              <input type="number" min="0" step="0.01" value={form.entryPrice} onChange={handleFormChange("entryPrice")} placeholder="125.00" />
              {formErrors.entryPrice && <small className="field-error">{formErrors.entryPrice}</small>}
            </label>
            <label>
              <span>Stop loss optional</span>
              <input type="number" min="0" step="0.01" value={form.stopLoss} onChange={handleFormChange("stopLoss")} placeholder="Optional" />
              {formErrors.stopLoss && <small className="field-error">{formErrors.stopLoss}</small>}
            </label>
            <label>
              <span>Take profit optional</span>
              <input type="number" min="0" step="0.01" value={form.takeProfit} onChange={handleFormChange("takeProfit")} placeholder="Leave blank for recommendation" />
              {formErrors.takeProfit && <small className="field-error">{formErrors.takeProfit}</small>}
            </label>
            <label>
              <span>Entry date</span>
              <input type="date" value={form.entryDate} onChange={handleFormChange("entryDate")} />
            </label>
          </div>
          <label className="wide-field">
            <span>Tags</span>
            <input value={form.tags} onChange={handleFormChange("tags")} placeholder="breakout, pullback, high risk" />
          </label>
          <label className="wide-field">
            <span>Notes</span>
            <textarea value={form.notes} onChange={handleFormChange("notes")} rows={3} placeholder="Setup, catalyst, invalidation, earnings notes..." />
          </label>
          <label className="checkbox-field wide-field">
            <input
              type="checkbox"
              checked={form.excludeFromPortfolioTotals}
              onChange={handleFormCheckedChange("excludeFromPortfolioTotals")}
            />
            <span>Exclude this stock from portfolio total P/L</span>
          </label>
          <div className="form-actions">
            <button type="submit" className="primary-button">{form.id ? "Save Changes" : "Add Trade"}</button>
            {form.id && <button type="button" className="secondary-button" onClick={handleCancelEdit}>Cancel</button>}
          </div>
        </form>

        <section className="panel control-panel">
          <div className="section-heading">
            <h2>Controls</h2>
          </div>
          <label>
            <span>Market data source</span>
            <select value={provider} onChange={(event) => setProvider(event.target.value as MarketDataProviderId)}>
              <option value="yahoo">Yahoo-compatible browser endpoint</option>
            </select>
          </label>
          <p className="meta-text">
            Prices are fetched through the market-data Worker when configured, with browser fallbacks for local static builds. Prices are never mocked.
          </p>
          <button type="button" className="primary-button full-width" onClick={() => void refreshPrices()} disabled={isRefreshing}>
            {isRefreshing ? "Refreshing..." : "Refresh Prices"}
          </button>
          <button
            type="button"
            className="secondary-button full-width"
            onClick={() => void recalculateSellRecommendations()}
            disabled={isRecalculatingRecommendations || activeTrades.length === 0}
          >
            {isRecalculatingRecommendations
              ? `Recalculating ${recommendationProgress?.current ?? 0}/${recommendationProgress?.total ?? activeTrades.length}...`
              : `Recalculate ${activeCategory} Recommendations`}
          </button>
          <div className="utility-actions">
            <button type="button" className="secondary-button" onClick={exportCsv} disabled={visibleTradeCount === 0}>Export CSV</button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setImportCategory(activeCategory);
                setIsImportChooserOpen((current) => !current);
              }}
            >
              Import CSV
            </button>
            <input
              ref={fileInputRef}
              className="hidden-input"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void importCsv(file, importCategory).catch((error) => {
                    setGlobalError(error instanceof Error ? error.message : "Failed to import CSV.");
                  });
                }
                event.target.value = "";
              }}
            />
          </div>
          {isImportChooserOpen && (
            <div className="import-panel">
              <label>
                <span>Import into sheet</span>
                <select value={importCategory} onChange={(event) => setImportCategory(event.target.value as TradeCategory)}>
                  {TRADE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="primary-button full-width" onClick={() => fileInputRef.current?.click()}>
                Choose CSV
              </button>
            </div>
          )}
          {globalError && <p className="error-text">{globalError}</p>}
        </section>
      </section>

      <section className="panel dashboard-panel">
        <div className="results-toolbar">
          <div>
            <h2>Dashboard</h2>
            <p className="meta-text">Auto-refresh runs every 60 seconds while this page is open.</p>
          </div>
          <div className="sort-controls">
            <span>Sort</span>
            <button type="button" onClick={() => handleSort("symbol")}>Symbol{sortArrow("symbol")}</button>
            <button type="button" onClick={() => handleSort("profitLoss")}>P/L{sortArrow("profitLoss")}</button>
            <button type="button" onClick={() => handleSort("riskReward")}>R/R{sortArrow("riskReward")}</button>
            <button type="button" onClick={() => handleSort("status")}>Status{sortArrow("status")}</button>
          </div>
        </div>

        <div className="sheet-tabs" role="tablist" aria-label="Dashboard sheets">
          {TRADE_CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              role="tab"
              aria-selected={activeCategory === category}
              className={activeCategory === category ? "active" : ""}
              onClick={() => setActiveCategory(category)}
            >
              <span>{category}</span>
              <strong>{numberFormatter.format(tradesByCategory[category].length)}</strong>
              <small>
                {formatCurrency(categorySummaries[category].totalProfitLoss)} /{" "}
                {formatPercent(categorySummaries[category].totalProfitLossPercent)}
                {excludedPortfolioCategorySet.has(category) ? " · excluded" : ""}
              </small>
            </button>
          ))}
        </div>

        <section className="dashboard-sheet">
          <div className="dashboard-section-header">
            <div>
              <h3>{activeCategory}</h3>
              <span>
                {numberFormatter.format(activeTrades.length)} trades, {activeSummary.openCount} open,{" "}
                {activeSummary.closedCount} closed
              </span>
              <button
                type="button"
                className={`secondary-button section-total-toggle ${
                  excludedPortfolioCategorySet.has(activeCategory) ? "active" : ""
                }`}
                onClick={() => void handleToggleCategoryPortfolioInclusion(activeCategory)}
              >
                {excludedPortfolioCategorySet.has(activeCategory)
                  ? "Include in total"
                  : "Exclude from total"}
              </button>
            </div>
            <div className={`sheet-pl ${activeSummary.unrealized >= 0 ? "positive" : "negative"}`}>
              <span>Open P/L</span>
              <strong>{formatCurrency(activeSummary.unrealized)}</strong>
              <small>{formatPercent(activeSummary.unrealizedPercent)}</small>
            </div>
            <div className={`sheet-pl ${activeSummary.realized >= 0 ? "positive" : "negative"}`}>
              <span>Realized P/L</span>
              <strong>{formatCurrency(activeSummary.realized)}</strong>
              <small>{formatPercent(activeSummary.realizedPercent)}</small>
            </div>
          </div>

          <div className="table-scroll desktop-table">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Qty</th>
                  <th>Entry</th>
                  <th>SL</th>
                  <th>TP</th>
                  <th>Recommended Sell</th>
                  <th>Current</th>
                  <th>P/L $</th>
                  <th>P/L %</th>
                  <th>Risk $</th>
                  <th>Reward $</th>
                  <th>R/R</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {activeTrades.length === 0 && (
                  <tr>
                    <td colSpan={14} className="empty-state">
                      No trades in this sheet yet.
                    </td>
                  </tr>
                )}
                {activeTrades.map(renderTradeRow)}
              </tbody>
            </table>
          </div>

          <div className="mobile-cards">
            {activeTrades.length === 0 ? (
              <p className="empty-state">No trades in this sheet yet.</p>
            ) : (
              activeTrades.map(renderTradeCard)
            )}
          </div>
        </section>
      </section>
      <footer className="app-version-footer" aria-label="Application version">
        <span>Version {buildInfo.version}</span>
        <span>Git build {buildInfo.builds.git}</span>
        <span>Firestore build {buildInfo.builds.firestore}</span>
        <span>Cloudflare build {buildInfo.builds.cloudflare}</span>
        <span>Ext build {buildInfo.builds.ext}</span>
        <span>UID {user.uid.slice(0, 8)}</span>
        {lastServerSync && <span>Server sync {lastServerSync}</span>}
        <button
          type="button"
          className="footer-debug-button"
          onClick={() =>
            void syncServerState()
              .then(() => setStatusMessage("Loaded latest server state."))
              .catch((error) => {
                setGlobalError(error instanceof Error ? error.message : "Failed to load latest server state.");
              })
          }
        >
          Sync from server
        </button>
        <button type="button" className="footer-debug-button" onClick={() => void handlePersistenceCheck()}>
          Check server data
        </button>
      </footer>
      {persistenceDiagnostics && (
        <pre className="persistence-diagnostics" aria-label="Firestore server diagnostics">
          {persistenceDiagnostics}
        </pre>
      )}
    </main>
  );
}
