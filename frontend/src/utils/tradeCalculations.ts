import type { MarketCandle } from "@shared/types";

export type TradeStatus = "Open" | "Closed" | "Stop loss hit" | "Take profit hit" | "In profit" | "In loss";
export const TRADE_CATEGORIES = ["Swing", "Long trades", "Value investing", "Magic formula"] as const;
export type TradeCategory = string;

export interface TradeEntryLot {
  id: string;
  quantity: number;
  price: number;
  stopLoss?: number | null;
  takeProfitLevels?: number[];
  date?: string;
}

export type SellAllocationMethod = "oldest" | "newest" | "manual";

export interface TradeExitAllocation {
  entryId: string;
  quantity: number;
}

export interface TradeExitLot {
  id: string;
  quantity: number;
  price: number;
  allocationMethod?: SellAllocationMethod;
  allocations?: TradeExitAllocation[];
  date?: string;
}

export interface TrackedTrade {
  id: string;
  category?: TradeCategory;
  symbol: string;
  quantity: number;
  entryPrice: number;
  entries?: TradeEntryLot[];
  stopLoss?: number | null;
  takeProfit?: number | null;
  takeProfitLevels?: number[];
  notes?: string;
  entryDate?: string;
  tags?: string[];
  isClosed?: boolean;
  exitPrice?: number | null;
  exitDate?: string;
  exitLots?: TradeExitLot[];
  excludeFromPortfolioTotals?: boolean;
  isDeleted?: boolean;
  deletedAt?: unknown;
  currentPrice?: number | null;
  currentPriceAsOf?: number | null;
  currentPriceProvider?: string | null;
  priceError?: string | null;
  recommendedTakeProfit?: number | null;
  recommendationExplanation?: string;
  chartCandles?: MarketCandle[];
}

export interface TradeFormValues {
  id?: string;
  category: TradeCategory;
  symbol: string;
  quantity: string;
  entryPrice: string;
  stopLoss: string;
  takeProfit: string;
  notes: string;
  entryDate: string;
  tags: string;
  excludeFromPortfolioTotals: boolean;
}

export interface ValidationResult {
  values?: Omit<TrackedTrade, "id">;
  errors: Partial<Record<keyof TradeFormValues, string>>;
}

export interface TakeProfitRecommendation {
  price: number;
  explanation: string;
  atr?: number | null;
  resistance?: number | null;
  rewardRiskRatio?: number | null;
}

export interface TradePositionBreakdown {
  totalEntryQuantity: number;
  totalEntryCost: number;
  totalSoldQuantity: number;
  totalSoldProceeds: number;
  soldCostBasis: number;
  realizedProfitLoss: number;
  openQuantity: number;
  openCostBasis: number;
  averageEntryPrice: number | null;
  averageOpenEntryPrice: number | null;
  openEntryLots: Array<TradeEntryLot & { remainingQuantity: number }>;
}

export type RiskManagementDirection = "long" | "short";

export interface RiskManagementFormValues {
  direction: RiskManagementDirection;
  portfolioValue: string;
  desiredRiskAmount: string;
  entryPrice: string;
  targetPrice: string;
  stopLossPrice: string;
}

export interface RiskManagementResult {
  quantity: number;
  riskPerShare: number;
  rewardPerShare: number | null;
  actualRiskAmount: number;
  potentialRewardAmount: number | null;
  rewardRiskRatio: number | null;
  investmentAmount: number;
  portfolioRiskPercent: number;
  portfolioAllocationPercent: number;
  exceedsPortfolioValue: boolean;
}

export interface RiskManagementValidationResult {
  result?: RiskManagementResult;
  errors: Partial<Record<keyof RiskManagementFormValues, string>>;
}

export const toNumber = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const roundPrice = (value: number) => Math.round(value * 100) / 100;

export const calculateProfitLossDollars = (currentPrice: number, entryPrice: number, quantity: number) =>
  (currentPrice - entryPrice) * quantity;

export const calculateProfitLossPercent = (currentPrice: number, entryPrice: number) =>
  ((currentPrice - entryPrice) / entryPrice) * 100;

export const calculateRiskAmount = (entryPrice: number, stopLoss: number | null | undefined, quantity: number) =>
  stopLoss == null ? null : (entryPrice - stopLoss) * quantity;

export const calculateRewardAmount = (entryPrice: number, takeProfit: number | null | undefined, quantity: number) =>
  takeProfit == null ? null : (takeProfit - entryPrice) * quantity;

export const calculateRiskRewardRatio = (riskAmount: number | null, rewardAmount: number | null) => {
  if (riskAmount == null || rewardAmount == null || riskAmount <= 0) return null;
  return rewardAmount / riskAmount;
};

