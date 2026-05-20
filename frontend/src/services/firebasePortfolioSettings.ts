import { doc, getDocFromServer, onSnapshot, serverTimestamp, setDoc, waitForPendingWrites, type Unsubscribe } from "firebase/firestore";
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

const sameCategories = (left: TradeCategory[], right: TradeCategory[]) => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((category) => rightSet.has(category));
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
  const db = requireDb();
  const ref = settingsDoc(user);
  await setDoc(
    ref,
    {
      excludedCategories: settings.excludedCategories,
      updatedAt: serverTimestamp(),
    }
  );
  await waitForPendingWrites(db);

  const snapshot = await getDocFromServer(ref);
  if (!snapshot.exists()) throw new Error("Portfolio settings were not found after saving.");
  const savedSettings = normalizeSettings(snapshot.data());
  if (!sameCategories(savedSettings.excludedCategories, settings.excludedCategories)) {
    throw new Error("Firestore did not confirm the portfolio settings update. Please try again.");
  }
  return { ...savedSettings, exists: true };
};

export const loadPortfolioSettingsFromServer = async (user: User) => {
  const snapshot = await getDocFromServer(settingsDoc(user));
  return snapshot.exists() ? { ...normalizeSettings(snapshot.data()), exists: true } : defaultSettings;
};
