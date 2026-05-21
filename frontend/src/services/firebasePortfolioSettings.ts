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
  enabledCategories: TradeCategory[];
  exists?: boolean;
}

const defaultSettings: PortfolioSettings = {
  excludedCategories: [],
  enabledCategories: [...TRADE_CATEGORIES],
  exists: false,
};

const settingsDoc = (user: User) => doc(requireDb(), "users", user.uid, "settings", "portfolioTotals");
const excludedCategoriesCollection = (user: User) => collection(requireDb(), "users", user.uid, "excludedPortfolioCategories");
const excludedCategoryDoc = (user: User, category: TradeCategory) =>
  doc(requireDb(), "users", user.uid, "excludedPortfolioCategories", category);

const normalizeSettings = (data: Record<string, unknown> | undefined): PortfolioSettings => {
  const rawCategories = Array.isArray(data?.excludedCategories) ? data.excludedCategories : [];
  const rawEnabledCategories = Array.isArray(data?.enabledCategories) ? data.enabledCategories : TRADE_CATEGORIES;
  const enabledCategories = rawEnabledCategories.filter((category): category is TradeCategory =>
    TRADE_CATEGORIES.includes(category as TradeCategory),
  );

  return {
    excludedCategories: rawCategories.filter((category): category is TradeCategory =>
      TRADE_CATEGORIES.includes(category as TradeCategory),
    ),
    enabledCategories: enabledCategories.length > 0 ? enabledCategories : [...TRADE_CATEGORIES],
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
  const enabledCategories = settings.enabledCategories.length > 0 ? settings.enabledCategories : [...TRADE_CATEGORIES];
  const enabledSet = new Set(enabledCategories);
  const excludedCategories = settings.excludedCategories.filter((category) => enabledSet.has(category));
  const excludedSet = new Set(excludedCategories);
  const batch = writeBatch(db);

  batch.set(ref, {
    excludedCategories,
    enabledCategories,
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
  if (
    !sameCategories(savedSettings.excludedCategories, excludedCategories) ||
    !sameCategories(savedSettings.enabledCategories, enabledCategories)
  ) {
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
  const enabledCategories = settingsSnapshot.exists() ? normalizeSettings(settingsSnapshot.data()).enabledCategories : [...TRADE_CATEGORIES];
  const ledgerCategories = excludedSnapshot.docs
    .map((item) => item.data().category)
    .filter((category): category is TradeCategory => TRADE_CATEGORIES.includes(category as TradeCategory));
  const excludedCategories = [...new Set([...settingsCategories, ...ledgerCategories])];

  return settingsSnapshot.exists() || excludedSnapshot.docs.length > 0
    ? { excludedCategories, enabledCategories, exists: true }
    : defaultSettings;
};