const normalizeLotQuantity = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const normalizeLotPrice = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const normalizeTakeProfitLevelValues = (levels: unknown) =>
  Array.isArray(levels)
    ? levels
        .map((level) => normalizeLotPrice(level))
        .filter((level): level is number => level != null)
    : [];

const normalizeStopLossValue = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const getTradeEntryLots = (
  trade: Pick<TrackedTrade, "entries" | "quantity" | "entryPrice" | "entryDate">,
): TradeEntryLot[] => {
  const normalizedEntries = Array.isArray(trade.entries)
    ? trade.entries
        .map((entry, index): TradeEntryLot | null => {
          const quantity = normalizeLotQuantity(entry.quantity);
          const price = normalizeLotPrice(entry.price);
          if (quantity == null || price == null) return null;
          return {
            id: entry.id || `entry-${index}`,
            quantity,
            price,
            stopLoss: normalizeStopLossValue(entry.stopLoss),
            takeProfitLevels: normalizeTakeProfitLevelValues(entry.takeProfitLevels),
            date: entry.date ?? "",
          };
        })
        .filter((entry): entry is TradeEntryLot => entry != null)
    : [];

  if (normalizedEntries.length > 0) return normalizedEntries;

  const quantity = normalizeLotQuantity(trade.quantity);
  const price = normalizeLotPrice(trade.entryPrice);
  if (quantity == null || price == null) return [];
  return [{ id: "entry-legacy", quantity, price, date: trade.entryDate ?? "" }];
};

export const getTradeExitLots = (
  trade: Pick<TrackedTrade, "exitLots" | "isClosed" | "exitPrice" | "exitDate" | "quantity">,
): TradeExitLot[] => {
  const normalizedExits = Array.isArray(trade.exitLots)
    ? trade.exitLots
        .map((exit, index): TradeExitLot | null => {
          const quantity = normalizeLotQuantity(exit.quantity);
          const price = normalizeLotPrice(exit.price);
          if (quantity == null || price == null) return null;
          return {
            id: exit.id || `exit-${index}`,
            quantity,
            price,
            allocationMethod: exit.allocationMethod === "newest" || exit.allocationMethod === "manual" ? exit.allocationMethod : "oldest",
            allocations: Array.isArray(exit.allocations)
              ? exit.allocations
                  .map((allocation) => {
                    const allocationQuantity = normalizeLotQuantity(allocation.quantity);
                    return allocation.entryId && allocationQuantity != null
                      ? { entryId: allocation.entryId, quantity: allocationQuantity }
                      : null;
                  })
                  .filter((allocation): allocation is TradeExitAllocation => allocation != null)
              : [],
            date: exit.date ?? "",
          };
        })
        .filter((exit): exit is TradeExitLot => exit != null)
    : [];

  if (normalizedExits.length > 0) return normalizedExits;

  const quantity = normalizeLotQuantity(trade.quantity);
  const price = normalizeLotPrice(trade.exitPrice);
  if (!trade.isClosed || quantity == null || price == null) return [];
  return [{ id: "exit-legacy", quantity, price, allocationMethod: "oldest", allocations: [], date: trade.exitDate ?? "" }];
};

