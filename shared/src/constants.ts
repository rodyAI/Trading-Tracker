export const DEFAULT_SYMBOL = "AAPL";

export const SUPPORTED_TIMEFRAMES = ["1m", "5m", "15m", "1h", "1d"] as const;

export const ALERT_COOLDOWN_MS = 4 * 60 * 1000;

export const MODE_CONFIG = {
  conservative: {
    threshold: 72,
    momentumWeight: 0.85,
    volatilityWeight: 0.85,
    patternWeight: 0.9,
  },
  balanced: {
    threshold: 60,
    momentumWeight: 1,
    volatilityWeight: 1,
    patternWeight: 1,
  },
  aggressive: {
    threshold: 48,
    momentumWeight: 1.1,
    volatilityWeight: 1.15,
    patternWeight: 1.15,
  },
} as const;
