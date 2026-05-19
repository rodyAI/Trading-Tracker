import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
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
});

const tradesCollection = (user: User) => collection(requireDb(), "users", user.uid, "trades");
const tradeDoc = (user: User, id: string) => doc(requireDb(), "users", user.uid, "trades", id);

const fromFirestore = (id: string, data: Record<string, unknown>): TrackedTrade => {
  const trade = normalizeTrade({
    ...(data as Omit<TrackedTrade, "id">),
    id,
  });

  return {
    ...trade,
    quantity: Number(trade.quantity),
    entryPrice: Number(trade.entryPrice),
  };
};

const toFirestore = (trade: TrackedTrade) => ({
  ...normalizeTrade(trade),
  updatedAt: serverTimestamp(),
});

export const subscribeToUserTrades = (
  user: User,
  onNext: (trades: TrackedTrade[]) => void,
  onError: (error: Error) => void,
): Unsubscribe =>
  onSnapshot(
    tradesCollection(user),
    (snapshot) => {
      const trades = snapshot.docs
        .map((item) => fromFirestore(item.id, item.data()))
        .sort((left, right) => left.symbol.localeCompare(right.symbol));
      onNext(trades);
    },
    onError,
  );

export const saveUserTrade = async (user: User, trade: TrackedTrade) => {
  await setDoc(tradeDoc(user, trade.id), toFirestore(trade), { merge: true });
  return normalizeTrade(trade);
};

export const deleteUserTrade = (user: User, id: string) => deleteDoc(tradeDoc(user, id));

export const importUserTrades = async (user: User, trades: TrackedTrade[]) => {
  const batch = writeBatch(requireDb());
  const normalizedTrades = trades.map(normalizeTrade);

  for (const trade of normalizedTrades) {
    batch.set(tradeDoc(user, trade.id), { ...toFirestore(trade), createdAt: serverTimestamp() });
  }

  await batch.commit();
  return normalizedTrades;
};

export const replaceUserTrades = async (user: User, trades: TrackedTrade[]) => {
  const existingTrades = await getDocs(tradesCollection(user));
  const batch = writeBatch(requireDb());
  const normalizedTrades = trades.map(normalizeTrade);

  for (const item of existingTrades.docs) {
    batch.delete(item.ref);
  }

  for (const trade of normalizedTrades) {
    batch.set(tradeDoc(user, trade.id), toFirestore(trade));
  }

  await batch.commit();
  return normalizedTrades;
};
