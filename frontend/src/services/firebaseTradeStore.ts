import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocFromServer,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  waitForPendingWrites,
  writeBatch,
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
): Unsubscribe =>
  onSnapshot(
    tradesCollection(user),
    (snapshot) => {
      const staleDocs = snapshot.docs.filter((item) => hasDerivedMarketData(item.data()));
      if (staleDocs.length > 0) {
        void Promise.all(staleDocs.map((item) => setDoc(item.ref, derivedMarketDataDeletes(), { merge: true }))).catch(
          (error) => {
            onError(error instanceof Error ? error : new Error("Failed to clear stale derived market data from Firestore."));
          },
        );
      }

      const trades = snapshot.docs
        .map((item) => fromFirestore(item.id, item.data()))
        .sort((left, right) => left.symbol.localeCompare(right.symbol));
      onNext(trades);
    },
    onError,
  );

export const saveUserTrade = async (user: User, trade: TrackedTrade) => {
  const db = requireDb();
  await setDoc(tradeDoc(user, trade.id), toFirestore(trade));
  await waitForPendingWrites(db);
  return stripDerivedMarketData(normalizeTrade(trade));
};

export const deleteUserTrade = async (user: User, id: string) => {
  const db = requireDb();
  const ref = tradeDoc(user, id);
  await deleteDoc(ref);
  await waitForPendingWrites(db);

  const snapshot = await getDocFromServer(ref);
  if (snapshot.exists()) {
    throw new Error("Trade delete did not reach Firestore. Please try again.");
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
