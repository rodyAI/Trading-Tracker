import type { MarketCandle } from "@shared/types";

export type TradeStatus = "Open" | "Closed" | "Stop loss hit" | "Take profit hit" | "In profit" | "In loss";
export const TRADE_CATEGORIES = ["Swing", "Long trades", "Value investing", "Magic formula"] as const;
export type TradeCategory = (typeof TRADE_CATEGORIES)[number];

export interface TrackedTrade {
  id: string;
  category?: TradeCategory;
  symbol: string;
  quantity: number;
  entryPrice: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  notes?: string;
  entryDate?: string;
  tags?: string[];
  isClosed?: boolean;
  exitPrice?: number | null;
  exitDate?: string;
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
  const takeProfit = form.takeProfit.trim() ? toNumber(form.takeProfit) : null;
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
  if (takeProfit != null && entryPrice != null && takeProfit <= entryPrice) {
    errors.takeProfit = "Take profit must be higher than entry price.";
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
      stopLoss,
      takeProfit,
      notes: form.notes.trim(),
      entryDate: form.entryDate,
      tags: form.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
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
