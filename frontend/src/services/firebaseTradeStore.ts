import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocs,
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
const deletedTradesCollection = (user: User) => collection(requireDb(), "users", user.uid, "deletedTrades");
const deletedTradeDoc = (user: User, id: string) => doc(requireDb(), "users", user.uid, "deletedTrades", id);

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

export const subscribeToUserTrades = (
  user: User,
  onNext: (trades: TrackedTrade[]) => void,
  onError: (error: Error) => void,
): Unsubscribe => {
  let latestTradeDocs: QueryDocumentSnapshot<DocumentData>[] | null = null;
  let latestDeletedTradeIds: Set<string> | null = null;

  const emitVisibleTrades = () => {
    if (!latestTradeDocs || !latestDeletedTradeIds) return;

    const staleDocs = latestTradeDocs.filter(
      (item) =>
        item &&
        item.data().isDeleted !== true &&
        !latestDeletedTradeIds?.has(item.id) &&
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
      .filter((item) => item && item.data().isDeleted !== true && !latestDeletedTradeIds?.has(item.id))
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

  const unsubscribeDeletedTrades = onSnapshot(
    deletedTradesCollection(user),
    (snapshot) => {
      latestDeletedTradeIds = new Set(snapshot.docs.map((item) => item.id));
      emitVisibleTrades();
    },
    onError,
  );

  return () => {
    unsubscribeTrades();
    unsubscribeDeletedTrades();
  };
};

export const saveUserTrade = async (user: User, trade: TrackedTrade) => {
  const db = requireDb();
  await setDoc(tradeDoc(user, trade.id), toFirestore(trade));
  await waitForPendingWrites(db);
  return stripDerivedMarketData(normalizeTrade(trade));
};

export const deleteUserTrade = async (user: User, trade: TrackedTrade) => {
  const db = requireDb();
  const ref = tradeDoc(user, trade.id);
  const deletedRef = deletedTradeDoc(user, trade.id);

  await setDoc(deletedRef, {
    id: trade.id,
    symbol: trade.symbol,
    deletedAt: serverTimestamp(),
  });
  await setDoc(ref, {
    ...toFirestore({
      ...trade,
      isDeleted: true,
    }),
    isDeleted: true,
    deletedAt: serverTimestamp(),
  });
  await waitForPendingWrites(db);

  try {
    await deleteDoc(ref);
    await waitForPendingWrites(db);
  } catch {
    return;
  }
};

export const importUserTrades = async (user: User, trades: TrackedTrade[]) => {
  const batch = writeBatch(requireDb());
  const normalizedTrades = trades.map((trade) => stripDerivedMarketData(normalizeTrade(trade)));

  for (const trade of normalizedTrades) {
    batch.set(tradeDoc(user, trade.id), { ...toFirestore(trade), createdAt: serverTimestamp() });
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
    batch.set(tradeDoc(user, trade.id), toFirestore(trade));
  }

  await batch.commit();
  await waitForPendingWrites(requireDb());
  return normalizedTrades;
};
