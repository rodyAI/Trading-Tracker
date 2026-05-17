import type {
  RawStockRecord,
  RejectionReason,
  ScreenedStockRecord,
  ScreenedStockResult,
  ScreenerRunResponse,
} from "../../../shared/src/types.js";
import type { ScreenerDataProvider } from "../providers/screenerDataProvider.js";

const EXCLUDED_INDUSTRY_PATTERNS = [
  "bank",
  "banking",
  "asset management",
  "investment",
  "investment firm",
  "investment holding",
  "capital markets",
];

const normalizeString = (value: string | null | undefined, fallback: string) => {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
};

const normalizeNumber = (value: number | null | undefined): number | null => {
  if (!Number.isFinite(value)) return null;
  return Number(value);
};

const isChineseCompany = (record: RawStockRecord) => {
  if (record.isChinese === true) return true;
  const country = normalizeString(record.country, "").toLowerCase();
  const companyName = normalizeString(record.companyName, "").toLowerCase();
  return country.includes("china") || companyName.includes(" china ");
};

const isExcludedIndustry = (industry: string) => {
  const lower = industry.toLowerCase();
  return EXCLUDED_INDUSTRY_PATTERNS.some((pattern) => lower.includes(pattern));
};

const normalizeRecord = (record: RawStockRecord): ScreenedStockRecord | null => {
  const currentPrice = normalizeNumber(record.currentPrice);
  const sharesOutstanding = normalizeNumber(record.sharesOutstanding);
  const operatingIncomeLtm = normalizeNumber(record.operatingIncomeLtm);
  const cashAndEquivalents = normalizeNumber(record.cashAndEquivalents) ?? 0;
  const shortTermInvestments = normalizeNumber(record.shortTermInvestments) ?? 0;
  const shortTermBorrowings = normalizeNumber(record.shortTermBorrowings) ?? 0;
  const currentPortionLongTermDebt = normalizeNumber(record.currentPortionLongTermDebt) ?? 0;
  const longTermDebt = normalizeNumber(record.longTermDebt) ?? 0;
  const averageDailyVolume = normalizeNumber(record.averageDailyVolume);

  if (
    currentPrice == null ||
    sharesOutstanding == null ||
    operatingIncomeLtm == null ||
    averageDailyVolume == null
  ) {
    return null;
  }

  const marketCap = currentPrice * sharesOutstanding;
  const enterpriseValue =
    marketCap + shortTermBorrowings + currentPortionLongTermDebt + longTermDebt - cashAndEquivalents - shortTermInvestments;
  const ebitLtm = operatingIncomeLtm;
  if (ebitLtm === 0) {
    return null;
  }

  const evToEbit = enterpriseValue / ebitLtm;

  if (!Number.isFinite(enterpriseValue) || !Number.isFinite(evToEbit)) {
    return null;
  }

  return {
    ticker: normalizeString(record.ticker, "UNKNOWN").toUpperCase(),
    companyName: normalizeString(record.companyName, "Unknown company"),
    country: normalizeString(record.country, "Unknown"),
    industry: normalizeString(record.industry, "Unknown"),
    enterpriseValue,
    marketCap,
    evToEbit: Number(evToEbit),
    ebitLtm,
    currentPrice,
    sharesOutstanding,
    cashAndEquivalents,
    shortTermInvestments,
    shortTermBorrowings,
    currentPortionLongTermDebt,
    longTermDebt,
    averageDailyVolume,
    averageDailyTradedValue: averageDailyVolume * currentPrice,
    isChinese: isChineseCompany(record),
    currency: normalizeString(record.currency, "USD"),
    source: normalizeString(record.source, "Unknown"),
  };
};

const screenRecord = (record: RawStockRecord): ScreenedStockResult => {
  const normalized = normalizeRecord(record);
  const rejectionReasons: RejectionReason[] = [];

  if (!normalized) {
    return {
      ticker: normalizeString(record.ticker, "UNKNOWN").toUpperCase(),
      companyName: normalizeString(record.companyName, "Unknown company"),
      country: normalizeString(record.country, "Unknown"),
      industry: normalizeString(record.industry, "Unknown"),
      enterpriseValue: 0,
      marketCap: 0,
      evToEbit: 0,
      ebitLtm: 0,
      currentPrice: 0,
      sharesOutstanding: 0,
      cashAndEquivalents: 0,
      shortTermInvestments: 0,
      shortTermBorrowings: 0,
      currentPortionLongTermDebt: 0,
      longTermDebt: 0,
      averageDailyVolume: 0,
      averageDailyTradedValue: 0,
      isChinese: isChineseCompany(record),
      currency: normalizeString(record.currency, "USD"),
      source: normalizeString(record.source, "Unknown"),
      passed: false,
      rejectionReasons: [
        {
          code: "missing-required-fields",
          message: "Excluded because one or more required numeric fields are missing or invalid.",
        },
      ],
    };
  }

  if (!(normalized.marketCap > 500_000_000)) {
    rejectionReasons.push({
      code: "market-cap",
      message: "Market cap must be greater than 500 million USD.",
    });
  }

  if (!(normalized.evToEbit > 2 && normalized.evToEbit < 15)) {
    rejectionReasons.push({
      code: "ev-ebit",
      message: "EV / EBIT must be greater than 2 and less than 15.",
    });
  }

  if (!(normalized.ebitLtm > 0)) {
    rejectionReasons.push({
      code: "ebit-ltm",
      message: "EBIT LTM must be greater than 0.",
    });
  }

  if (isExcludedIndustry(normalized.industry)) {
    rejectionReasons.push({
      code: "industry",
      message: "Industry is excluded by the banking / investments filter.",
    });
  }

  if (normalized.isChinese) {
    rejectionReasons.push({
      code: "china",
      message: "Chinese companies are excluded.",
    });
  }

  if (!(normalized.averageDailyTradedValue > 500_000)) {
    rejectionReasons.push({
      code: "traded-value",
      message: "Average daily traded value must be above 500,000 USD.",
    });
  }

  return {
    ...normalized,
    passed: rejectionReasons.length === 0,
    rejectionReasons,
  };
};

export class ScreenerService {
  constructor(private readonly provider: ScreenerDataProvider) {}

  async run(): Promise<ScreenerRunResponse> {
    const rawRecords = await this.provider.getStocks();
    const results = rawRecords.map(screenRecord);

    return {
      provider: this.provider.id,
      generatedAt: Date.now(),
      universeSize: results.length,
      passedCount: results.filter((item) => item.passed).length,
      assumptions: this.provider.getAssumptions(),
      results,
    };
  }
}
