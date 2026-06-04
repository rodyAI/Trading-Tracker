import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketCandle, MarketDataProviderId } from "@shared/types";
import { buildInfo } from "./buildInfo";
import {
  completeGoogleRedirectSignIn,
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
  deleteAllUserTradeData,
  deleteUserTrade,
  importUserTrades,
  loadTradePersistenceDiagnostics,
  loadUserTradesFromServer,
  saveUserTrade,
} from "./services/firebaseTradeStore";
import {
  defaultCategoryLabels,
  deletePortfolioSettingsData,
  loadPortfolioSettingsFromServer,
  savePortfolioSettings,
  type CategoryLabels,
} from "./services/firebasePortfolioSettings";
import { loadTradeCandles, refreshTradeQuotes } from "./services/marketDataService";
import {
  TRADE_CATEGORIES,
  RiskManagementFormValues,
  RiskManagementResult,
  SellAllocationMethod,
  TradeEntryLot,
  TradeExitLot,
  TradeCategory,
  TradeFormValues,
  TrackedTrade,
  calculateTradePosition,
  calculateRiskManagementPlan,
  calculateRewardAmount,
  calculateRiskAmount,
  calculateRiskRewardRatio,
  getTradeEntryLots,
  getTradeExitLots,
  getTradeStatus,
  isNearStopOrTarget,
  parseTakeProfitLevels,
  recommendTakeProfit,
  validateTradeForm,
} from "./utils/tradeCalculations";

type SortKey = "symbol" | "profitLoss" | "riskReward" | "status";
type SortDirection = "asc" | "desc";
type PositionModalMode = "add-entry" | "sell-shares";
interface PositionModalState {
  mode: PositionModalMode;
  trade: TrackedTrade;
  quantity: string;
  price: string;
  stopLoss: string;
  takeProfit: string;
  allocationMethod: SellAllocationMethod;
  selectedEntryId: string;
  error: string;
}

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

const emptyRiskManagementForm: RiskManagementFormValues = {
  direction: "long",
  portfolioValue: "",
  desiredRiskAmount: "",
  entryPrice: "",
  targetPrice: "",
  stopLossPrice: "",
};

const normalizeCategoryLabels = (labels: CategoryLabels): CategoryLabels =>
  Object.keys(labels).reduce(
    (nextLabels, category) => ({
      ...nextLabels,
      [category]: labels[category]?.trim() || category,
    }),
    {} as CategoryLabels,
  );

const normalizeCategoryName = (value: string) => value.trim().replace(/\s+/g, " ");

const uniqueCategories = (categories: string[]) => {
  const seen = new Set<string>();
  return categories
    .map(normalizeCategoryName)
    .filter((category) => {
      if (!category || seen.has(category)) return false;
      seen.add(category);
      return true;
    });
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
const unavailableLabel = "More data needed";

const formatCurrency = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? unavailableLabel : currencyFormatter.format(value);

const formatPrice = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? unavailableLabel : priceFormatter.format(value);

const formatPercent = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? unavailableLabel : `${percentFormatter.format(value)}%`;

const formatTakeProfitDisplay = (trade: TrackedTrade) => {
  const levels = trade.takeProfitLevels?.filter((level) => Number.isFinite(level)) ?? [];
  if (levels.length > 0) return levels.map(formatPrice).join(", ");
  return trade.takeProfit == null ? "Not set" : formatPrice(trade.takeProfit);
};

const formatLotSummary = (lots: Array<TradeEntryLot | TradeExitLot>) =>
  lots.length === 0
    ? "None"
    : lots
        .map((lot) => {
          const entryDetails =
            "stopLoss" in lot
              ? [
                  lot.stopLoss != null ? `SL ${formatPrice(lot.stopLoss)}` : "",
                  lot.takeProfitLevels?.length ? `TP ${lot.takeProfitLevels.map(formatPrice).join("/")}` : "",
                ]
                  .filter(Boolean)
                  .join(", ")
              : "";
          return `${numberFormatter.format(lot.quantity)} @ ${formatPrice(lot.price)}${entryDetails ? ` (${entryDetails})` : ""}`;
        })
        .join(" · ");

const getAuthErrorMessage = (error: unknown) => {
  const code = typeof error === "object" && error != null && "code" in error ? String(error.code) : "";
  if (code === "auth/operation-not-allowed") {
    return "Google sign-in is not enabled for this Firebase project. Enable Google in Firebase Authentication.";
  }
  if (code === "auth/unauthorized-domain") {
    return "This domain is not authorized for Google sign-in. Add this site domain in Firebase Authentication settings.";
  }
  if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
    return "Google sign-in could not open in this browser. Try again, or use email and password.";
  }
  if (code === "auth/network-request-failed") {
    return "Google sign-in could not reach Firebase. Check your connection and try again.";
  }
  return error instanceof Error ? error.message : "Google sign-in failed.";
};

const createId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const numbersDiffer = (left: number | null | undefined, right: number | null | undefined, tolerance = 0.0001) => {
  if (left == null || right == null) return left !== right;
  return Math.abs(left - right) > tolerance;
};

const tradeMetrics = (trade: TrackedTrade) => {
  const position = calculateTradePosition(trade);
  const unrealizedProfitLoss =
    trade.currentPrice == null || position.openQuantity <= 0
      ? 0
      : trade.currentPrice * position.openQuantity - position.openCostBasis;
  const totalCostBasis = position.openCostBasis + position.soldCostBasis;
  const profitLoss = position.realizedProfitLoss + unrealizedProfitLoss;
  const profitLossPercent = totalCostBasis > 0 ? (profitLoss / totalCostBasis) * 100 : null;
  const averageOpenEntry = position.averageOpenEntryPrice ?? position.averageEntryPrice ?? trade.entryPrice;
  const lotRiskAmount = position.openEntryLots.reduce((sum, lot) => {
    const stopLoss = lot.stopLoss ?? trade.stopLoss;
    if (stopLoss == null || stopLoss >= lot.price) return sum;
    return sum + (lot.price - stopLoss) * lot.remainingQuantity;
  }, 0);
  const lotRewardAmount = position.openEntryLots.reduce((sum, lot) => {
    const takeProfit = lot.takeProfitLevels?.[0] ?? trade.takeProfit;
    if (takeProfit == null || takeProfit <= lot.price) return sum;
    return sum + (takeProfit - lot.price) * lot.remainingQuantity;
  }, 0);
  const riskAmount = lotRiskAmount > 0 ? lotRiskAmount : calculateRiskAmount(averageOpenEntry, trade.stopLoss, position.openQuantity);
  const rewardAmount = lotRewardAmount > 0 ? lotRewardAmount : calculateRewardAmount(averageOpenEntry, trade.takeProfit, position.openQuantity);
  const riskRewardRatio = calculateRiskRewardRatio(riskAmount, rewardAmount);
  const status = position.openQuantity <= 0 ? "Closed" : getTradeStatus({ ...trade, entryPrice: averageOpenEntry, isClosed: false });

  return {
    profitLoss,
    profitLossPercent,
    realizedProfitLoss: position.realizedProfitLoss,
    unrealizedProfitLoss,
    riskAmount,
    rewardAmount,
    riskRewardRatio,
    status,
    position,
  };
};

