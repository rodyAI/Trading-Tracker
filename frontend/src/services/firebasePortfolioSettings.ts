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

export type CategoryLabels = Record<string, string>;

export interface PortfolioSettings {
  excludedCategories: TradeCategory[];
  enabledCategories: TradeCategory[];
  availableCategories: TradeCategory[];
  categoryLabels: CategoryLabels;
  exists?: boolean;
}

export const defaultCategoryLabels = TRADE_CATEGORIES.reduce(
  (labels, category) => ({ ...labels, [category]: category }),
  {} as CategoryLabels,
);

const defaultSettings: PortfolioSettings = {
  excludedCategories: [],
  enabledCategories: [...TRADE_CATEGORIES],
  availableCategories: [...TRADE_CATEGORIES],
  categoryLabels: defaultCategoryLabels,
  exists: false,
};

const settingsDoc = (user: User) => doc(requireDb(), "users", user.uid, "settings", "portfolioTotals");
const excludedCategoriesCollection = (user: User) => collection(requireDb(), "users", user.uid, "excludedPortfolioCategories");
const excludedCategoryDoc = (user: User, category: TradeCategory) =>
  doc(requireDb(), "users", user.uid, "excludedPortfolioCategories", encodeURIComponent(category));

const normalizeCategoryName = (category: unknown) =>
  typeof category === "string" ? category.trim().replace(/\s+/g, " ") : "";

const uniqueCategories = (categories: readonly unknown[]) => {
  const seen = new Set<string>();
  return categories
    .map(normalizeCategoryName)
    .filter((category) => {
      if (!category || seen.has(category)) return false;
      seen.add(category);
      return true;
    });
};

const normalizeSettings = (data: Record<string, unknown> | undefined): PortfolioSettings => {
  const rawCategories = Array.isArray(data?.excludedCategories) ? data.excludedCategories : [];
  const rawEnabledCategories = Array.isArray(data?.enabledCategories) ? data.enabledCategories : TRADE_CATEGORIES;
  const rawAvailableCategories = Array.isArray(data?.availableCategories) ? data.availableCategories : TRADE_CATEGORIES;
  const rawCategoryLabels =
    data?.categoryLabels && typeof data.categoryLabels === "object"
      ? data.categoryLabels as Record<string, unknown>
      : {};
  const enabledCategories = uniqueCategories(rawEnabledCategories);
  const availableCategories = uniqueCategories([
    ...TRADE_CATEGORIES,
    ...rawAvailableCategories,
    ...enabledCategories,
    ...Object.keys(rawCategoryLabels),
  ]);
  const knownCategories = uniqueCategories([...TRADE_CATEGORIES, ...availableCategories, ...enabledCategories]);
  const categoryLabels = knownCategories.reduce((labels, category) => {
    const rawLabel = rawCategoryLabels[category];
    const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
    return {
      ...labels,
      [category]: label || category,
    };
  }, {} as CategoryLabels);

  return {
    excludedCategories: uniqueCategories(rawCategories),
    enabledCategories: enabledCategories.length > 0 ? enabledCategories : [...TRADE_CATEGORIES],
    availableCategories,
    categoryLabels,
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
  const enabledCategories = uniqueCategories(settings.enabledCategories).length > 0
    ? uniqueCategories(settings.enabledCategories)
    : [...TRADE_CATEGORIES];
  const enabledSet = new Set(enabledCategories);
  const excludedCategories = uniqueCategories(settings.excludedCategories).filter((category) => enabledSet.has(category));
  const excludedSet = new Set(excludedCategories);
  const availableCategories = uniqueCategories([
    ...TRADE_CATEGORIES,
    ...settings.availableCategories,
    ...enabledCategories,
    ...Object.keys(settings.categoryLabels ?? {}),
  ]);
  const knownCategories = uniqueCategories([...TRADE_CATEGORIES, ...availableCategories, ...enabledCategories]);
  const categoryLabels = knownCategories.reduce((labels, category) => {
    const label = settings.categoryLabels?.[category]?.trim() || category;
    return { ...labels, [category]: label };
  }, {} as CategoryLabels);
  const batch = writeBatch(db);

  batch.set(ref, {
    excludedCategories,
    enabledCategories,
    availableCategories,
    categoryLabels,
    updatedAt: serverTimestamp(),
  });

  for (const category of knownCategories) {
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
    !sameCategories(savedSettings.enabledCategories, enabledCategories) ||
    !sameCategories(savedSettings.availableCategories, availableCategories) ||
    knownCategories.some((category) => savedSettings.categoryLabels[category] !== categoryLabels[category])
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
  const availableCategories = settingsSnapshot.exists() ? normalizeSettings(settingsSnapshot.data()).availableCategories : [...TRADE_CATEGORIES];
  const categoryLabels = settingsSnapshot.exists() ? normalizeSettings(settingsSnapshot.data()).categoryLabels : defaultCategoryLabels;
  const ledgerCategories = excludedSnapshot.docs
    .map((item) => item.data().category)
    .map(normalizeCategoryName)
    .filter(Boolean);
  const excludedCategories = [...new Set([...settingsCategories, ...ledgerCategories])];

  return settingsSnapshot.exists() || excludedSnapshot.docs.length > 0
    ? { excludedCategories, enabledCategories, availableCategories, categoryLabels, exists: true }
    : defaultSettings;
};
