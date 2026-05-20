import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, type Unsubscribe } from "firebase/firestore";
import { requireDb, type User } from "../firebase/client";
import { TRADE_CATEGORIES, type TradeCategory } from "../utils/tradeCalculations";

export interface PortfolioSettings {
  excludedCategories: TradeCategory[];
  exists?: boolean;
}

const defaultSettings: PortfolioSettings = {
  excludedCategories: [],
  exists: false,
};

const settingsDoc = (user: User) => doc(requireDb(), "users", user.uid, "settings", "portfolioTotals");

const normalizeSettings = (data: Record<string, unknown> | undefined): PortfolioSettings => {
  const rawCategories = Array.isArray(data?.excludedCategories) ? data.excludedCategories : [];
  return {
    excludedCategories: rawCategories.filter((category): category is TradeCategory =>
      TRADE_CATEGORIES.includes(category as TradeCategory),
    ),
  };
};

export const subscribeToPortfolioSettings = (
  user: User,
  onNext: (settings: PortfolioSettings) => void,
  onError: (error: Error) => void,
): Unsubscribe =>
  onSnapshot(
    settingsDoc(user),
    (snapshot) => {
      onNext(snapshot.exists() ? { ...normalizeSettings(snapshot.data()), exists: true } : defaultSettings);
    },
    onError,
  );

export const savePortfolioSettings = async (user: User, settings: PortfolioSettings) => {
  await setDoc(
    settingsDoc(user),
    {
      excludedCategories: settings.excludedCategories,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  const snapshot = await getDoc(settingsDoc(user));
  if (!snapshot.exists()) throw new Error("Portfolio settings were not found after saving.");
  return { ...normalizeSettings(snapshot.data()), exists: true };
};
