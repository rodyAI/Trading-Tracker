import { config } from "../config.js";
import { AlphaVantageScreenerProvider } from "./alphaVantageProvider.js";
import { SampleScreenerProvider } from "./sampleProvider.js";
import type { ScreenerDataProvider } from "./screenerDataProvider.js";
import { YahooScreenerProvider } from "./yahooProvider.js";
import type { ScreenerProviderId } from "../../../shared/src/types.js";

export const createScreenerProvider = (providerId: ScreenerProviderId = config.defaultProvider): ScreenerDataProvider => {
  if (providerId === "alphavantage") {
    return new AlphaVantageScreenerProvider();
  }

  if (providerId === "yahoo") {
    return new YahooScreenerProvider();
  }

  return new SampleScreenerProvider();
};
