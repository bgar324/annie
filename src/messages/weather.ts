import { z } from "zod";
import type { TraceId } from "../core/ids.js";
import { createTracedProviderFetch, type ProviderFetch } from "../providers/fetch.js";
import type { TraceStore } from "../tracing/store.js";

const pointUrl = "https://api.weather.gov/points/34.0686,-117.939";
const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
const timestamp = z.string().datetime({ offset: true });
const forecastSchema = z.object({ properties: z.object({ periods: z.array(z.object({
  startTime: timestamp,
  endTime: timestamp,
  isDaytime: z.boolean(),
  temperature: z.number().finite(),
  temperatureUnit: z.literal("F"),
  shortForecast: z.string().trim().min(1).max(200),
  probabilityOfPrecipitation: z.object({ value: z.number().min(0).max(100).nullable() }),
})).max(32) }) });

/** Daily-brief enrichment only. Never exposes a tool or blocks the brief on an outage. */
export async function dailyWeatherLine(input: {
  date: string;
  traceId: TraceId;
  traces: TraceStore;
  signal: AbortSignal;
  fetchImpl?: ProviderFetch;
}): Promise<string> {
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
      timeZone: z.literal("America/Los_Angeles"),
    }) }).parse(await get(pointUrl));
    const { properties: { periods } } = forecastSchema.parse(await get(`${point.properties.forecast}?units=us`));
    const day = periods.find(period => period.isDaytime && localDate.format(new Date(period.startTime)) === input.date);
    const night = day === undefined ? undefined : periods.find(period =>
      !period.isDaytime && Date.parse(period.startTime) >= Date.parse(day.endTime)
      && localDate.format(new Date(period.startTime)) === input.date);
    if (day === undefined || night === undefined) throw new Error("Weather date unavailable");
    const conditions = day.shortForecast.toLowerCase().replace(/\s+/gu, " ");
    const chance = day.probabilityOfPrecipitation.value;
    // NWS precipitation probability includes snow; do not describe snowy forecasts as rain.
    const precipitation = /snow|sleet|ice|freezing/iu.test(conditions) ? "precipitation" : "rain";
    const probability = chance === null ? `${precipitation} chance unavailable` : `${Math.round(chance)}% chance of ${precipitation}`;
    const emoji = /thunder/iu.test(conditions) ? "⛈️" : /snow|sleet|ice|freezing/iu.test(conditions) ? "🌨️"
      : /rain|shower|drizzle/iu.test(conditions) ? "🌧️" : /fog|haze|smoke/iu.test(conditions) ? "🌫️"
      : /partly|mostly sunny/iu.test(conditions) ? "⛅" : /cloud|overcast/iu.test(conditions) ? "☁️"
      : /sun|clear/iu.test(conditions) ? "☀️" : "🌡️";
    const line = `${emoji} West Covina: ${conditions}, high ${Math.round(day.temperature)}°F / low ${Math.round(night.temperature)}°F, ${probability}.`;
    input.traces.append({ traceId: input.traceId, component: "daily_weather", event: "forecast", outcome: "available", data: { date: input.date, line } });
    return line;
  } catch (error) {
    input.signal.throwIfAborted();
    input.traces.append({ traceId: input.traceId, component: "daily_weather", event: "forecast", outcome: "unavailable", data: { date: input.date, error: error instanceof Error ? error.name : "UnknownError" } });
    return "🌡️ West Covina: weather unavailable.";
  }
}
