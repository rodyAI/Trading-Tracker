import {
  collection,
  deleteField,
  doc,
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
import { firebaseProjectId, requireDb, type User } from "../firebase/client";
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

const firestoreDocumentUrl = (user: User, collectionName: string, documentId: string) =>
  `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}/databases/(default)/documents/users/${encodeURIComponent(
    user.uid,
  )}/${collectionName}/${encodeURIComponent(documentId)}`;

const deleteDocumentViaRest = async (user: User, collectionName: string, documentId: string, idToken: string) => {
  const response = await fetch(firestoreDocumentUrl(user, collectionName, documentId), {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  });

  if (response.ok || response.status === 404) return;
  throw new Error(`REST delete failed for ${collectionName}/${documentId}: ${response.status} ${await response.text()}`);
};

const setDocumentViaRest = async (
  user: User,
  collectionName: string,
  documentId: string,
  idToken: string,
  fields: Record<string, unknown>,
) => {
  const response = await fetch(firestoreDocumentUrl(user, collectionName, documentId), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  if (response.ok) return;
  throw new Error(`REST write failed for ${collectionName}/${documentId}: ${response.status} ${await response.text()}`);
};

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
  matchedIds: string[];
  remainingIds: string[];
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

export const deleteUserTrade = async (user: User, trade: TrackedTrade): Promise<DeleteTradeResult> => {
  const db = requireDb();
  const symbol = trade.symbol.trim().toUpperCase();
  const matchingTradeDocs = (await getDocsFromServer(tradesCollection(user))).docs.filter(
    (item) => String(item.data().symbol ?? "").trim().toUpperCase() === symbol,
  );
  const matchedIds = matchingTradeDocs.map((item) => item.id);
  const idToken = await user.getIdToken(true);
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
    batch.delete(item.ref);
  }

  await batch.commit();
  await waitForPendingWrites(db);

  await setDocumentViaRest(user, "deletedSymbols", symbol, idToken, {
    symbol: { stringValue: symbol },
  });
  await Promise.all(
    matchingTradeDocs.flatMap((item) => [
      setDocumentViaRest(user, "deletedTrades", item.id, idToken, {
        id: { stringValue: item.id },
        symbol: { stringValue: symbol },
      }),
      deleteDocumentViaRest(user, "trades", item.id, idToken),
    ]),
  );

  const refreshedTrades = await getDocsFromServer(tradesCollection(user));

  const remainingIds = refreshedTrades.docs
    .filter((item) => {
    const data = item.data();
    return String(data.symbol ?? "").trim().toUpperCase() === symbol;
    })
    .map((item) => item.id);

  if (remainingIds.length > 0) {
    throw new Error(`${symbol} still exists in Firestore after delete. Remaining document ids: ${remainingIds.join(", ")}.`);
  }

  return { symbol, matchedIds, remainingIds };
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
