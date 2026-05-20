import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketDataProviderId } from "@shared/types";
import {
  signInWithEmail,
  signInWithGoogle,
  signOutCurrentUser,
  signUpWithEmail,
  isFirebaseConfigured,
  missingFirebaseConfigKeys,
  subscribeToAuth,
  type User,
} from "./firebase/client";
import { deleteUserTrade, importUserTrades, replaceUserTrades, saveUserTrade, subscribeToUserTrades } from "./services/firebaseTradeStore";
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
  const profitLoss =
    trade.currentPrice == null
      ? null
      : calculateProfitLossDollars(trade.currentPrice, trade.entryPrice, trade.quantity);
  const profitLossPercent =
    trade.currentPrice == null ? null : calculateProfitLossPercent(trade.currentPrice, trade.entryPrice);
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
  const invested = items.reduce((sum, trade) => sum + trade.entryPrice * trade.quantity, 0);
  const unrealized = items.reduce((sum, trade) => {
    if (trade.currentPrice == null) return sum;
    return sum + calculateProfitLossDollars(trade.currentPrice, trade.entryPrice, trade.quantity);
  }, 0);

  return {
    invested,
    unrealized,
    unrealizedPercent: invested > 0 ? (unrealized / invested) * 100 : null,
  };
};

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
  const [isImportChooserOpen, setIsImportChooserOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Ready. Add a trade or refresh prices.");
  const [globalError, setGlobalError] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingTrades, setIsLoadingTrades] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const initialRefreshUserRef = useRef<string | null>(null);
  const isRefreshingRef = useRef(false);

  useEffect(() => {
    return subscribeToAuth((nextUser) => {
      setUser(nextUser);
      setIsAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!user) {
      setTrades([]);
      setIsLoadingTrades(false);
      initialRefreshUserRef.current = null;
      setStatusMessage("Sign in to load your trades.");
      return undefined;
    }

    setIsLoadingTrades(true);
    setGlobalError("");

    return subscribeToUserTrades(
      user,
      (nextTrades) => {
        setTrades(nextTrades);
        setIsLoadingTrades(false);
        setStatusMessage(`Loaded ${nextTrades.length} trade${nextTrades.length === 1 ? "" : "s"} from Firestore.`);
      },
      (error) => {
        setGlobalError(error.message);
        setIsLoadingTrades(false);
        setStatusMessage("Trade load failed.");
      },
    );
  }, [user]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
  }, [provider]);

  const enrichTradeRecommendation = useCallback(
    async (trade: TrackedTrade) => {
      try {
        const response = await loadTradeCandles(trade.symbol, provider);
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
        };
      } catch (error) {
        const recommendation = recommendTakeProfit(trade.entryPrice, trade.stopLoss, trade.quantity);
        return {
          ...trade,
          recommendedTakeProfit: recommendation.price,
          recommendationExplanation:
            error instanceof Error
              ? `Candle data was unavailable (${error.message}), so the sell recommendation uses the fallback model.`
              : recommendation.explanation,
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

    const symbols = [...new Set(trades.map((trade) => trade.symbol).filter(Boolean))];
    if (symbols.length === 0) {
      setStatusMessage("No trades to refresh yet.");
      return;
    }

    isRefreshingRef.current = true;
    setIsRefreshing(true);
    setGlobalError("");

    try {
      const response = await refreshTradeQuotes(symbols, provider);
      const quoteBySymbol = new Map(response.quotes.map((quote) => [quote.symbol.toUpperCase(), quote]));
      const errorBySymbol = new Map(response.errors.map((error) => [error.symbol.toUpperCase(), error.message]));

      const nextTrades = trades.map((trade) => {
        const quote = quoteBySymbol.get(trade.symbol.toUpperCase());
        const priceError = errorBySymbol.get(trade.symbol.toUpperCase()) ?? null;
        if (!quote) return { ...trade, priceError };
        return {
          ...trade,
          currentPrice: quote.price,
          currentPriceAsOf: quote.asOf,
          currentPriceProvider: quote.provider,
          priceError,
        };
      });
      setTrades(nextTrades);
      await replaceUserTrades(user, nextTrades);

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

  useEffect(() => {
    if (!user || isLoadingTrades || trades.length === 0) return;
    if (initialRefreshUserRef.current === user.uid) return;

    initialRefreshUserRef.current = user.uid;
    void refreshPrices();
  }, [isLoadingTrades, refreshPrices, trades.length, user]);

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
    };

    setStatusMessage("Saving trade and calculating the recommended sell price...");
    const tradeWithRecommendation = await enrichTradeRecommendation(baseTrade);
    try {
      const savedTrade = await saveUserTrade(user, tradeWithRecommendation);
      setTrades((currentTrades) => {
        const exists = currentTrades.some((trade) => trade.id === savedTrade.id);
        if (!exists) return [savedTrade, ...currentTrades];
        return currentTrades.map((trade) => (trade.id === savedTrade.id ? savedTrade : trade));
      });

      setActiveCategory(savedTrade.category ?? "Swing");
      setForm(emptyForm);
      setStatusMessage(`${savedTrade.symbol} saved to Firestore. Refresh prices to update live P/L.`);
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
    });
    setFormErrors({});
    setActiveCategory(trade.category ?? "Swing");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleDelete = async (id: string) => {
    if (!user) {
      setStatusMessage("Sign in before deleting trades.");
      return;
    }

    try {
      await deleteUserTrade(user, id);
      setTrades((currentTrades) => currentTrades.filter((trade) => trade.id !== id));
      if (form.id === id) setForm(emptyForm);
      setStatusMessage("Trade deleted from Firestore.");
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "Failed to delete trade.");
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

    return [...trades].sort((left, right) => (sortDirection === "asc" ? compare(left, right) : -compare(left, right)));
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

  const portfolio = useMemo(() => {
    return summarizeTrades(trades);
  }, [trades]);

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
    ];

    const rows = trades.map((trade) => {
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
        importedTrades.push(await enrichTradeRecommendation({ id: createId(), ...validation.values }));
      }
    }

    if (importedTrades.length > 0) {
      const savedTrades = await importUserTrades(user, importedTrades);
      setTrades((currentTrades) => [...savedTrades, ...currentTrades]);
      setActiveCategory(targetCategory);
      setIsImportChooserOpen(false);
      setStatusMessage(
        `Imported ${savedTrades.length} trade${savedTrades.length === 1 ? "" : "s"} into ${targetCategory}.`,
      );
    } else {
      setGlobalError("No valid trades were found in the CSV.");
    }
  };

  const renderTradeActions = (trade: TrackedTrade) => (
    <div className="row-actions">
      <button type="button" className="icon-button" onClick={() => handleEdit(trade)} aria-label={`Edit ${trade.symbol}`}>
        Edit
      </button>
      <button type="button" className="icon-button danger-button" onClick={() => void handleDelete(trade.id)} aria-label={`Delete ${trade.symbol}`}>
        Delete
      </button>
    </div>
  );

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDirection === "asc" ? " ▲" : " ▼") : "");

  const renderTradeRow = (trade: TrackedTrade) => {
    const metrics = tradeMetrics(trade);
    const tone = isNearStopOrTarget(trade)
      ? "warning"
      : metrics.profitLoss != null && metrics.profitLoss >= 0
        ? "positive"
        : "negative";

    return (
      <tr key={trade.id} className={`trade-row ${tone}`}>
        <td>
          <strong>{trade.symbol}</strong>
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
          <small>{trade.recommendationExplanation}</small>
        </td>
        <td>
          {formatPrice(trade.currentPrice)}
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
            <p>{numberFormatter.format(trade.quantity)} shares</p>
          </div>
          <span className={`status-pill ${tone}`}>{metrics.status}</span>
        </div>
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
            Current<strong>{formatPrice(trade.currentPrice)}</strong>
          </span>
          <span>
            P/L $<strong>{formatCurrency(metrics.profitLoss)}</strong>
          </span>
          <span>
            P/L %<strong>{formatPercent(metrics.profitLossPercent)}</strong>
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
        <div className="recommendation-box">
          <span>Recommended Sell</span>
          <strong>{formatPrice(trade.recommendedTakeProfit)}</strong>
          <p>{trade.recommendationExplanation}</p>
        </div>
        {trade.notes && <p className="notes-text">{trade.notes}</p>}
        {trade.priceError && <p className="field-error">{trade.priceError}</p>}
        {renderTradeActions(trade)}
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
          <article className="summary-card">
            <span>Tracked trades</span>
            <strong>{isLoadingTrades ? "..." : numberFormatter.format(trades.length)}</strong>
            <small>{statusMessage}</small>
          </article>
        </div>
      </section>

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
          <div className="utility-actions">
            <button type="button" className="secondary-button" onClick={exportCsv} disabled={trades.length === 0}>Export CSV</button>
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
                {formatCurrency(categorySummaries[category].unrealized)} /{" "}
                {formatPercent(categorySummaries[category].unrealizedPercent)}
              </small>
            </button>
          ))}
        </div>

        <section className="dashboard-sheet">
          <div className="dashboard-section-header">
            <div>
              <h3>{activeCategory}</h3>
              <span>{numberFormatter.format(activeTrades.length)} trades</span>
            </div>
            <div className={`sheet-pl ${activeSummary.unrealized >= 0 ? "positive" : "negative"}`}>
              <span>Total P/L</span>
              <strong>{formatCurrency(activeSummary.unrealized)}</strong>
              <small>{formatPercent(activeSummary.unrealizedPercent)}</small>
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
    </main>
  );
}