const summarizeTrades = (items: TrackedTrade[]) => {
  const positions = items.map(calculateTradePosition);
  const openTrades = positions.filter((position) => position.openQuantity > 0);
  const closedTrades = positions.filter((position) => position.openQuantity <= 0 && position.totalEntryQuantity > 0);
  const invested = positions.reduce((sum, position) => sum + position.openCostBasis, 0);
  const unrealized = items.reduce((sum, trade) => {
    const position = calculateTradePosition(trade);
    if (position.openQuantity <= 0 || trade.currentPrice == null) return sum;
    return sum + trade.currentPrice * position.openQuantity - position.openCostBasis;
  }, 0);
  const realizedBasis = positions.reduce((sum, position) => sum + position.soldCostBasis, 0);
  const realized = positions.reduce((sum, position) => sum + position.realizedProfitLoss, 0);
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

const clearLocalAppStorage = (user: User | null) => {
  if (typeof window === "undefined") return;
  if (user) window.localStorage.removeItem(portfolioSettingsStorageKey(user));
  window.localStorage.removeItem(PROVIDER_STORAGE_KEY);
  Object.keys(window.localStorage)
    .filter((key) => key.startsWith(PORTFOLIO_SETTINGS_STORAGE_PREFIX))
    .forEach((key) => window.localStorage.removeItem(key));
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
  const [riskForm, setRiskForm] = useState<RiskManagementFormValues>(emptyRiskManagementForm);
  const [riskErrors, setRiskErrors] = useState<Partial<Record<keyof RiskManagementFormValues, string>>>({});
  const [riskResult, setRiskResult] = useState<RiskManagementResult | null>(null);
  const [positionModal, setPositionModal] = useState<PositionModalState | null>(null);
  const [expandedTradeIds, setExpandedTradeIds] = useState<Set<string>>(() => new Set());
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
  const [hiddenClosedTradeCategories, setHiddenClosedTradeCategories] = useState<TradeCategory[]>([]);
  const [enabledTradeCategories, setEnabledTradeCategories] = useState<TradeCategory[]>(() => [...TRADE_CATEGORIES]);
  const [availableTradeCategories, setAvailableTradeCategories] = useState<TradeCategory[]>(() => [...TRADE_CATEGORIES]);
  const [sectionSelectionDraft, setSectionSelectionDraft] = useState<TradeCategory[]>(() => [...TRADE_CATEGORIES]);
  const [categoryLabels, setCategoryLabels] = useState<CategoryLabels>(() => defaultCategoryLabels);
  const [categoryLabelDraft, setCategoryLabelDraft] = useState<CategoryLabels>(() => defaultCategoryLabels);
  const [customSectionName, setCustomSectionName] = useState("");
  const [customSectionError, setCustomSectionError] = useState("");
  const [isSectionChooserOpen, setIsSectionChooserOpen] = useState(false);
  const [isSavingSections, setIsSavingSections] = useState(false);
  const [isImportChooserOpen, setIsImportChooserOpen] = useState(false);
  const [isSideMenuOpen, setIsSideMenuOpen] = useState(false);
  const [isTradeFormOpen, setIsTradeFormOpen] = useState(false);
  const [isRiskCalculatorOpen, setIsRiskCalculatorOpen] = useState(false);
  const [isTradeOptionalDetailsOpen, setIsTradeOptionalDetailsOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Ready. Add a trade or refresh prices.");
  const [globalError, setGlobalError] = useState("");
  const [persistenceDiagnostics, setPersistenceDiagnostics] = useState("");
  const [deleteResult, setDeleteResult] = useState("");
  const [lastServerSync, setLastServerSync] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRecalculatingRecommendations, setIsRecalculatingRecommendations] = useState(false);
  const [isDeletingAccountData, setIsDeletingAccountData] = useState(false);
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
    setHiddenClosedTradeCategories(serverSettings.hiddenClosedTradeCategories);
    setEnabledTradeCategories(serverSettings.enabledCategories);
    setAvailableTradeCategories(serverSettings.availableCategories);
    setSectionSelectionDraft(serverSettings.enabledCategories);
    setCategoryLabels(serverSettings.categoryLabels);
    setCategoryLabelDraft(serverSettings.categoryLabels);
    if (!serverSettings.exists) {
      setIsSectionChooserOpen(true);
    }
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
    if (!isFirebaseConfigured) return;
    void completeGoogleRedirectSignIn()
      .then(() => setAuthError(""))
      .catch((error) => setAuthError(getAuthErrorMessage(error)));
  }, []);

  useEffect(() => {
    if (!user) {
      setTrades([]);
      setExcludedPortfolioCategories([]);
      setHiddenClosedTradeCategories([]);
      setEnabledTradeCategories([...TRADE_CATEGORIES]);
      setAvailableTradeCategories([...TRADE_CATEGORIES]);
      setSectionSelectionDraft([...TRADE_CATEGORIES]);
      setCategoryLabels(defaultCategoryLabels);
      setCategoryLabelDraft(defaultCategoryLabels);
      setCustomSectionName("");
      setCustomSectionError("");
      setIsSectionChooserOpen(false);
      setIsSideMenuOpen(false);
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

  useEffect(() => {
    if ((!isSideMenuOpen && !positionModal) || typeof window === "undefined") return undefined;

    const scrollY = window.scrollY;
    const originalStyles = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
    };

    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";

    return () => {
      document.body.style.overflow = originalStyles.overflow;
      document.body.style.position = originalStyles.position;
      document.body.style.top = originalStyles.top;
      document.body.style.width = originalStyles.width;
      window.scrollTo(0, scrollY);
    };
  }, [isSideMenuOpen, Boolean(positionModal)]);

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

    const tabTrades = trades.filter(
      (trade) =>
        isVisibleTrade(trade) &&
        (trade.category ?? "Swing") === activeCategory &&
        calculateTradePosition(trade).openQuantity > 0,
    );
    const activeCategoryLabel = categoryLabels[activeCategory]?.trim() || activeCategory;

    if (tabTrades.length === 0) {
      setStatusMessage(`No trades to update in ${activeCategoryLabel}.`);
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
          `Updating ${activeCategoryLabel} sell targets ${index + 1}/${tabTrades.length}: ${trade.symbol}`,
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
        `Updated ${updatedRecommendations.length} ${activeCategoryLabel} sell target${
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
  }, [activeCategory, categoryLabels, enrichTradeRecommendation, trades, user]);

  const handleRecalculateTrade = async (trade: TrackedTrade) => {
    if (calculateTradePosition(trade).openQuantity <= 0 || recalculatingTradeIds.has(trade.id)) return;

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

  const openPositionModal = (mode: PositionModalMode, trade: TrackedTrade) => {
    if (!user) {
      setStatusMessage("Sign in before changing positions.");
      return;
    }

    const position = calculateTradePosition(trade);
    const defaultPrice = mode === "sell-shares" ? getDefaultExitPrice(trade) : trade.currentPrice ?? trade.entryPrice;
    setPositionModal({
      mode,
      trade,
      quantity: mode === "sell-shares" ? String(roundDisplayQuantity(position.openQuantity)) : "",
      price: priceFormatter.format(defaultPrice).replace(/,/g, ""),
      stopLoss: mode === "add-entry" && trade.stopLoss != null ? String(trade.stopLoss) : "",
      takeProfit: mode === "add-entry" && trade.takeProfitLevels?.length
        ? trade.takeProfitLevels.join(", ")
        : mode === "add-entry" && trade.takeProfit != null
          ? String(trade.takeProfit)
          : "",
      allocationMethod: "oldest",
      selectedEntryId: position.openEntryLots[0]?.id ?? "",
      error: "",
    });
  };

  const roundDisplayQuantity = (value: number) => {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 10000) / 10000;
  };

  const handleSubmitPositionModal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user || !positionModal) return;

    const quantity = parseExitPrice(positionModal.quantity);
    const price = parseExitPrice(positionModal.price);
    if (quantity == null || price == null) {
      setPositionModal((current) => current ? { ...current, error: "Quantity and price must be greater than 0." } : current);
      return;
    }
    const lotStopLoss = positionModal.mode === "add-entry" && positionModal.stopLoss.trim()
      ? parseExitPrice(positionModal.stopLoss)
      : null;
    const lotTakeProfitLevels = positionModal.mode === "add-entry"
      ? parseTakeProfitLevels(positionModal.takeProfit).filter((level): level is number => level != null && level > 0)
      : [];
    const rawLotTakeProfitLevels = positionModal.mode === "add-entry" ? parseTakeProfitLevels(positionModal.takeProfit) : [];
    if (positionModal.mode === "add-entry" && positionModal.stopLoss.trim() && lotStopLoss == null) {
      setPositionModal((current) => current ? { ...current, error: "Stop loss must be greater than 0 when provided." } : current);
      return;
    }
    if (positionModal.mode === "add-entry" && rawLotTakeProfitLevels.some((level) => level == null || level <= 0)) {
      setPositionModal((current) => current ? { ...current, error: "Take profit levels must be greater than 0." } : current);
      return;
    }
    if (positionModal.mode === "add-entry" && lotStopLoss != null && lotStopLoss >= price) {
      setPositionModal((current) => current ? { ...current, error: "Stop loss must be below entry for a long position." } : current);
      return;
    }
    if (positionModal.mode === "add-entry" && lotTakeProfitLevels.some((level) => level <= price)) {
      setPositionModal((current) => current ? { ...current, error: "Take profit levels must be above entry for a long position." } : current);
      return;
    }

    const trade = positionModal.trade;
    const entries = getTradeEntryLots(trade);
    const exitLots = getTradeExitLots(trade);
    const currentPosition = calculateTradePosition({ ...trade, entries, exitLots });
    let updatedTrade: TrackedTrade;

    if (positionModal.mode === "add-entry") {
      const nextEntries = [
        ...entries,
        {
          id: createId(),
          quantity,
          price,
          stopLoss: lotStopLoss,
          takeProfitLevels: lotTakeProfitLevels,
          date: todayIsoDate(),
        },
      ];
      const nextPosition = calculateTradePosition({ ...trade, entries: nextEntries, exitLots });
      updatedTrade = {
        ...trade,
        entries: nextEntries,
        exitLots,
        quantity: nextPosition.totalEntryQuantity,
        entryPrice: nextPosition.averageOpenEntryPrice ?? nextPosition.averageEntryPrice ?? price,
        isClosed: false,
        exitPrice: null,
        exitDate: "",
      };
    } else {
      if (quantity > currentPosition.openQuantity) {
        setPositionModal((current) =>
          current
            ? {
                ...current,
                error: `You can sell up to ${numberFormatter.format(roundDisplayQuantity(currentPosition.openQuantity))} open shares.`,
              }
            : current,
        );
        return;
      }
      if (positionModal.allocationMethod === "manual") {
        const selectedEntry = currentPosition.openEntryLots.find((entry) => entry.id === positionModal.selectedEntryId);
        if (!selectedEntry) {
          setPositionModal((current) => current ? { ...current, error: "Choose a buy lot to sell from." } : current);
          return;
        }
        if (quantity > selectedEntry.remainingQuantity) {
          setPositionModal((current) =>
            current
              ? {
                  ...current,
                  error: `Selected lot has ${numberFormatter.format(roundDisplayQuantity(selectedEntry.remainingQuantity))} open shares.`,
                }
              : current,
          );
          return;
        }
      }

      const nextExitLots = [
        ...exitLots,
        {
          id: createId(),
          quantity,
          price,
          allocationMethod: positionModal.allocationMethod,
          allocations: positionModal.allocationMethod === "manual"
            ? [{ entryId: positionModal.selectedEntryId, quantity }]
            : [],
          date: todayIsoDate(),
        },
      ];
      const nextPosition = calculateTradePosition({ ...trade, entries, exitLots: nextExitLots });
      const fullyClosed = nextPosition.openQuantity <= 0.000001;
      updatedTrade = {
        ...trade,
        entries,
        exitLots: nextExitLots,
        quantity: nextPosition.totalEntryQuantity,
        entryPrice: nextPosition.averageOpenEntryPrice ?? nextPosition.averageEntryPrice ?? trade.entryPrice,
        isClosed: fullyClosed,
        exitPrice: price,
        exitDate: todayIsoDate(),
        currentPrice: fullyClosed ? null : trade.currentPrice,
        currentPriceAsOf: fullyClosed ? null : trade.currentPriceAsOf,
        currentPriceProvider: fullyClosed ? null : trade.currentPriceProvider,
        priceError: fullyClosed ? null : trade.priceError,
      };
    }

    try {
      await saveUserTrade(user, updatedTrade);
      setTrades((currentTrades) => currentTrades.map((currentTrade) => (currentTrade.id === trade.id ? updatedTrade : currentTrade)));
      setPositionModal(null);
      setStatusMessage(
        positionModal.mode === "add-entry"
          ? `${trade.symbol} entry lot added.`
          : `${trade.symbol} sale recorded at ${formatPrice(price)}.`,
      );
    } catch (error) {
      setPositionModal((current) =>
        current ? { ...current, error: error instanceof Error ? error.message : "Failed to save position change." } : current,
      );
    }
  };

  const handleReopenTrade = async (trade: TrackedTrade) => {
    if (!user) {
      setStatusMessage("Sign in before reopening trades.");
      return;
    }

    const entries = getTradeEntryLots(trade);
    const reopenedPosition = calculateTradePosition({ ...trade, entries, exitLots: [] });
    const reopenedTrade: TrackedTrade = {
      ...trade,
      entries,
      exitLots: [],
      quantity: reopenedPosition.totalEntryQuantity,
      entryPrice: reopenedPosition.averageOpenEntryPrice ?? reopenedPosition.averageEntryPrice ?? trade.entryPrice,
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
      const savedSettings = await savePortfolioSettings(user, {
        excludedCategories: nextCategories,
        hiddenClosedTradeCategories,
        enabledCategories: enabledTradeCategories,
        availableCategories: availableTradeCategories,
        categoryLabels,
      });
      setExcludedPortfolioCategories(savedSettings.excludedCategories);
      setHiddenClosedTradeCategories(savedSettings.hiddenClosedTradeCategories);
      setEnabledTradeCategories(savedSettings.enabledCategories);
      setAvailableTradeCategories(savedSettings.availableCategories);
      setSectionSelectionDraft(savedSettings.enabledCategories);
      setCategoryLabels(savedSettings.categoryLabels);
      setCategoryLabelDraft(savedSettings.categoryLabels);
      cacheExcludedCategories(user, savedSettings.excludedCategories);
      setStatusMessage(`${getCategoryLabel(category)} ${nextCategories.includes(category) ? "excluded from" : "included in"} portfolio total P/L.`);
    } catch (error) {
      setExcludedPortfolioCategories(excludedPortfolioCategories);
      cacheExcludedCategories(user, excludedPortfolioCategories);
      setGlobalError(error instanceof Error ? error.message : `Failed to update ${category} total P/L setting.`);
    }
  };

  const handleToggleClosedTradesVisibility = async (category: TradeCategory) => {
    if (!user) {
      setStatusMessage("Sign in before changing closed trade visibility.");
      return;
    }

    const nextCategories = hiddenClosedTradeCategories.includes(category)
      ? hiddenClosedTradeCategories.filter((item) => item !== category)
      : [...hiddenClosedTradeCategories, category];

    setHiddenClosedTradeCategories(nextCategories);
    try {
      const savedSettings = await savePortfolioSettings(user, {
        excludedCategories: excludedPortfolioCategories,
        hiddenClosedTradeCategories: nextCategories,
        enabledCategories: enabledTradeCategories,
        availableCategories: availableTradeCategories,
        categoryLabels,
      });
      setExcludedPortfolioCategories(savedSettings.excludedCategories);
      setHiddenClosedTradeCategories(savedSettings.hiddenClosedTradeCategories);
      setEnabledTradeCategories(savedSettings.enabledCategories);
      setAvailableTradeCategories(savedSettings.availableCategories);
      setSectionSelectionDraft(savedSettings.enabledCategories);
      setCategoryLabels(savedSettings.categoryLabels);
      setCategoryLabelDraft(savedSettings.categoryLabels);
      setStatusMessage(
        `${getCategoryLabel(category)} closed trades ${
          savedSettings.hiddenClosedTradeCategories.includes(category) ? "hidden" : "shown"
        }.`,
      );
    } catch (error) {
      setHiddenClosedTradeCategories(hiddenClosedTradeCategories);
      setGlobalError(error instanceof Error ? error.message : `Failed to update ${category} closed trade visibility.`);
    }
  };

  const toggleSectionSelectionDraft = (category: TradeCategory) => {
    setSectionSelectionDraft((current) =>
      current.includes(category) ? current.filter((item) => item !== category) : [...current, category],
    );
  };

  const handleCategoryLabelDraftChange = (category: TradeCategory, value: string) => {
    setCategoryLabelDraft((current) => ({
      ...current,
      [category]: value,
    }));
  };

  const addCustomSectionDraft = () => {
    const nextCategory = normalizeCategoryName(customSectionName);
    if (!nextCategory) {
      setCustomSectionError("Enter a section name.");
      return;
    }
    if (nextCategory.includes("/")) {
      setCustomSectionError("Section names cannot include /.");
      return;
    }
    if (sectionSelectionDraft.some((category) => category.toLowerCase() === nextCategory.toLowerCase())) {
      setCustomSectionError("That section already exists.");
      return;
    }

    setSectionSelectionDraft((current) => [...current, nextCategory]);
    setCategoryLabelDraft((current) => ({ ...current, [nextCategory]: nextCategory }));
    setCustomSectionName("");
    setCustomSectionError("");
  };

  const saveSectionSelection = async () => {
    if (!user) {
      setStatusMessage("Sign in before changing dashboard sections.");
      return;
    }

    const nextEnabledCategories = uniqueCategories(sectionSelectionDraft);
    if (nextEnabledCategories.length === 0) {
      setGlobalError("Select at least one dashboard section.");
      return;
    }

    const nextExcludedCategories = excludedPortfolioCategories.filter((category) =>
      nextEnabledCategories.includes(category),
    );
    const nextHiddenClosedTradeCategories = hiddenClosedTradeCategories.filter((category) =>
      nextEnabledCategories.includes(category),
    );
    const nextCategoryLabels = normalizeCategoryLabels(categoryLabelDraft);
    const nextAvailableCategories = uniqueCategories([
      ...availableTradeCategories,
      ...Object.keys(nextCategoryLabels),
      ...nextEnabledCategories,
    ]);

    setIsSavingSections(true);
    setGlobalError("");
    try {
      const savedSettings = await savePortfolioSettings(user, {
        excludedCategories: nextExcludedCategories,
        hiddenClosedTradeCategories: nextHiddenClosedTradeCategories,
        enabledCategories: nextEnabledCategories,
        availableCategories: nextAvailableCategories,
        categoryLabels: nextCategoryLabels,
      });
      setEnabledTradeCategories(savedSettings.enabledCategories);
      setAvailableTradeCategories(savedSettings.availableCategories);
      setSectionSelectionDraft(savedSettings.enabledCategories);
      setExcludedPortfolioCategories(savedSettings.excludedCategories);
      setHiddenClosedTradeCategories(savedSettings.hiddenClosedTradeCategories);
      setCategoryLabels(savedSettings.categoryLabels);
      setCategoryLabelDraft(savedSettings.categoryLabels);
      cacheExcludedCategories(user, savedSettings.excludedCategories);
      setActiveCategory((current) =>
        savedSettings.enabledCategories.includes(current) ? current : savedSettings.enabledCategories[0],
      );
      setForm((current) =>
        savedSettings.enabledCategories.includes(current.category)
          ? current
          : { ...current, category: savedSettings.enabledCategories[0] },
      );
      setImportCategory((current) =>
        savedSettings.enabledCategories.includes(current) ? current : savedSettings.enabledCategories[0],
      );
      setCustomSectionName("");
      setCustomSectionError("");
      setIsSectionChooserOpen(false);
      setIsSideMenuOpen(false);
      setStatusMessage("Dashboard sections and tab names saved.");
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "Failed to save dashboard sections.");
    } finally {
      setIsSavingSections(false);
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

  const handleRiskFormChange = (field: keyof RiskManagementFormValues) => (
    event: ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    setRiskForm((current) => ({ ...current, [field]: event.target.value }));
    setRiskErrors((current) => ({ ...current, [field]: undefined }));
    setRiskResult(null);
  };

  const handleRiskCalculate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const calculation = calculateRiskManagementPlan(riskForm);
    setRiskErrors(calculation.errors);
    setRiskResult(calculation.result ?? null);
    if (calculation.result) setStatusMessage("Risk management plan calculated.");
  };

  const handleRiskReset = () => {
    setRiskForm(emptyRiskManagementForm);
    setRiskErrors({});
    setRiskResult(null);
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
    const isEditingSameSymbol = Boolean(existingTrade && existingTrade.symbol === validation.values.symbol);
    const existingEntries = existingTrade ? getTradeEntryLots(existingTrade) : [];
    const existingExitLots = existingTrade ? getTradeExitLots(existingTrade) : [];
    let nextEntries = validation.values.entries;
    let nextExitLots = [] as TradeExitLot[];

    if (existingTrade && isEditingSameSymbol && existingEntries.length > 0) {
      const existingPosition = calculateTradePosition(existingTrade);
      const editableQuantity =
        existingPosition.openQuantity > 0
          ? existingPosition.openQuantity
          : existingPosition.totalEntryQuantity || existingTrade.quantity;
      const editableEntryPrice =
        existingPosition.averageOpenEntryPrice ?? existingPosition.averageEntryPrice ?? existingTrade.entryPrice;
      const aggregateLotFieldsChanged =
        numbersDiffer(validation.values.quantity, editableQuantity) ||
        numbersDiffer(validation.values.entryPrice, editableEntryPrice, 0.01);

      if (existingEntries.length === 1 && existingExitLots.length === 0) {
        const editedEntry = validation.values.entries?.[0];
        nextEntries = [
          {
            ...existingEntries[0],
            ...editedEntry,
            id: existingEntries[0].id,
            quantity: validation.values.quantity,
            price: validation.values.entryPrice,
            stopLoss: validation.values.stopLoss,
            takeProfitLevels: validation.values.takeProfitLevels ?? [],
            date: validation.values.entryDate,
          },
        ];
      } else {
        if (aggregateLotFieldsChanged) {
          setFormErrors({
            ...validation.errors,
            quantity: "This position has multiple buy lots or sales. Use Add Entry or Sell to change quantity while keeping lot history accurate.",
            entryPrice: "Average entry is calculated from the saved buy lots.",
          });
          setGlobalError("Use Add Entry or Sell to change a position that has multiple lots or sale history.");
          setStatusMessage("Trade save stopped to protect lot history.");
          return;
        }

        nextEntries = existingEntries;
        nextExitLots = existingExitLots;
      }
    }

    const baseTrade: TrackedTrade = {
      ...(existingTrade ?? {}),
      ...validation.values,
      id: form.id ?? createId(),
      category: validation.values.category,
      entries: nextEntries,
      exitLots: nextExitLots,
      priceError: existingTrade?.symbol === validation.values.symbol ? existingTrade?.priceError : null,
      currentPrice: existingTrade?.symbol === validation.values.symbol ? existingTrade?.currentPrice : null,
      currentPriceAsOf: existingTrade?.symbol === validation.values.symbol ? existingTrade?.currentPriceAsOf : null,
      currentPriceProvider: existingTrade?.symbol === validation.values.symbol ? existingTrade?.currentPriceProvider : null,
      excludeFromPortfolioTotals: validation.values.excludeFromPortfolioTotals,
    };

    try {
      setStatusMessage("Saving trade and calculating the recommended sell price...");
      const tradeWithRecommendation = await enrichTradeRecommendation(baseTrade);
      await saveUserTrade(user, tradeWithRecommendation);
      setActiveCategory(tradeWithRecommendation.category ?? "Swing");
      setForm(emptyForm);
      setIsTradeFormOpen(false);
      setIsTradeOptionalDetailsOpen(false);
      await syncServerState();
      setStatusMessage(`${tradeWithRecommendation.symbol} saved and confirmed by Firestore.`);
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "Failed to save trade to Firestore.");
      setStatusMessage("Trade save failed.");
    }
  };

  const handleEdit = (trade: TrackedTrade) => {
    const position = calculateTradePosition(trade);
    const editableEntryPrice = position.averageOpenEntryPrice ?? position.averageEntryPrice ?? trade.entryPrice;
    const editableQuantity = position.openQuantity > 0 ? position.openQuantity : position.totalEntryQuantity || trade.quantity;
    const singleOpenLot = position.openEntryLots.length === 1 ? position.openEntryLots[0] : null;
    const editableTakeProfitLevels =
      singleOpenLot?.takeProfitLevels?.length ? singleOpenLot.takeProfitLevels : trade.takeProfitLevels ?? [];
    setForm({
      id: trade.id,
      category: trade.category ?? "Swing",
      symbol: trade.symbol,
      quantity: String(roundDisplayQuantity(editableQuantity)),
      entryPrice: String(roundDisplayQuantity(editableEntryPrice)),
      stopLoss: singleOpenLot?.stopLoss == null && trade.stopLoss == null ? "" : String(singleOpenLot?.stopLoss ?? trade.stopLoss),
      takeProfit: editableTakeProfitLevels.length ? editableTakeProfitLevels.join(", ") : trade.takeProfit == null ? "" : String(trade.takeProfit),
      notes: trade.notes ?? "",
      entryDate: singleOpenLot?.date ?? trade.entryDate ?? "",
      tags: (trade.tags ?? []).join(", "),
      excludeFromPortfolioTotals: trade.excludeFromPortfolioTotals ?? false,
    });
    setFormErrors({});
    setActiveCategory(trade.category ?? "Swing");
    setIsTradeFormOpen(true);
    setIsTradeOptionalDetailsOpen(Boolean(trade.stopLoss || trade.takeProfit || trade.takeProfitLevels?.length || trade.entryDate || trade.tags?.length || trade.notes));
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

  const handleDeleteAllAccountData = async () => {
    if (!user || isDeletingAccountData) return;

    const confirmed = window.confirm(
      "Delete all trades, strategy settings, and local tracker cache for this account? This cannot be undone.",
    );
    if (!confirmed) return;

    setIsDeletingAccountData(true);
    setGlobalError("");
    setDeleteResult("");
    setStatusMessage("Deleting account data from Firestore...");

    try {
      const deletedTradeDocumentCount = await deleteAllUserTradeData(user);
      await deletePortfolioSettingsData(user);
      clearLocalAppStorage(user);
      setTrades([]);
      setExcludedPortfolioCategories([]);
      setHiddenClosedTradeCategories([]);
      setEnabledTradeCategories([...TRADE_CATEGORIES]);
      setAvailableTradeCategories([...TRADE_CATEGORIES]);
      setSectionSelectionDraft([...TRADE_CATEGORIES]);
      setCategoryLabels(defaultCategoryLabels);
      setCategoryLabelDraft(defaultCategoryLabels);
      setActiveCategory("Swing");
      setForm(emptyForm);
      setPersistenceDiagnostics("");
      setLastServerSync(new Date().toLocaleTimeString());
      setDeleteResult(`Deleted ${deletedTradeDocumentCount} trade-related Firestore document${deletedTradeDocumentCount === 1 ? "" : "s"}.`);
      setStatusMessage("Account data deleted from Firestore.");
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "Failed to delete account data.");
      setStatusMessage("Account data delete failed.");
    } finally {
      setIsDeletingAccountData(false);
    }
  };

  const handleSignOut = async () => {
    const signedInUser = user;
    try {
      await signOutCurrentUser();
      clearLocalAppStorage(signedInUser);
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "Failed to log out.");
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
      const hiddenClosedCategoryText =
        portfolioSettings.hiddenClosedTradeCategories.length === 0
          ? "none"
          : portfolioSettings.hiddenClosedTradeCategories.join(", ");
      const enabledCategoryText =
        portfolioSettings.enabledCategories.length === 0 ? "none" : portfolioSettings.enabledCategories.join(", ");
      const availableCategoryText =
        portfolioSettings.availableCategories.length === 0 ? "none" : portfolioSettings.availableCategories.join(", ");

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
          `Server hidden closed tabs: ${hiddenClosedCategoryText}`,
          `Server enabled tabs: ${enabledCategoryText}`,
          `Server available tabs: ${availableCategoryText}`,
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
    setIsTradeFormOpen(false);
    setIsTradeOptionalDetailsOpen(false);
  };

  const handleSort = (nextKey: SortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === "symbol" ? "asc" : "desc");
  };

  const toggleTradeExpansion = (tradeId: string) => {
    setExpandedTradeIds((current) => {
      const next = new Set(current);
      if (next.has(tradeId)) {
        next.delete(tradeId);
      } else {
        next.add(tradeId);
      }
      return next;
    });
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

  const allTradeCategories = useMemo(
    () =>
      uniqueCategories([
        ...TRADE_CATEGORIES,
        ...availableTradeCategories,
        ...enabledTradeCategories,
        ...sectionSelectionDraft,
        ...trades.map((trade) => trade.category ?? "Swing"),
      ]),
    [availableTradeCategories, enabledTradeCategories, sectionSelectionDraft, trades],
  );

  const tradesByCategory = useMemo(
    () =>
      allTradeCategories.reduce(
        (groups, category) => ({
          ...groups,
          [category]: sortedTrades.filter((trade) => (trade.category ?? "Swing") === category),
        }),
        {} as Record<TradeCategory, TrackedTrade[]>,
      ),
    [allTradeCategories, sortedTrades],
  );
  const visibleTradeCategories = useMemo(
    () => allTradeCategories.filter((category) => enabledTradeCategories.includes(category)),
    [allTradeCategories, enabledTradeCategories],
  );
  const visibleTradeCategorySet = useMemo(() => new Set(visibleTradeCategories), [visibleTradeCategories]);
  const hiddenClosedTradeCategorySet = useMemo(
    () => new Set(hiddenClosedTradeCategories),
    [hiddenClosedTradeCategories],
  );
  const visibleTradesByCategory = useMemo(
    () =>
      allTradeCategories.reduce(
        (groups, category) => {
          const categoryTrades = tradesByCategory[category] ?? [];
          return {
            ...groups,
            [category]: hiddenClosedTradeCategorySet.has(category)
              ? categoryTrades.filter((trade) => calculateTradePosition(trade).openQuantity > 0)
              : categoryTrades,
          };
        },
        {} as Record<TradeCategory, TrackedTrade[]>,
      ),
    [allTradeCategories, hiddenClosedTradeCategorySet, tradesByCategory],
  );
  const activeTrades = tradesByCategory[activeCategory] ?? [];
  const activeClosedTradesHidden = hiddenClosedTradeCategorySet.has(activeCategory);
  const visibleActiveTrades = visibleTradesByCategory[activeCategory] ?? [];
  const categorySummaries = useMemo(
    () =>
      allTradeCategories.reduce(
        (summaries, category) => ({
          ...summaries,
          [category]: summarizeTrades(tradesByCategory[category]),
        }),
        {} as Record<TradeCategory, ReturnType<typeof summarizeTrades>>,
      ),
    [allTradeCategories, tradesByCategory],
  );
  const activeSummary = categorySummaries[activeCategory] ?? summarizeTrades([]);
  const categoryDisplayLabels = useMemo(() => normalizeCategoryLabels(categoryLabels), [categoryLabels]);
  const getCategoryLabel = useCallback(
    (category: TradeCategory) => categoryDisplayLabels[category] || category,
    [categoryDisplayLabels],
  );
  const excludedPortfolioCategorySet = useMemo(
    () => new Set(excludedPortfolioCategories),
    [excludedPortfolioCategories],
  );
  const portfolioTotalTrades = useMemo(
    () =>
      trades.filter(
        (trade) =>
          isVisibleTrade(trade) &&
          visibleTradeCategorySet.has(trade.category ?? "Swing") &&
          shouldIncludeInPortfolioTotals(trade, excludedPortfolioCategorySet),
      ),
    [excludedPortfolioCategorySet, trades, visibleTradeCategorySet],
  );
  const visibleTradeCount = trades.filter(
    (trade) => isVisibleTrade(trade) && visibleTradeCategorySet.has(trade.category ?? "Swing"),
  ).length;
  const excludedFromPortfolioTotalCount = visibleTradeCount - portfolioTotalTrades.length;

  const portfolio = useMemo(() => {
    return summarizeTrades(portfolioTotalTrades);
  }, [portfolioTotalTrades]);

  useEffect(() => {
    const fallbackCategory = visibleTradeCategories[0] ?? "Swing";
    if (!visibleTradeCategories.includes(activeCategory)) setActiveCategory(fallbackCategory);
    if (!visibleTradeCategories.includes(form.category)) {
      setForm((current) => ({ ...current, category: fallbackCategory }));
    }
    if (!visibleTradeCategories.includes(importCategory)) setImportCategory(fallbackCategory);
  }, [activeCategory, form.category, importCategory, visibleTradeCategories]);

  const exportCsv = () => {
    const header = [
      "Symbol",
      "Category",
      "Quantity",
      "Entry Price",
      "Stop Loss",
      "Take Profit",
      "Sell Target",
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
      "Entry Lots",
      "Sale Lots",
    ];

    const rows = trades
      .filter((trade) => isVisibleTrade(trade) && visibleTradeCategorySet.has(trade.category ?? "Swing"))
      .map((trade) => {
        const metrics = tradeMetrics(trade);
        const position = metrics.position;
        const exitLots = getTradeExitLots(trade);
        const lastExit = exitLots.at(-1);
        return [
          trade.symbol,
          trade.category ?? "Swing",
          position.openQuantity,
          position.averageOpenEntryPrice ?? position.averageEntryPrice ?? trade.entryPrice,
          trade.stopLoss ?? "",
          trade.takeProfitLevels?.length ? trade.takeProfitLevels.join(", ") : trade.takeProfit ?? "",
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
          position.openQuantity <= 0 ? "yes" : "no",
          lastExit?.price ?? trade.exitPrice ?? "",
          lastExit?.date ?? trade.exitDate ?? "",
          trade.excludeFromPortfolioTotals ? "yes" : "no",
          formatLotSummary(getTradeEntryLots(trade)),
          formatLotSummary(exitLots),
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

  const renderTradeActions = (trade: TrackedTrade) => {
    const isClosed = calculateTradePosition(trade).openQuantity <= 0;

    return (
      <div className="row-actions">
        <button type="button" className="icon-button" onClick={() => openPositionModal("add-entry", trade)} aria-label={`Add entry for ${trade.symbol}`}>
          Add Entry
        </button>
        {!isClosed && (
          <button
            type="button"
            className="icon-button"
            onClick={() => void handleRecalculateTrade(trade)}
            disabled={recalculatingTradeIds.has(trade.id)}
            aria-label={`Update ${trade.symbol} sell target`}
          >
            {recalculatingTradeIds.has(trade.id) ? "Updating..." : "Update Target"}
          </button>
        )}
        <button type="button" className="icon-button" onClick={() => handleEdit(trade)} aria-label={`Edit ${trade.symbol}`}>
          Edit
        </button>
        <button type="button" className="icon-button" onClick={() => toggleTradeExpansion(trade.id)} aria-label={`Toggle lots for ${trade.symbol}`}>
          {expandedTradeIds.has(trade.id) ? "Hide Lots" : "Lots"}
        </button>
        {isClosed ? (
          <button type="button" className="icon-button" onClick={() => void handleReopenTrade(trade)} aria-label={`Reopen ${trade.symbol}`}>
            Reopen
          </button>
        ) : (
          <button type="button" className="icon-button" onClick={() => openPositionModal("sell-shares", trade)} aria-label={`Sell shares of ${trade.symbol}`}>
            Sell
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
  };

  const renderLotDetails = (trade: TrackedTrade) => {
    const entries = getTradeEntryLots(trade);
    const exits = getTradeExitLots(trade);
    const position = calculateTradePosition(trade);

    return (
      <div className="lot-details">
        <div>
          <h4>Buy Lots</h4>
          <div className="lot-table">
            <span>Lot</span>
            <span>Open Qty</span>
            <span>Total Qty</span>
            <span>Entry</span>
            <span>Stop</span>
            <span>TP</span>
            {entries.map((entry, index) => {
              const openLot = position.openEntryLots.find((candidate) => candidate.id === entry.id);
              return (
                <div key={entry.id} className="lot-row">
                  <span>{index + 1}</span>
                  <span>{numberFormatter.format(roundDisplayQuantity(openLot?.remainingQuantity ?? 0))}</span>
                  <span>{numberFormatter.format(roundDisplayQuantity(entry.quantity))}</span>
                  <span>{formatPrice(entry.price)}</span>
                  <span>{entry.stopLoss == null ? "Not set" : formatPrice(entry.stopLoss)}</span>
                  <span>{entry.takeProfitLevels?.length ? entry.takeProfitLevels.map(formatPrice).join(", ") : "Not set"}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <h4>Sale Lots</h4>
          {exits.length === 0 ? (
            <p className="meta-text">No sale lots recorded yet.</p>
          ) : (
            <div className="lot-table sale-lot-table">
              <span>Sale</span>
              <span>Qty</span>
              <span>Price</span>
              <span>Method</span>
              <span>Date</span>
              {exits.map((exit, index) => (
                <div key={exit.id} className="lot-row">
                  <span>{index + 1}</span>
                  <span>{numberFormatter.format(roundDisplayQuantity(exit.quantity))}</span>
                  <span>{formatPrice(exit.price)}</span>
                  <span>{exit.allocationMethod ?? "oldest"}</span>
                  <span>{exit.date || "Not set"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDirection === "asc" ? " ▲" : " ▼") : "");

  const renderTradeRow = (trade: TrackedTrade) => {
    const metrics = tradeMetrics(trade);
    const position = metrics.position;
    const exitLots = getTradeExitLots(trade);
    const lastExitPrice = exitLots.at(-1)?.price ?? trade.exitPrice;
    const recommendationFailed = isRecommendationDataError(trade);
    const tone = isNearStopOrTarget(trade)
      ? "warning"
      : metrics.profitLoss != null && metrics.profitLoss >= 0
        ? "positive"
        : "negative";

    return (
      <>
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
          <td>
            {numberFormatter.format(roundDisplayQuantity(position.openQuantity))}
            {position.totalSoldQuantity > 0 && <small>Sold {numberFormatter.format(roundDisplayQuantity(position.totalSoldQuantity))}</small>}
          </td>
          <td>
            {formatPrice(position.averageOpenEntryPrice ?? position.averageEntryPrice)}
            <small>{formatLotSummary(getTradeEntryLots(trade))}</small>
          </td>
          <td>{trade.stopLoss == null ? "Not set" : formatPrice(trade.stopLoss)}</td>
          <td>{formatTakeProfitDisplay(trade)}</td>
          <td>
            <strong>{formatPrice(trade.recommendedTakeProfit)}</strong>
            <small className={recommendationFailed ? "recommendation-error" : undefined}>
              {getRecommendationExplanation(trade)}
            </small>
            {renderChartPreview(trade)}
          </td>
          <td>
            {position.openQuantity <= 0 ? formatPrice(lastExitPrice) : formatPrice(trade.currentPrice)}
            {position.totalSoldQuantity > 0 && <small>Sales: {formatLotSummary(exitLots)}</small>}
            {trade.priceError && <small className="field-error">{trade.priceError}</small>}
          </td>
          <td>{formatCurrency(metrics.profitLoss)}</td>
          <td>{formatPercent(metrics.profitLossPercent)}</td>
          <td>{formatCurrency(metrics.riskAmount)}</td>
          <td>{formatCurrency(metrics.rewardAmount)}</td>
          <td>{metrics.riskRewardRatio == null ? unavailableLabel : metrics.riskRewardRatio.toFixed(2)}</td>
          <td>
            <span className={`status-pill ${tone}`}>{metrics.status}</span>
          </td>
          <td>{renderTradeActions(trade)}</td>
        </tr>
        {expandedTradeIds.has(trade.id) && (
          <tr className="lot-detail-row">
            <td colSpan={14}>{renderLotDetails(trade)}</td>
          </tr>
        )}
      </>
    );
  };

  const renderTradeCard = (trade: TrackedTrade) => {
    const metrics = tradeMetrics(trade);
    const position = metrics.position;
    const exitLots = getTradeExitLots(trade);
    const lastExitPrice = exitLots.at(-1)?.price ?? trade.exitPrice;
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
              {numberFormatter.format(roundDisplayQuantity(position.openQuantity))} open shares
              {position.totalSoldQuantity > 0 ? ` · ${numberFormatter.format(roundDisplayQuantity(position.totalSoldQuantity))} sold` : ""}
              {trade.excludeFromPortfolioTotals ? " · Excluded from total" : ""}
            </p>
          </div>
          <span className={`status-pill ${tone}`}>{metrics.status}</span>
        </div>

        <div className="mobile-primary-grid">
          <span>
            {position.openQuantity <= 0 ? "Last sale" : "Current"}<strong>{formatPrice(position.openQuantity <= 0 ? lastExitPrice : trade.currentPrice)}</strong>
          </span>
          <span>
            P/L<strong>{formatCurrency(metrics.profitLoss)}</strong>
          </span>
          <span>
            P/L %<strong>{formatPercent(metrics.profitLossPercent)}</strong>
          </span>
          <span>
            Sell Target<strong>{formatPrice(trade.recommendedTakeProfit)}</strong>
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
              Avg Entry<strong>{formatPrice(position.averageOpenEntryPrice ?? position.averageEntryPrice)}</strong>
            </span>
            <span>
              SL<strong>{trade.stopLoss == null ? "Not set" : formatPrice(trade.stopLoss)}</strong>
            </span>
            <span>
              TP<strong>{formatTakeProfitDisplay(trade)}</strong>
            </span>
            <span>
              Entries<strong>{formatLotSummary(getTradeEntryLots(trade))}</strong>
            </span>
            <span>
              Sales<strong>{formatLotSummary(exitLots)}</strong>
            </span>
            <span>
              Risk<strong>{formatCurrency(metrics.riskAmount)}</strong>
            </span>
            <span>
              Reward<strong>{formatCurrency(metrics.rewardAmount)}</strong>
            </span>
            <span>
              R/R<strong>{metrics.riskRewardRatio == null ? unavailableLabel : metrics.riskRewardRatio.toFixed(2)}</strong>
            </span>
          </div>
          {renderLotDetails(trade)}
          <div className={`recommendation-box ${recommendationFailed ? "failed" : ""}`}>
            <span>Sell Target</span>
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
      setAuthError(getAuthErrorMessage(error));
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
      <header className="app-header">
        <span>{user.email ?? "Signed in"}</span>
        <button type="button" className="menu-trigger" onClick={() => setIsSideMenuOpen(true)}>
          Menu
        </button>
      </header>

      <section className="top-band">
        <div className="top-info">
          <p className="tool-summary">
            Track positions, live prices, unrealized P/L, risk levels, and sell targets across your selected strategies.
          </p>
          <p className="disclaimer-text">Educational tracking only. Not financial advice.</p>
          <p className="sync-status-line">
            {lastServerSync ? `Last synced ${lastServerSync}` : "Waiting for first server sync"}
            {statusMessage ? ` · ${statusMessage}` : ""}
          </p>
        </div>
        <div className="summary-grid">
          <article className={`summary-card portfolio-hero-card ${portfolio.unrealized >= 0 ? "positive" : "negative"}`}>
            <span>Total Open P/L</span>
            <strong>{formatCurrency(portfolio.unrealized)}</strong>
            <small>{formatPercent(portfolio.unrealizedPercent)}</small>
          </article>
          <article className={`summary-card ${portfolio.realized >= 0 ? "positive" : "negative"}`}>
            <span>Realized P/L</span>
            <strong>{formatCurrency(portfolio.realized)}</strong>
            <small>{formatPercent(portfolio.realizedPercent)}</small>
          </article>
          <article className="summary-card">
            <span>Positions</span>
            <strong>{isLoadingTrades ? "..." : `${portfolio.openCount} open`}</strong>
            <small>
              {visibleTradeCount} tracked · {portfolio.closedCount} closed · {excludedFromPortfolioTotalCount} excluded from total P/L.
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
          <div className="section-heading disclosure-heading">
            <h2>{form.id ? "Edit Trade" : "Add Trade"}</h2>
            <button
              type="button"
              className="disclosure-button"
              onClick={() => setIsTradeFormOpen((current) => !current)}
              aria-expanded={isTradeFormOpen}
              aria-controls="trade-form-fields"
            >
              {isTradeFormOpen ? "Hide" : "Expand"}
            </button>
          </div>
          {isTradeFormOpen && (
            <div id="trade-form-fields" className="trade-form-fields">
              <div className="form-grid">
                <label>
                  <span>Dashboard section</span>
                  <select value={form.category} onChange={handleFormChange("category")}>
                    {visibleTradeCategories.map((category) => (
                      <option key={category} value={category}>
                        {getCategoryLabel(category)}
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
              </div>
              <details
                className="form-optional-details"
                open={isTradeOptionalDetailsOpen}
                onToggle={(event) => setIsTradeOptionalDetailsOpen(event.currentTarget.open)}
              >
                <summary>Optional details</summary>
                <div className="form-grid compact-form-grid">
                  <label>
                    <span>Stop loss</span>
                    <input type="number" min="0" step="0.01" value={form.stopLoss} onChange={handleFormChange("stopLoss")} placeholder="Optional" />
                    {formErrors.stopLoss && <small className="field-error">{formErrors.stopLoss}</small>}
                  </label>
                  <label>
                    <span>Take profit price(s)</span>
                    <input value={form.takeProfit} onChange={handleFormChange("takeProfit")} placeholder="Optional, comma-separated" />
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
              </details>
              <div className="form-actions">
                <button type="submit" className="primary-button">{form.id ? "Save Changes" : "Add Trade"}</button>
                {form.id && <button type="button" className="secondary-button" onClick={handleCancelEdit}>Cancel</button>}
              </div>
            </div>
          )}
        </form>

        <form className="risk-calculator panel" onSubmit={handleRiskCalculate}>
          <div className="section-heading disclosure-heading">
            <div>
              <h2>Risk Management Calculator</h2>
              <p className="meta-text">Plan position size from your intended dollar risk.</p>
            </div>
            <button
              type="button"
              className="disclosure-button"
              onClick={() => setIsRiskCalculatorOpen((current) => !current)}
              aria-expanded={isRiskCalculatorOpen}
              aria-controls="risk-calculator-fields"
            >
              {isRiskCalculatorOpen ? "Hide" : "Expand"}
            </button>
          </div>

          {isRiskCalculatorOpen && (
            <div id="risk-calculator-fields" className="risk-calculator-fields">
              <div className="direction-toggle" role="group" aria-label="Trade direction">
                <button
                  type="button"
                  className={riskForm.direction === "long" ? "active" : ""}
                  onClick={() => {
                    setRiskForm((current) => ({ ...current, direction: "long" }));
                    setRiskErrors({});
                    setRiskResult(null);
                  }}
                >
                  Long
                </button>
                <button
                  type="button"
                  className={riskForm.direction === "short" ? "active" : ""}
                  onClick={() => {
                    setRiskForm((current) => ({ ...current, direction: "short" }));
                    setRiskErrors({});
                    setRiskResult(null);
                  }}
                >
                  Short
                </button>
              </div>

              <div className="form-grid risk-form-grid">
                <label>
                  <span>Total portfolio value ($)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={riskForm.portfolioValue}
                    onChange={handleRiskFormChange("portfolioValue")}
                    placeholder="25000"
                  />
                  {riskErrors.portfolioValue && <small className="field-error">{riskErrors.portfolioValue}</small>}
                </label>
                <label>
                  <span>Desired risk amount ($)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={riskForm.desiredRiskAmount}
                    onChange={handleRiskFormChange("desiredRiskAmount")}
                    placeholder="250"
                  />
                  {riskErrors.desiredRiskAmount && <small className="field-error">{riskErrors.desiredRiskAmount}</small>}
                </label>
                <label>
                  <span>Entry price</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={riskForm.entryPrice}
                    onChange={handleRiskFormChange("entryPrice")}
                    placeholder="50.00"
                  />
                  {riskErrors.entryPrice && <small className="field-error">{riskErrors.entryPrice}</small>}
                </label>
                <label>
                  <span>Target price (optional)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={riskForm.targetPrice}
                    onChange={handleRiskFormChange("targetPrice")}
                    placeholder="Optional"
                  />
                  {riskErrors.targetPrice && <small className="field-error">{riskErrors.targetPrice}</small>}
                </label>
                <label>
                  <span>Stop loss price</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={riskForm.stopLossPrice}
                    onChange={handleRiskFormChange("stopLossPrice")}
                    placeholder={riskForm.direction === "long" ? "47.50" : "52.50"}
                  />
                  {riskErrors.stopLossPrice && <small className="field-error">{riskErrors.stopLossPrice}</small>}
                </label>
              </div>

              <div className="form-actions">
                <button type="submit" className="primary-button">Calculate Position</button>
                <button type="button" className="secondary-button" onClick={handleRiskReset}>Reset</button>
              </div>

              {riskResult && (
                <div className="risk-result-panel" aria-live="polite">
                  <div className={`risk-result-hero ${riskResult.exceedsPortfolioValue ? "over-portfolio" : ""}`}>
                    <span>Suggested position size</span>
                    <strong>{numberFormatter.format(riskResult.quantity)} shares</strong>
                    <small>
                      Investment amount: {formatCurrency(riskResult.investmentAmount)}
                      {riskResult.exceedsPortfolioValue ? " · Higher than total portfolio" : ""}
                    </small>
                  </div>
                  <div className="metric-grid risk-result-grid">
                    <span>
                      Actual risk<strong>{formatCurrency(riskResult.actualRiskAmount)}</strong>
                    </span>
                    <span className={riskResult.exceedsPortfolioValue ? "metric-warning" : ""}>
                      Investment amount<strong>{formatCurrency(riskResult.investmentAmount)}</strong>
                    </span>
                    <span>
                      Portfolio risk<strong>{formatPercent(riskResult.portfolioRiskPercent)}</strong>
                    </span>
                    <span>
                      Potential profit<strong>{formatCurrency(riskResult.potentialRewardAmount)}</strong>
                    </span>
                    <span>
                      Reward / risk<strong>{riskResult.rewardRiskRatio == null ? unavailableLabel : riskResult.rewardRiskRatio.toFixed(2)}</strong>
                    </span>
                    <span>
                      Risk per share<strong>{formatCurrency(riskResult.riskPerShare)}</strong>
                    </span>
                    <span>
                      Portfolio allocation<strong>{formatPercent(riskResult.portfolioAllocationPercent)}</strong>
                    </span>
                  </div>
                  <p className="meta-text">
                    Position size is rounded down to whole shares so actual risk does not exceed the desired risk amount.
                  </p>
                </div>
              )}
            </div>
          )}
        </form>

      </section>

      {positionModal && (
        <div className="modal-backdrop" role="presentation" onClick={() => setPositionModal(null)}>
          <form className="position-modal panel" onSubmit={handleSubmitPositionModal} onClick={(event) => event.stopPropagation()}>
            <div className="section-heading disclosure-heading">
              <div>
                <p className="eyebrow">{positionModal.trade.symbol}</p>
                <h2>{positionModal.mode === "add-entry" ? "Add Entry Lot" : "Record Sale"}</h2>
              </div>
              <button type="button" className="side-menu-close" onClick={() => setPositionModal(null)} aria-label="Close position dialog">
                ×
              </button>
            </div>
            <div className="form-grid position-modal-grid">
              <label>
                <span>{positionModal.mode === "add-entry" ? "Shares bought" : "Shares sold"}</span>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={positionModal.quantity}
                  onChange={(event) => setPositionModal((current) => current ? { ...current, quantity: event.target.value, error: "" } : current)}
                  autoFocus
                />
              </label>
              <label>
                <span>{positionModal.mode === "add-entry" ? "Entry price" : "Sale price"}</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={positionModal.price}
                  onChange={(event) => setPositionModal((current) => current ? { ...current, price: event.target.value, error: "" } : current)}
                />
              </label>
              {positionModal.mode === "add-entry" && (
                <>
                  <label>
                    <span>Lot stop loss</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={positionModal.stopLoss}
                      onChange={(event) => setPositionModal((current) => current ? { ...current, stopLoss: event.target.value, error: "" } : current)}
                      placeholder="Optional"
                    />
                  </label>
                  <label>
                    <span>Lot take profit(s)</span>
                    <input
                      value={positionModal.takeProfit}
                      onChange={(event) => setPositionModal((current) => current ? { ...current, takeProfit: event.target.value, error: "" } : current)}
                      placeholder="Optional, comma-separated"
                    />
                  </label>
                </>
              )}
              {positionModal.mode === "sell-shares" && (
                <>
                  <label>
                    <span>Sell allocation</span>
                    <select
                      value={positionModal.allocationMethod}
                      onChange={(event) =>
                        setPositionModal((current) =>
                          current ? { ...current, allocationMethod: event.target.value as SellAllocationMethod, error: "" } : current,
                        )
                      }
                    >
                      <option value="oldest">Oldest lot first</option>
                      <option value="newest">Newest lot first</option>
                      <option value="manual">Specific lot</option>
                    </select>
                  </label>
                  {positionModal.allocationMethod === "manual" && (
                    <label>
                      <span>Buy lot</span>
                      <select
                        value={positionModal.selectedEntryId}
                        onChange={(event) =>
                          setPositionModal((current) =>
                            current ? { ...current, selectedEntryId: event.target.value, error: "" } : current,
                          )
                        }
                      >
                        {calculateTradePosition(positionModal.trade).openEntryLots.map((entry, index) => (
                          <option key={entry.id} value={entry.id}>
                            Lot {index + 1}: {numberFormatter.format(roundDisplayQuantity(entry.remainingQuantity))} @ {formatPrice(entry.price)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
            </div>
            {positionModal.mode === "sell-shares" && (
              <p className="meta-text">
                Open shares: {numberFormatter.format(roundDisplayQuantity(calculateTradePosition(positionModal.trade).openQuantity))}
              </p>
            )}
            {positionModal.error && <p className="error-text">{positionModal.error}</p>}
            <div className="form-actions">
              <button type="submit" className="primary-button">
                {positionModal.mode === "add-entry" ? "Save Entry" : "Save Sale"}
              </button>
              <button type="button" className="secondary-button" onClick={() => setPositionModal(null)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {isSideMenuOpen && (
        <div className="side-menu-backdrop" role="presentation" onClick={() => setIsSideMenuOpen(false)}>
          <aside className="side-menu" aria-label="Tracker settings" onClick={(event) => event.stopPropagation()}>
            <div className="side-menu-header">
              <div>
                <p className="eyebrow">Menu</p>
                <h2>Settings</h2>
              </div>
              <button type="button" className="side-menu-close" onClick={() => setIsSideMenuOpen(false)} aria-label="Close menu">
                ×
              </button>
            </div>

            <div className="side-menu-body">
              <section className="side-menu-section">
                <h3>Market Data</h3>
                <label>
                  <span>Price data source</span>
                  <select value={provider} onChange={(event) => setProvider(event.target.value as MarketDataProviderId)}>
                    <option value="yahoo">Yahoo market data</option>
                    <option value="alphavantage">Alpha Vantage market data</option>
                  </select>
                </label>
                <p className="meta-text">
                  Prices are pulled from live market data when available.
                </p>
              </section>

              <section className="side-menu-section">
                <div className="section-heading disclosure-heading">
                  <h3>Strategies</h3>
                  <button
                    type="button"
                    className="disclosure-button"
                    onClick={() => {
                      setSectionSelectionDraft(enabledTradeCategories);
                      setCategoryLabelDraft(categoryLabels);
                      setCustomSectionName("");
                      setCustomSectionError("");
                      setIsSectionChooserOpen((current) => !current);
                      setIsImportChooserOpen(false);
                    }}
                    aria-expanded={isSectionChooserOpen}
                    aria-controls="strategy-picker-panel"
                  >
                    {isSectionChooserOpen ? "Hide" : "Expand"}
                  </button>
                </div>
                {isSectionChooserOpen && (
                  <div id="strategy-picker-panel" className="section-picker-panel" aria-label="Strategy selection">
                    <div>
                      <h2>Choose Strategies</h2>
                      <p className="meta-text">Only selected strategies appear in the add form, import menu, and dashboard tabs.</p>
                    </div>
                    <div className="section-choice-grid">
                      {uniqueCategories([
                        ...TRADE_CATEGORIES,
                        ...availableTradeCategories,
                        ...enabledTradeCategories,
                        ...sectionSelectionDraft,
                        ...Object.keys(categoryLabelDraft),
                      ]).map((category) => (
                        <div key={category} className="section-choice">
                          <label className="section-choice-toggle">
                            <input
                              type="checkbox"
                              checked={sectionSelectionDraft.includes(category)}
                              onChange={() => toggleSectionSelectionDraft(category)}
                            />
                            <span>{category}</span>
                          </label>
                          <label className="section-name-field">
                            <span>Tab name</span>
                            <input
                              value={categoryLabelDraft[category]}
                              onChange={(event) => handleCategoryLabelDraftChange(category, event.target.value)}
                              placeholder={category}
                            />
                          </label>
                        </div>
                      ))}
                    </div>
                    <div className="custom-section-row">
                      <label>
                        <span>Custom strategy</span>
                        <input
                          value={customSectionName}
                          onChange={(event) => {
                            setCustomSectionName(event.target.value);
                            setCustomSectionError("");
                          }}
                          placeholder="My watchlist"
                        />
                      </label>
                      <button type="button" className="secondary-button" onClick={addCustomSectionDraft}>
                        Add Strategy
                      </button>
                    </div>
                    {customSectionError && <small className="field-error">{customSectionError}</small>}
                    <div className="form-actions">
                      <button type="button" className="primary-button" onClick={() => void saveSectionSelection()} disabled={isSavingSections}>
                        {isSavingSections ? "Saving..." : "Save Strategies"}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          setSectionSelectionDraft(enabledTradeCategories);
                          setCategoryLabelDraft(categoryLabels);
                          setCustomSectionName("");
                          setCustomSectionError("");
                          setIsSectionChooserOpen(false);
                        }}
                        disabled={isSavingSections}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </section>

              <section className="side-menu-section">
                <h3>Data</h3>
                <div className="side-menu-actions">
                  <button type="button" className="secondary-button" onClick={exportCsv} disabled={visibleTradeCount === 0}>Export CSV</button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setImportCategory(activeCategory);
                      setIsImportChooserOpen((current) => !current);
                      setIsSectionChooserOpen(false);
                    }}
                  >
                    Import CSV
                  </button>
                </div>
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
                {isImportChooserOpen && (
                  <div className="import-panel">
                    <label>
                      <span>Import into sheet</span>
                      <select value={importCategory} onChange={(event) => setImportCategory(event.target.value as TradeCategory)}>
                        {visibleTradeCategories.map((category) => (
                          <option key={category} value={category}>
                            {getCategoryLabel(category)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" className="primary-button full-width" onClick={() => fileInputRef.current?.click()}>
                      Choose CSV
                    </button>
                  </div>
                )}
              </section>

              <details className="side-menu-section legal-details">
                <summary>Privacy, Data, and Disclaimer</summary>
                <div className="legal-copy">
                  <p>
                    This tracker stores your symbols, quantities, entry prices, stops, targets, notes, strategy names,
                    and settings in Firebase Firestore under your signed-in user ID.
                  </p>
                  <p>
                    Price data is requested from the configured market-data source. Live market data may be delayed,
                    unavailable, or inaccurate. Verify prices with your broker before trading.
                  </p>
                  <p>
                    This app is for tracking and educational purposes only. It does not provide financial advice.
                  </p>
                  <p>
                    Use Export CSV to keep a copy of your data. Use Delete Account Data to permanently remove your
                    tracker data from Firestore.
                  </p>
                </div>
              </details>

              <details className="side-menu-section advanced-details">
                <summary>Advanced</summary>
                <div className="diagnostics-list">
                  <span>Version {buildInfo.version}</span>
                  <span>Git build {buildInfo.builds.git}</span>
                  <span>Firestore build {buildInfo.builds.firestore}</span>
                  <span>Cloudflare build {buildInfo.builds.cloudflare}</span>
                  <span>Ext build {buildInfo.builds.ext}</span>
                  <span>UID {user.uid.slice(0, 8)}</span>
                  <span>Source: {provider === "yahoo" ? "Yahoo-compatible Worker endpoint" : "Alpha Vantage via Worker"}</span>
                  {lastServerSync && <span>Last synced {lastServerSync}</span>}
                </div>
                <div className="side-menu-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      void syncServerState()
                        .then(() => setStatusMessage("Loaded latest server state."))
                        .catch((error) => {
                          setGlobalError(error instanceof Error ? error.message : "Failed to load latest server state.");
                        })
                    }
                  >
                    Sync Now
                  </button>
                  <button type="button" className="secondary-button" onClick={() => void handlePersistenceCheck()}>
                    Check Server Data
                  </button>
                </div>
                {persistenceDiagnostics && (
                  <pre className="persistence-diagnostics" aria-label="Firestore server diagnostics">
                    {persistenceDiagnostics}
                  </pre>
                )}
              </details>
            </div>

            <div className="side-menu-footer">
              <h3>Account</h3>
              <button
                type="button"
                className="danger-button secondary-button"
                onClick={() => void handleDeleteAllAccountData()}
                disabled={isDeletingAccountData}
              >
                {isDeletingAccountData ? "Deleting..." : "Delete Account Data"}
              </button>
              <button type="button" className="danger-button secondary-button" onClick={() => void handleSignOut()}>
                Log Out
              </button>
            </div>
          </aside>
        </div>
      )}

      <section className="panel dashboard-panel">
        <div className="results-toolbar">
          <div>
            <h2>Dashboard</h2>
            <p className="meta-text">Prices refresh every 60 seconds.</p>
          </div>
          <div className="dashboard-toolbar-actions">
            <div className="dashboard-actions">
              <button type="button" className="primary-button" onClick={() => void refreshPrices()} disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh Prices"}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void recalculateSellRecommendations()}
                disabled={isRecalculatingRecommendations || activeTrades.length === 0}
              >
                {isRecalculatingRecommendations
                  ? `Updating ${recommendationProgress?.current ?? 0}/${recommendationProgress?.total ?? activeTrades.length}...`
                  : "Update sell targets"}
              </button>
            </div>
            <div className="sort-controls">
              <span>Sort</span>
              <button type="button" onClick={() => handleSort("symbol")}>Symbol{sortArrow("symbol")}</button>
              <button type="button" onClick={() => handleSort("profitLoss")}>P/L{sortArrow("profitLoss")}</button>
              <button type="button" onClick={() => handleSort("riskReward")}>R/R{sortArrow("riskReward")}</button>
              <button type="button" onClick={() => handleSort("status")}>Status{sortArrow("status")}</button>
            </div>
          </div>
        </div>

        <div className="sheet-tabs" role="tablist" aria-label="Dashboard sheets">
          {visibleTradeCategories.map((category) => (
            <button
              key={category}
              type="button"
              role="tab"
              aria-selected={activeCategory === category}
              className={`${activeCategory === category ? "active" : ""} ${
                excludedPortfolioCategorySet.has(category) ? "excluded" : ""
              }`}
              onClick={() => setActiveCategory(category)}
              aria-label={`${getCategoryLabel(category)}: ${formatCurrency(categorySummaries[category].totalProfitLoss)}, ${formatPercent(
                categorySummaries[category].totalProfitLossPercent,
              )}${excludedPortfolioCategorySet.has(category) ? ", excluded from total portfolio P/L" : ""}`}
            >
              <span className="tab-title">{getCategoryLabel(category)}</span>
              <strong className="tab-count">{numberFormatter.format(visibleTradesByCategory[category]?.length ?? 0)}</strong>
              <small className="tab-pl">
                {formatCurrency(categorySummaries[category].totalProfitLoss)} /{" "}
                {formatPercent(categorySummaries[category].totalProfitLossPercent)}
              </small>
              <small className="tab-inclusion">
                {hiddenClosedTradeCategorySet.has(category)
                  ? "Closed hidden"
                  : excludedPortfolioCategorySet.has(category)
                    ? "Excluded from total"
                    : "Included in total"}
              </small>
            </button>
          ))}
        </div>

        <section className="dashboard-sheet">
          <div className="dashboard-section-header">
            <div className="strategy-title-block">
              <h3>{getCategoryLabel(activeCategory)}</h3>
              <span>
                {numberFormatter.format(visibleActiveTrades.length)} shown of {numberFormatter.format(activeTrades.length)} trades,{" "}
                {activeSummary.openCount} open, {activeSummary.closedCount} closed
              </span>
            </div>
            <div className="strategy-pl-row">
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
            <div className="strategy-inclusion-row">
              <small className="section-inclusion-status">
                {excludedPortfolioCategorySet.has(activeCategory) ? "Excluded from total P/L" : "Included in total P/L"}
              </small>
              <button
                type="button"
                className={`secondary-button section-total-toggle ${
                  activeClosedTradesHidden ? "active" : ""
                }`}
                onClick={() => void handleToggleClosedTradesVisibility(activeCategory)}
              >
                {activeClosedTradesHidden ? "Show closed trades" : "Hide closed trades"}
              </button>
              <button
                type="button"
                className={`secondary-button section-total-toggle ${
                  excludedPortfolioCategorySet.has(activeCategory) ? "active" : ""
                }`}
                onClick={() => void handleToggleCategoryPortfolioInclusion(activeCategory)}
              >
                {excludedPortfolioCategorySet.has(activeCategory)
                  ? "Include in total P/L"
                  : "Exclude from total P/L"}
              </button>
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
                  <th>Sell Target</th>
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
                {visibleActiveTrades.length === 0 && (
                  <tr>
                    <td colSpan={14} className="empty-state">
                      {activeTrades.length === 0 ? "No trades in this sheet yet." : "Closed trades are hidden in this sheet."}
                    </td>
                  </tr>
                )}
                {visibleActiveTrades.map(renderTradeRow)}
              </tbody>
            </table>
          </div>

          <div className="mobile-cards">
            {visibleActiveTrades.length === 0 ? (
              <p className="empty-state">
                {activeTrades.length === 0 ? "No trades in this sheet yet." : "Closed trades are hidden in this sheet."}
              </p>
            ) : (
              visibleActiveTrades.map(renderTradeCard)
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
