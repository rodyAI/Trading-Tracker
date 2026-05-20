import {
  collection,
  deleteField,
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
const deletedTradesCollection = (user: User) => collection(requireDb(), "users", user.uid, "deletedTrades");
const deletedTradeDoc = (user: User, id: string) => doc(requireDb(), "users", user.uid, "deletedTrades", id);
const deletedSymbolsCollection = (user: User) => collection(requireDb(), "users", user.uid, "deletedSymbols");
const deletedSymbolDoc = (user: User, symbol: string) => doc(requireDb(), "users", user.uid, "deletedSymbols", symbol);
const diagnosticsDoc = (user: User) => doc(requireDb(), "users", user.uid, "diagnostics", "writeProbe");

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
  writeProbe: {
    requestedId: string;
    confirmed: boolean;
    readBackId: string;
  };
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

const runWriteProbe = async (user: User) => {
  const db = requireDb();
  const requestedId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ref = diagnosticsDoc(user);

  await setDoc(ref, {
    requestedId,
    uid: user.uid,
    updatedAt: serverTimestamp(),
  });
  await waitForPendingWrites(db);

  const snapshot = await getDocFromServer(ref);
  const readBackId = snapshot.exists() && typeof snapshot.data().requestedId === "string" ? snapshot.data().requestedId : "";

  return {
    requestedId,
    confirmed: readBackId === requestedId,
    readBackId,
  };
};

export const loadTradePersistenceDiagnostics = async (user: User): Promise<TradePersistenceDiagnostics> => {
  const [writeProbe, tradeSnapshot, deletedSnapshot, deletedSymbolSnapshot] = await Promise.all([
    runWriteProbe(user),
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
    writeProbe,
    rawTrades,
    deletedTradeIds: [...deletedTradeIds].sort(),
    deletedSymbols: [...deletedSymbols].sort(),
    visibleTradeIds: rawTrades
      .filter((trade) => !trade.isDeleted && !trade.hasDeletedMarker)
      .map((trade) => trade.id)
      .sort(),
  };
};

export const loadUserTradesFromServer = async (user: User) => {
  const [tradeSnapshot, deletedSnapshot, deletedSymbolSnapshot] = await Promise.all([
    getDocsFromServer(tradesCollection(user)),
    getDocsFromServer(deletedTradesCollection(user)),
    getDocsFromServer(deletedSymbolsCollection(user)),
  ]);
  const deletedTradeIds = new Set(deletedSnapshot.docs.map((item) => item.id));
  const deletedSymbols = new Set(deletedSymbolSnapshot.docs.map((item) => item.id.toUpperCase()));

  return tradeSnapshot.docs
    .filter((item) => {
      const data = item.data();
      const symbol = typeof data.symbol === "string" ? data.symbol.toUpperCase() : "";
      return data.isDeleted !== true && !deletedTradeIds.has(item.id) && !deletedSymbols.has(symbol);
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
  const symbol = trade.symbol.trim().toUpperCase();
  const matchingTradeDocs = (await getDocsFromServer(tradesCollection(user))).docs.filter(
    (item) => String(item.data().symbol ?? "").trim().toUpperCase() === symbol,
  );
  const batch = writeBatch(db);

  batch.set(deletedSymbolDoc(user, symbol), {
    symbol,
    deletedAt: serverTimestamp(),
  });

  for (const item of matchingTradeDocs) {
    batch.set(deletedTradeDoc(user, item.id), {
      id: item.id,
      symbol,
      deletedAt: serverTimestamp(),
    });
    batch.set(
      item.ref,
      {
        ...toFirestore({
          ...fromFirestore(item.id, item.data()),
          isDeleted: true,
        }),
        isDeleted: true,
        deletedAt: serverTimestamp(),
      },
    );
  }

  await batch.commit();
  await waitForPendingWrites(db);

  const [symbolSnapshot, refreshedTrades] = await Promise.all([
    getDocFromServer(deletedSymbolDoc(user, symbol)),
    getDocsFromServer(tradesCollection(user)),
  ]);

  const stillVisible = refreshedTrades.docs.some((item) => {
    const data = item.data();
    return String(data.symbol ?? "").trim().toUpperCase() === symbol && data.isDeleted !== true;
  });

  if (!symbolSnapshot.exists() || stillVisible) {
    throw new Error("Firestore did not confirm the delete marker. Please try again.");
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