export const calculateTradePosition = (trade: TrackedTrade): TradePositionBreakdown => {
  const entries = getTradeEntryLots(trade);
  const exits = getTradeExitLots(trade);
  const remainingEntries = entries.map((entry) => ({
    ...entry,
    remainingQuantity: entry.quantity,
  }));
  let soldCostBasis = 0;
  let totalSoldQuantity = 0;
  let totalSoldProceeds = 0;

  for (const exit of exits) {
    let sharesToMatch = exit.quantity;
    totalSoldQuantity += exit.quantity;
    totalSoldProceeds += exit.quantity * exit.price;

    const matchAgainstEntry = (entry: (typeof remainingEntries)[number], requestedQuantity: number) => {
      if (requestedQuantity <= 0 || entry.remainingQuantity <= 0) return 0;
      const matchedQuantity = Math.min(entry.remainingQuantity, requestedQuantity);
      soldCostBasis += matchedQuantity * entry.price;
      entry.remainingQuantity -= matchedQuantity;
      return matchedQuantity;
    };

    if (exit.allocationMethod === "manual" && exit.allocations?.length) {
      for (const allocation of exit.allocations) {
        if (sharesToMatch <= 0) break;
        const entry = remainingEntries.find((candidate) => candidate.id === allocation.entryId);
        if (!entry) continue;
        const matchedQuantity = matchAgainstEntry(entry, Math.min(allocation.quantity, sharesToMatch));
        sharesToMatch -= matchedQuantity;
      }
    }

    const orderedEntries = exit.allocationMethod === "newest" ? [...remainingEntries].reverse() : remainingEntries;
    for (const entry of orderedEntries) {
      if (sharesToMatch <= 0) break;
      const matchedQuantity = matchAgainstEntry(entry, sharesToMatch);
      sharesToMatch -= matchedQuantity;
    }
  }

  const totalEntryQuantity = entries.reduce((sum, entry) => sum + entry.quantity, 0);
  const totalEntryCost = entries.reduce((sum, entry) => sum + entry.quantity * entry.price, 0);
  const openQuantity = remainingEntries.reduce((sum, entry) => sum + entry.remainingQuantity, 0);
  const openCostBasis = remainingEntries.reduce((sum, entry) => sum + entry.remainingQuantity * entry.price, 0);

  return {
    totalEntryQuantity,
    totalEntryCost,
    totalSoldQuantity,
    totalSoldProceeds,
    soldCostBasis,
    realizedProfitLoss: totalSoldProceeds - soldCostBasis,
    openQuantity,
    openCostBasis,
    averageEntryPrice: totalEntryQuantity > 0 ? totalEntryCost / totalEntryQuantity : null,
    averageOpenEntryPrice: openQuantity > 0 ? openCostBasis / openQuantity : null,
    openEntryLots: remainingEntries.filter((entry) => entry.remainingQuantity > 0),
  };
};

export const parseTakeProfitLevels = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(toNumber);

export const calculateRiskManagementPlan = (
  form: RiskManagementFormValues,
): RiskManagementValidationResult => {
  const portfolioValue = toNumber(form.portfolioValue);
  const desiredRiskAmount = toNumber(form.desiredRiskAmount);
  const entryPrice = toNumber(form.entryPrice);
  const targetPrice = form.targetPrice.trim() ? toNumber(form.targetPrice) : null;
  const stopLossPrice = toNumber(form.stopLossPrice);
  const errors: RiskManagementValidationResult["errors"] = {};

  if (portfolioValue == null || portfolioValue <= 0) errors.portfolioValue = "Portfolio value must be greater than 0.";
  if (desiredRiskAmount == null || desiredRiskAmount <= 0) {
    errors.desiredRiskAmount = "Desired risk amount must be greater than 0.";
  }
  if (entryPrice == null || entryPrice <= 0) errors.entryPrice = "Entry price must be greater than 0.";
  if (form.targetPrice.trim() && (targetPrice == null || targetPrice <= 0)) {
    errors.targetPrice = "Target price must be greater than 0 when provided.";
  }
  if (stopLossPrice == null || stopLossPrice <= 0) errors.stopLossPrice = "Stop loss price must be greater than 0.";

  if (entryPrice != null && targetPrice != null && form.direction === "long" && targetPrice <= entryPrice) {
    errors.targetPrice = "For a long trade, target price must be above entry.";
  }
  if (entryPrice != null && stopLossPrice != null && form.direction === "long" && stopLossPrice >= entryPrice) {
    errors.stopLossPrice = "For a long trade, stop loss must be below entry.";
  }
  if (entryPrice != null && targetPrice != null && form.direction === "short" && targetPrice >= entryPrice) {
    errors.targetPrice = "For a short trade, target price must be below entry.";
  }
  if (entryPrice != null && stopLossPrice != null && form.direction === "short" && stopLossPrice <= entryPrice) {
    errors.stopLossPrice = "For a short trade, stop loss must be above entry.";
  }

  if (
    Object.keys(errors).length > 0 ||
    portfolioValue == null ||
    desiredRiskAmount == null ||
    entryPrice == null ||
    stopLossPrice == null
  ) {
    return { errors };
  }

  const riskPerShare = Math.abs(entryPrice - stopLossPrice);
  const rewardPerShare = targetPrice == null ? null : Math.abs(targetPrice - entryPrice);
  const quantity = Math.floor(desiredRiskAmount / riskPerShare);

  if (quantity < 1) {
    return {
      errors: {
        desiredRiskAmount: "Desired risk is too small for one share at this stop distance.",
      },
    };
  }

  const actualRiskAmount = quantity * riskPerShare;
  const potentialRewardAmount = rewardPerShare == null ? null : quantity * rewardPerShare;
  const investmentAmount = quantity * entryPrice;

  return {
    errors,
    result: {
      quantity,
      riskPerShare,
      rewardPerShare,
      actualRiskAmount,
      potentialRewardAmount,
      rewardRiskRatio: rewardPerShare == null ? null : rewardPerShare / riskPerShare,
      investmentAmount,
      portfolioRiskPercent: (actualRiskAmount / portfolioValue) * 100,
      portfolioAllocationPercent: (investmentAmount / portfolioValue) * 100,
      exceedsPortfolioValue: investmentAmount > portfolioValue,
    },
  };
};

