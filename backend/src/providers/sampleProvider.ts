import { sampleUniverse } from "../data/sampleUniverse.js";
import type { ScreenerDataProvider } from "./screenerDataProvider.js";

export class SampleScreenerProvider implements ScreenerDataProvider {
  id = "sample" as const;

  async getStocks() {
    return sampleUniverse;
  }

  getAssumptions() {
    return [
      "This run uses a bundled sample universe with realistic-looking values so the app works locally without an API key.",
      "The sample dataset is intentionally mixed with passing and failing companies to demonstrate the exact screen logic.",
      "Workbook-style formulas are used: market cap = price × shares outstanding, EV = market cap + short-term debt + current portion of long-term debt + long-term debt - cash - short-term investments.",
      "EBIT LTM is matched to the workbook by using LTM operating income as the screening profit measure.",
      "All monetary values are treated as USD-normalized inputs in the sample provider.",
    ];
  }
}
