import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  onSnapshot,
  serverTimestamp,
  setDoc,
  waitForPendingWrites,
  writeBatch,
  type Unsubscribe,
} from "firebase/firestore";
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
const excludedCategoriesCollection = (user: User) => collection(requireDb(), "users", user.uid, "excludedPortfolioCategories");
const excludedCategoryDoc = (user: User, category: TradeCategory) =>
  doc(requireDb(), "users", user.uid, "excludedPortfolioCategories", category);

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
  const excludedSet = new Set(settings.excludedCategories);
  const batch = writeBatch(db);

  batch.set(ref, {
    excludedCategories: settings.excludedCategories,
    updatedAt: serverTimestamp(),
  });

  for (const category of TRADE_CATEGORIES) {
    if (excludedSet.has(category)) {
      batch.set(excludedCategoryDoc(user, category), {
        category,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.delete(excludedCategoryDoc(user, category));
    }
  }

  await batch.commit();
  await waitForPendingWrites(db);

  const savedSettings = await loadPortfolioSettingsFromServer(user);
  if (!sameCategories(savedSettings.excludedCategories, settings.excludedCategories)) {
    throw new Error("Firestore did not confirm the portfolio settings update. Please try again.");
  }
  return savedSettings;
};

export const loadPortfolioSettingsFromServer = async (user: User) => {
  const [settingsSnapshot, excludedSnapshot] = await Promise.all([
    getDocFromServer(settingsDoc(user)),
    getDocsFromServer(excludedCategoriesCollection(user)),
  ]);
  const settingsCategories = settingsSnapshot.exists() ? normalizeSettings(settingsSnapshot.data()).excludedCategories : [];
  const ledgerCategories = excludedSnapshot.docs
    .map((item) => item.data().category)
    .filter((category): category is TradeCategory => TRADE_CATEGORIES.includes(category as TradeCategory));
  const excludedCategories = [...new Set([...settingsCategories, ...ledgerCategories])];

  return settingsSnapshot.exists() || excludedSnapshot.docs.length > 0
    ? { excludedCategories, exists: true }
    : defaultSettings;
};