export const getTradeStatus = (
  trade: Pick<TrackedTrade, "entryPrice" | "stopLoss" | "takeProfit" | "currentPrice" | "isClosed">,
) => {
  if (trade.isClosed) return "Closed" satisfies TradeStatus;
  if (trade.currentPrice == null) return "Open" satisfies TradeStatus;
  if (trade.stopLoss != null && trade.currentPrice <= trade.stopLoss) return "Stop loss hit" satisfies TradeStatus;
  if (trade.takeProfit != null && trade.currentPrice >= trade.takeProfit) return "Take profit hit" satisfies TradeStatus;
  if (trade.currentPrice > trade.entryPrice) return "In profit" satisfies TradeStatus;
  if (trade.currentPrice < trade.entryPrice) return "In loss" satisfies TradeStatus;
  return "Open" satisfies TradeStatus;
};

export const getDistanceToTargetPercent = (currentPrice: number | null | undefined, target: number) => {
  if (currentPrice == null || target <= 0) return null;
  return Math.abs((currentPrice - target) / target) * 100;
};

export const isNearStopOrTarget = (trade: TrackedTrade) => {
  if (trade.currentPrice == null) return false;
  const stopDistance = trade.stopLoss != null ? getDistanceToTargetPercent(trade.currentPrice, trade.stopLoss) : null;
  const tpDistance = trade.takeProfit != null ? getDistanceToTargetPercent(trade.currentPrice, trade.takeProfit) : null;
  return (stopDistance != null && stopDistance <= 2) || (tpDistance != null && tpDistance <= 2);
};

export const validateTradeForm = (form: TradeFormValues): ValidationResult => {
  const symbol = form.symbol.trim().toUpperCase();
  const quantity = toNumber(form.quantity);
  const entryPrice = toNumber(form.entryPrice);
  const stopLoss = form.stopLoss.trim() ? toNumber(form.stopLoss) : null;
  const takeProfitLevels = parseTakeProfitLevels(form.takeProfit);
  const validTakeProfitLevels = takeProfitLevels.filter((level): level is number => level != null && level > 0);
  const takeProfit = validTakeProfitLevels[0] ?? null;
  const errors: ValidationResult["errors"] = {};

  if (!symbol) errors.symbol = "Ticker / symbol is required.";
  if (quantity == null || quantity <= 0) errors.quantity = "Quantity must be greater than 0.";
  if (entryPrice == null || entryPrice <= 0) errors.entryPrice = "Entry price must be greater than 0.";
  if (form.stopLoss.trim() && (stopLoss == null || stopLoss <= 0)) {
    errors.stopLoss = "Stop loss must be greater than 0 when provided.";
  }
  if (entryPrice != null && stopLoss != null && stopLoss >= entryPrice) {
    errors.stopLoss = "Stop loss must be lower than entry price for long trades.";
  }
  if (takeProfitLevels.some((level) => level == null || level <= 0)) {
    errors.takeProfit = "Take profit prices must be greater than 0.";
  }
  if (entryPrice != null && validTakeProfitLevels.some((level) => level <= entryPrice)) {
    errors.takeProfit = "Take profit prices must be higher than entry price.";
  }

  if (Object.keys(errors).length > 0 || quantity == null || entryPrice == null) {
    return { errors };
  }

  return {
    errors,
    values: {
      symbol,
      category: form.category,
      quantity,
      entryPrice,
      entries: [
        {
          id: "entry-initial",
          quantity,
          price: entryPrice,
          stopLoss,
          takeProfitLevels: validTakeProfitLevels,
          date: form.entryDate,
        },
      ],
      stopLoss,
      takeProfit,
      takeProfitLevels: validTakeProfitLevels,
      notes: form.notes.trim(),
      entryDate: form.entryDate,
      tags: form.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      excludeFromPortfolioTotals: form.excludeFromPortfolioTotals,
    },
  };
};

