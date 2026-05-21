import {
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  serverTimestamp,
  setDoc,
  waitForPendingWrites,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { requireDb, type User } from "../firebase/client";
import type { TrackedTrade } from "../utils/tradeCalculations";

const normalizeTrade = (trade: TrackedTrade): TrackedTrade => ({
  ...trade,
  category: trade.category ?? "Swing",
  symbol: trade.symbol.trim().toUpperCase(),
  stopLoss: trade.stopLoss ?? null,
  takeProfit: trade.takeProfit ?? null,
  tags: trade.tags ?? [],
  isClosed: trade.isClosed ?? false,
  exitPrice: trade.exitPrice ?? null,
  exitDate: trade.exitDate ?? "",
  excludeFromPortfolioTotals: trade.excludeFromPortfolioTotals ?? false,
});

const stripDerivedMarketData = (trade: TrackedTrade): TrackedTrade => ({
  ...trade,
  currentPrice: null,
  currentPriceAsOf: null,
  currentPriceProvider: null,
  priceError: null,
  recommendedTakeProfit: null,
  recommendationExplanation: "",
  chartCandles: [],
});

const derivedMarketDataFields = [
  "currentPrice",
  "currentPriceAsOf",
  "currentPriceProvider",
  "priceError",
  "recommendedTakeProfit",
  "recommendationExplanation",
  "chartCandles",
] as const;

const tradesCollection = (user: User) => collection(requireDb(), "users", user.uid, "trades");
const tradeDoc = (user: User, id: string) => doc(requireDb(), "users", user.uid, "trades", id);
const tradePath = (user: User, id: string) => `users/${user.uid}/trades/${id}`;
const deletedTradesCollection = (user: User) => collection(requireDb(), "users", user.uid, "deletedTrades");
const deletedTradeDoc = (user: User, id: string) => doc(requireDb(), "users", user.uid, "deletedTrades", id);
const deletedSymbolsCollection = (user: User) => collection(requireDb(), "users", user.uid, "deletedSymbols");
const deletedSymbolDoc = (user: User, symbol: string) => doc(requireDb(), "users", user.uid, "deletedSymbols", symbol);

const fromFirestore = (id: string, data: Record<string, unknown>): TrackedTrade => {
  const trade = stripDerivedMarketData(
    normalizeTrade({
      ...(data as Omit<TrackedTrade, "id">),
      id,
    }),
  );

  return {
    ...trade,
    quantity: Number(trade.quantity),
    entryPrice: Number(trade.entryPrice),
    exitPrice: trade.exitPrice == null ? null : Number(trade.exitPrice),
    isClosed: Boolean(trade.isClosed),
    excludeFromPortfolioTotals: Boolean(trade.excludeFromPortfolioTotals),
    isDeleted: Boolean(trade.isDeleted),
  };
};

const toFirestore = (trade: TrackedTrade) => {
  const {
    currentPrice,
    currentPriceAsOf,
    currentPriceProvider,
    priceError,
    recommendedTakeProfit,
    recommendationExplanation,
    chartCandles,
    ...persistentTrade
  } = normalizeTrade(trade);
  return {
    ...persistentTrade,
    updatedAt: serverTimestamp(),
  };
};

const derivedMarketDataDeletes = () => ({
  currentPrice: deleteField(),
  currentPriceAsOf: deleteField(),
  currentPriceProvider: deleteField(),
  priceError: deleteField(),
  recommendedTakeProfit: deleteField(),
  recommendationExplanation: deleteField(),
  chartCandles: deleteField(),
});

const hasDerivedMarketData = (data: Record<string, unknown>) =>
  derivedMarketDataFields.some((field) => Object.prototype.hasOwnProperty.call(data, field));

export interface TradePersistenceDiagnostics {
  uid: string;
  rawTrades: Array<{
    id: string;
    symbol: string;
    isDeleted: boolean;
    hasDeletedMarker: boolean;
  }>;
  deletedTradeIds: string[];
  deletedSymbols: string[];
  visibleTradeIds: string[];
}

export interface DeleteTradeResult {
  symbol: string;
  id: string;
  path: string;
  existedBeforeDelete: boolean;
  remainingSameSymbolIds: string[];
}

export const loadTradePersistenceDiagnostics = async (user: User): Promise<TradePersistenceDiagnostics> => {
  const [tradeSnapshot, deletedSnapshot, deletedSymbolSnapshot] = await Promise.all([
    getDocsFromServer(tradesCollection(user)),
    getDocsFromServer(deletedTradesCollection(user)),
    getDocsFromServer(deletedSymbolsCollection(user)),
  ]);
  const deletedTradeIds = new Set(deletedSnapshot.docs.map((item) => item.id));
  const deletedSymbols = new Set(deletedSymbolSnapshot.docs.map((item) => item.id.toUpperCase()));
  const rawTrades = tradeSnapshot.docs.map((item) => {
    const data = item.data();
    const symbol = typeof data.symbol === "string" ? data.symbol : "(no symbol)";
    return {
      id: item.id,
      symbol,
      isDeleted: data.isDeleted === true,
      hasDeletedMarker: deletedTradeIds.has(item.id) || deletedSymbols.has(symbol.toUpperCase()),
    };
  });

  return {
    uid: user.uid,
    rawTrades,
    deletedTradeIds: [...deletedTradeIds].sort(),
    deletedSymbols: [...deletedSymbols].sort(),
    visibleTradeIds: rawTrades
      .filter((trade) => !trade.isDeleted)
      .map((trade) => trade.id)
      .sort(),
  };
};

export const loadUserTradesFromServer = async (user: User) => {
  const tradeSnapshot = await getDocsFromServer(tradesCollection(user));

  return tradeSnapshot.docs
    .filter((item) => {
      const data = item.data();
      return data.isDeleted !== true;
    })
    .map((item) => fromFirestore(item.id, item.data()))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
};

export const subscribeToUserTrades = (
  user: User,
  onNext: (trades: TrackedTrade[]) => void,
  onError: (error: Error) => void,
): Unsubscribe => {
  let latestTradeDocs: QueryDocumentSnapshot<DocumentData>[] | null = null;

  const emitVisibleTrades = () => {
    if (!latestTradeDocs) return;

    const staleDocs = latestTradeDocs.filter(
      (item) =>
        item &&
        item.data().isDeleted !== true &&
        hasDerivedMarketData(item.data()),
    );
    if (staleDocs.length > 0) {
      void Promise.all(staleDocs.map((item) => setDoc(item.ref, derivedMarketDataDeletes(), { merge: true }))).catch(
        (error) => {
          onError(error instanceof Error ? error : new Error("Failed to clear stale derived market data from Firestore."));
        },
      );
    }

    const trades = latestTradeDocs
      .filter((item) => item && item.data().isDeleted !== true)
      .map((item) => fromFirestore(item.id, item.data()))
      .sort((left, right) => left.symbol.localeCompare(right.symbol));
    onNext(trades);
  };

  const unsubscribeTrades = onSnapshot(
    tradesCollection(user),
    (snapshot) => {
      latestTradeDocs = snapshot.docs;
      emitVisibleTrades();
    },
    onError,
  );

  return () => {
    unsubscribeTrades();
  };
};

export const saveUserTrade = async (user: User, trade: TrackedTrade) => {
  const db = requireDb();
  const normalizedTrade = stripDerivedMarketData(normalizeTrade(trade));
  const ref = tradeDoc(user, normalizedTrade.id);
  const batch = writeBatch(db);

  batch.set(ref, { ...toFirestore(normalizedTrade), isDeleted: false });
  batch.delete(deletedTradeDoc(user, normalizedTrade.id));
  batch.delete(deletedSymbolDoc(user, normalizedTrade.symbol));

  await batch.commit();
  await waitForPendingWrites(db);

  const savedSnapshot = await getDocFromServer(ref);
  if (!savedSnapshot.exists()) {
    throw new Error(`Firestore did not confirm saving ${normalizedTrade.symbol} at ${tradePath(user, normalizedTrade.id)}.`);
  }
  if (savedSnapshot.data().isDeleted === true) {
    throw new Error(`${normalizedTrade.symbol} was saved but is still marked deleted in Firestore.`);
  }

  return normalizedTrade;
};

export const deleteUserTrade = async (user: User, trade: TrackedTrade): Promise<DeleteTradeResult> => {
  const db = requireDb();
  const symbol = trade.symbol.trim().toUpperCase();
  const id = trade.id;
  const path = tradePath(user, id);
  const ref = tradeDoc(user, id);

  console.info("Deleting trade from Firestore", {
    uid: user.uid,
    symbol,
    id,
    path,
  });

  try {
    const beforeSnapshot = await getDocFromServer(ref);
    await deleteDoc(ref);
    await waitForPendingWrites(db);

    const afterSnapshot = await getDocFromServer(ref);
    if (afterSnapshot.exists()) {
      throw new Error(`Firestore delete did not remove ${path}. The document still exists after deleteDoc resolved.`);
    }

    const refreshedTrades = await getDocsFromServer(tradesCollection(user));
    const remainingSameSymbolIds = refreshedTrades.docs
      .filter((item) => String(item.data().symbol ?? "").trim().toUpperCase() === symbol)
      .map((item) => item.id);

    console.info("Firestore trade delete verified", {
      uid: user.uid,
      symbol,
      id,
      path,
      existedBeforeDelete: beforeSnapshot.exists(),
      remainingSameSymbolIds,
    });

    return {
      symbol,
      id,
      path,
      existedBeforeDelete: beforeSnapshot.exists(),
      remainingSameSymbolIds,
    };
  } catch (error) {
    console.error("Failed to delete trade from Firestore", {
      uid: user.uid,
      symbol,
      id,
      path,
      error,
    });
    throw error instanceof Error ? error : new Error(`Failed to delete ${path}.`);
  }
};

export const importUserTrades = async (user: User, trades: TrackedTrade[]) => {
  const batch = writeBatch(requireDb());
  const normalizedTrades = trades.map((trade) => stripDerivedMarketData(normalizeTrade(trade)));

  for (const trade of normalizedTrades) {
    batch.set(tradeDoc(user, trade.id), { ...toFirestore(trade), isDeleted: false, createdAt: serverTimestamp() });
    batch.delete(deletedTradeDoc(user, trade.id));
    batch.delete(deletedSymbolDoc(user, trade.symbol));
  }

  await batch.commit();
  await waitForPendingWrites(requireDb());
  return normalizedTrades;
};

export const replaceUserTrades = async (user: User, trades: TrackedTrade[]) => {
  const existingTrades = await getDocs(tradesCollection(user));
  const batch = writeBatch(requireDb());
  const normalizedTrades = trades.map((trade) => stripDerivedMarketData(normalizeTrade(trade)));

  for (const item of existingTrades.docs) {
    batch.delete(item.ref);
  }

  for (const trade of normalizedTrades) {
    batch.set(tradeDoc(user, trade.id), { ...toFirestore(trade), isDeleted: false });
    batch.delete(deletedTradeDoc(user, trade.id));
    batch.delete(deletedSymbolDoc(user, trade.symbol));
  }

  await batch.commit();
  await waitForPendingWrites(requireDb());
  return normalizedTrades;
};
