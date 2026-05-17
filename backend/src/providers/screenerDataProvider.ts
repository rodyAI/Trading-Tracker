import type { RawStockRecord, ScreenerProviderId } from "../../../shared/src/types.js";

export interface ScreenerDataProvider {
  id: ScreenerProviderId;
  getStocks(): Promise<RawStockRecord[]>;
  getAssumptions(): string[];
}