const average = (values: number[]) => {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

export const calculateAtr = (candles: MarketCandle[], period = 14) => {
  const orderedCandles = [...candles].sort((left, right) => left.date.localeCompare(right.date));
  if (orderedCandles.length < period + 1) return null;

  const trueRanges = orderedCandles.slice(1).map((candle, index) => {
    const previousClose = orderedCandles[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });

  return average(trueRanges.slice(-period));
};

const findResistanceLevels = (candles: MarketCandle[], entryPrice: number) => {
  const orderedCandles = [...candles].sort((left, right) => left.date.localeCompare(right.date));
  const swingHighs: number[] = [];

  for (let index = 2; index < orderedCandles.length - 2; index += 1) {
    const current = orderedCandles[index];
    const neighbors = [
      orderedCandles[index - 2],
      orderedCandles[index - 1],
      orderedCandles[index + 1],
      orderedCandles[index + 2],
    ];

    if (neighbors.every((neighbor) => current.high > neighbor.high) && current.high > entryPrice) {
      swingHighs.push(current.high);
    }
  }

  return [...new Set(swingHighs.map(roundPrice))].sort((left, right) => left - right);
};

export const recommendTakeProfit = (
  entryPrice: number,
  stopLoss: number | null | undefined,
  quantity: number,
  candles: MarketCandle[] = [],
): TakeProfitRecommendation => {
  const atr = calculateAtr(candles);
  const resistanceLevels = findResistanceLevels(candles, entryPrice);
  const hasValidStopLoss = stopLoss != null && stopLoss < entryPrice;

  if (!hasValidStopLoss) {
    const latestClose = candles.at(-1)?.close;
    const referencePrice = latestClose != null && latestClose > entryPrice ? latestClose : entryPrice;
    const volatilityTarget = atr != null ? referencePrice + atr * 2 : entryPrice * 1.08;

    // Without a user-defined stop, there is no defensible R multiple. In that case
    // the sell recommendation is chart-first: prefer nearby resistance that is not
    // too close to entry, otherwise use a volatility-aware fallback.
    if (atr != null && resistanceLevels.length > 0) {
      const minimumDistance = Math.max(atr * 0.75, entryPrice * 0.015);
      const maximumDistance = Math.max(atr * 6, entryPrice * 0.18);
      const selectedResistance = resistanceLevels.find((level) => {
        const distance = level - referencePrice;
        return distance >= minimumDistance && distance <= maximumDistance;
      });

      if (selectedResistance) {
        return {
          price: roundPrice(selectedResistance),
          explanation:
            "Recommended sell price is near recent resistance. No risk/reward ratio is shown because no stop loss is set.",
          atr,
          resistance: selectedResistance,
          rewardRiskRatio: null,
        };
      }
    }

    return {
      price: roundPrice(volatilityTarget),
      explanation:
        atr != null
          ? "Recommended sell price uses a 2 ATR move because no stop loss is set."
          : "Recommended sell price uses a conservative 8% target because no stop loss or reliable candle data is available.",
      atr,
      resistance: null,
      rewardRiskRatio: null,
    };
  }

  const resolvedRiskPerShare = entryPrice - stopLoss;
  const fallbackTarget = entryPrice + resolvedRiskPerShare * 2;

  // Professional swing-trade targets should respect risk first, then use the chart.
  // The 2:1 target is the baseline. A resistance candidate can replace it only if
  // it keeps at least 1.5R and is not wildly outside recent 14-day volatility.
  if (atr != null && resistanceLevels.length > 0) {
    const minimumReward = resolvedRiskPerShare * 1.5;
    const maximumVolatilityDistance = Math.max(resolvedRiskPerShare * 4, atr * 6);
    const candidates = resistanceLevels
      .map((level) => ({
        level,
        rewardPerShare: level - entryPrice,
        rewardRiskRatio: (level - entryPrice) / resolvedRiskPerShare,
        distanceFromFallback: Math.abs(level - fallbackTarget),
      }))
      .filter(
        (candidate) =>
          candidate.rewardPerShare >= minimumReward && candidate.rewardPerShare <= maximumVolatilityDistance,
      )
      .sort((left, right) => left.distanceFromFallback - right.distanceFromFallback);

    const selectedResistance = candidates[0];
    if (selectedResistance) {
      return {
        price: roundPrice(selectedResistance.level),
        explanation: `Recommended TP is near recent resistance while maintaining a ${selectedResistance.rewardRiskRatio.toFixed(1)}:1 risk/reward ratio.`,
        atr,
        resistance: selectedResistance.level,
        rewardRiskRatio: selectedResistance.rewardRiskRatio,
      };
    }
  }

  return {
    price: roundPrice(fallbackTarget),
    explanation: "Recommended TP is based on a 2:1 risk/reward ratio.",
    atr,
    resistance: null,
    rewardRiskRatio: 2,
  };
};
