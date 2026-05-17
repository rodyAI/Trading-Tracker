import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";

const TRADE_CATEGORIES = ["Swing", "Long trades", "Value investing", "Magic formula"] as const;

const tradeSchema = z.object({
  id: z.string().min(1),
  category: z.enum(TRADE_CATEGORIES).default("Swing"),
  symbol: z.string().min(1),
  quantity: z.number().positive(),
  entryPrice: z.number().positive(),
  stopLoss: z.number().positive().nullable().optional(),
  takeProfit: z.number().positive().nullable().optional(),
  notes: z.string().optional(),
  entryDate: z.string().optional(),
  tags: z.array(z.string()).optional(),
  currentPrice: z.number().nullable().optional(),
  currentPriceAsOf: z.number().nullable().optional(),
  currentPriceProvider: z.string().nullable().optional(),
  priceError: z.string().nullable().optional(),
  recommendedTakeProfit: z.number().nullable().optional(),
  recommendationExplanation: z.string().optional(),
});

const tradeListSchema = z.array(tradeSchema);

export type StoredTrade = z.infer<typeof tradeSchema>;

const dataFile = config.tradeDataFile
  ? path.resolve(config.tradeDataFile)
  : path.resolve(process.cwd(), "data", "trades.json");
const dataDir = path.dirname(dataFile);

const normalizeTrade = (trade: StoredTrade): StoredTrade => ({
  ...trade,
  category: trade.category ?? "Swing",
  symbol: trade.symbol.trim().toUpperCase(),
  stopLoss: trade.stopLoss ?? null,
  takeProfit: trade.takeProfit ?? null,
  tags: trade.tags ?? [],
});

export class TradeStore {
  private async ensureDataFile() {
    await fs.mkdir(dataDir, { recursive: true });
    try {
      await fs.access(dataFile);
    } catch {
      await fs.writeFile(dataFile, "[]\n", "utf8");
    }
  }

  async getAll() {
    await this.ensureDataFile();
    const raw = await fs.readFile(dataFile, "utf8");
    const parsed = tradeListSchema.parse(JSON.parse(raw));
    return parsed.map(normalizeTrade);
  }

  async replaceAll(trades: StoredTrade[]) {
    const normalizedTrades = tradeListSchema.parse(trades).map(normalizeTrade);
    await this.ensureDataFile();
    await fs.writeFile(dataFile, `${JSON.stringify(normalizedTrades, null, 2)}\n`, "utf8");
    return normalizedTrades;
  }

  async upsert(trade: StoredTrade) {
    const parsedTrade = normalizeTrade(tradeSchema.parse(trade));
    const trades = await this.getAll();
    const existingIndex = trades.findIndex((item) => item.id === parsedTrade.id);
    const nextTrades =
      existingIndex >= 0
        ? trades.map((item) => (item.id === parsedTrade.id ? parsedTrade : item))
        : [parsedTrade, ...trades];
    await this.replaceAll(nextTrades);
    return parsedTrade;
  }

  async bulkInsert(tradesToInsert: StoredTrade[]) {
    const parsedTrades = tradeListSchema.parse(tradesToInsert).map(normalizeTrade);
    const trades = await this.getAll();
    await this.replaceAll([...parsedTrades, ...trades]);
    return parsedTrades;
  }

  async delete(id: string) {
    const trades = await this.getAll();
    const nextTrades = trades.filter((trade) => trade.id !== id);
    await this.replaceAll(nextTrades);
    return nextTrades.length !== trades.length;
  }
}
