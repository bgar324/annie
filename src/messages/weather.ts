import { z } from "zod";
import type { TraceId } from "../core/ids.js";
import { createTracedProviderFetch, type ProviderFetch } from "../providers/fetch.js";
import type { TraceStore } from "../tracing/store.js";

const forecastSchema = z.object({ properties: z.object({ periods: z.array(z.object({
  startTime: z.iso.datetime({ offset: true }),
  endTime: z.iso.datetime({ offset: true }),
  isDaytime: z.boolean(),
  temperature: z.number(),
  temperatureUnit: z.literal("F"),
  shortForecast: z.string(),
})).max(32) }) });

export type DailyWeather = { location: "West Covina" } & (
  | { timeZone: "America/Los_Angeles"; periods: z.infer<typeof forecastSchema>["properties"]["periods"] }
  | { error: "weather_unavailable" }
);

/** Forecast context for the daily brief, not a model tool. */
export async function fetchDailyWeather(input: {
  traceId: TraceId;
  traces: TraceStore;
  signal: AbortSignal;
  fetchImpl?: ProviderFetch;
}): Promise<DailyWeather> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]);
  const fetchWeather = createTracedProviderFetch({
    traceId: input.traceId, traces: input.traces, component: "daily_weather", timeoutMs: 5_000,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  const get = async (url: string) => {
    const response = await fetchWeather(url, {
      signal, redirect: "error",
      headers: { "User-Agent": "Annie (https://github.com/bgar324/annie)", Accept: "application/geo+json" },
    });
    if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
    return response.json();
  };
  try {
    const point = z.object({ properties: z.object({
      forecast: z.string().regex(/^https:\/\/api\.weather\.gov\/gridpoints\/[A-Z]{3}\/\d+,\d+\/forecast$/u),
    }) }).parse(await get("https://api.weather.gov/points/34.0686,-117.939"));
    const forecast = forecastSchema.parse(await get(`${point.properties.forecast}?units=us`));
    return { location: "West Covina", timeZone: "America/Los_Angeles", periods: forecast.properties.periods };
  } catch (error) {
    input.signal.throwIfAborted();
    input.traces.append({ traceId: input.traceId, component: "daily_weather", event: "forecast", outcome: "unavailable", data: { error: error instanceof Error ? error.name : "UnknownError" } });
    return { location: "West Covina", error: "weather_unavailable" };
  }
}
