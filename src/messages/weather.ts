import { z } from "zod";
import { parseToolArguments, type RegisteredTool } from "../agent/tools.js";
import type { TraceId } from "../core/ids.js";
import { createTracedProviderFetch, type ProviderFetch } from "../providers/fetch.js";
import type { TraceStore } from "../tracing/store.js";

const citySchema = z.string().max(120).trim().min(1);
const weatherArgumentsSchema = z.object({ city: citySchema.optional() }).strict();
const geocodingSchema = z.object({
  results: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    admin1: z.string().trim().min(1).max(200).optional(),
    country: z.string().trim().min(1).max(200),
  })).max(10).default([]),
});
const conditions: Readonly<Record<number, string>> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};
const forecastSchema = z.object({
  timezone: z.string().refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }),
  daily_units: z.object({
    time: z.literal("iso8601"),
    temperature_2m_max: z.literal("°F"),
    temperature_2m_min: z.literal("°F"),
    weather_code: z.literal("wmo code"),
  }),
  daily: z.object({
    time: z.array(z.iso.date()).min(1).max(7),
    temperature_2m_max: z.array(z.number()).min(1).max(7),
    temperature_2m_min: z.array(z.number()).min(1).max(7),
    weather_code: z.array(z.number().int()).min(1).max(7),
  }),
});

export type DailyWeather = { location: string } & (
  | { timeZone: string; days: Array<{ date: string; highF: number; lowF: number; condition: string }> }
  | { error: "weather_unavailable" | "location_not_found" }
  | { error: "location_ambiguous"; candidates: string[] }
);

/** Shared forecast reader for scheduled briefs and the inbound weather tool. */
export async function fetchDailyWeather(input: {
  traceId: TraceId;
  traces: TraceStore;
  signal: AbortSignal;
  city?: string;
  fetchImpl?: ProviderFetch;
}): Promise<DailyWeather> {
  input.signal.throwIfAborted();
  const city = input.city === undefined ? undefined : citySchema.parse(input.city);
  const normalizedCity = city?.toLocaleLowerCase("en").replace(/\s+/gu, " ");
  const isCampus = normalizedCity === undefined || [
    "ucla", "westwood", "ucla/westwood", "westwood, los angeles", "westwood los angeles",
    "ucla, los angeles", "ucla los angeles",
  ].includes(normalizedCity);
  let location = isCampus ? "Westwood, Los Angeles" : city ?? "Westwood, Los Angeles";
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]);
  const fetchWeather = createTracedProviderFetch({
    traceId: input.traceId, traces: input.traces, component: "daily_weather", timeoutMs: 5_000,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  const get = async (url: URL) => {
    signal.throwIfAborted();
    const response = await fetchWeather(url, {
      signal, redirect: "error",
      headers: { "User-Agent": "Annie (https://github.com/bgar324/annie)", Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
    const body: unknown = await response.json();
    signal.throwIfAborted();
    return body;
  };
  try {
    let latitude = 34.0689;
    let longitude = -118.4452;
    if (!isCampus && city !== undefined) {
      const searchUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
      searchUrl.search = new URLSearchParams({ name: city, count: "10", language: "en", format: "json" }).toString();
      const { results } = geocodingSchema.parse(await get(searchUrl));
      if (results.length === 0) return { location, error: "location_not_found" };
      // Send qualifiers unchanged to the provider. Prefer the requested city over prefix matches.
      const exact = results.filter((result) => {
        const name = result.name.toLocaleLowerCase("en");
        return normalizedCity === name || normalizedCity?.startsWith(`${name},`) === true;
      });
      const candidates = [...new Map((exact.length > 0 ? exact : results).map((result) => [
        `${result.latitude},${result.longitude}`, result,
      ])).values()];
      const label = (result: z.infer<typeof geocodingSchema>["results"][number]) =>
        [...new Set([result.name, result.admin1, result.country].filter((part) => part !== undefined))].join(", ");
      if (candidates.length > 1) {
        return { location, error: "location_ambiguous", candidates: candidates.slice(0, 5).map(label) };
      }
      const candidate = candidates[0];
      if (candidate === undefined) return { location, error: "location_not_found" };
      latitude = candidate.latitude;
      longitude = candidate.longitude;
      location = label(candidate);
    }
    const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
    forecastUrl.search = new URLSearchParams({
      latitude: String(latitude), longitude: String(longitude), timezone: "auto",
      temperature_unit: "fahrenheit", forecast_days: "7",
      daily: "weather_code,temperature_2m_max,temperature_2m_min",
    }).toString();
    const forecast = forecastSchema.parse(await get(forecastUrl));
    const { daily } = forecast;
    if ([daily.temperature_2m_max, daily.temperature_2m_min, daily.weather_code]
      .some((values) => values.length !== daily.time.length)) {
      throw new Error("Mismatched weather days");
    }
    const days = daily.time.map((date, index) => {
      const highF = daily.temperature_2m_max[index];
      const lowF = daily.temperature_2m_min[index];
      const code = daily.weather_code[index];
      const condition = code === undefined ? undefined : conditions[code];
      const previousDate = daily.time[index - 1];
      if (highF === undefined || lowF === undefined || highF < lowF || condition === undefined
        || (previousDate !== undefined && previousDate >= date)) {
        throw new Error("Invalid weather day");
      }
      return { date, highF, lowF, condition };
    });
    return { location, timeZone: forecast.timezone, days };
  } catch (error) {
    input.signal.throwIfAborted();
    input.traces.append({ traceId: input.traceId, component: "daily_weather", event: "forecast", outcome: "unavailable", data: { error: error instanceof Error ? error.name : "UnknownError" } });
    return { location, error: "weather_unavailable" };
  }
}

export function weatherTool(input: {
  traces: TraceStore;
  fetchImpl?: ProviderFetch;
}): RegisteredTool {
  return {
    definition: {
      name: "weather.get",
      description:
        "Get a fresh seven-day Open-Meteo forecast for any city worldwide: Fahrenheit highs/lows, conditions, local dates and timezone. For an ordinary weather question without a named city or explicit location reference, omit city to use UCLA/Westwood, Los Angeles, EVEN IF memory names another daily-brief city. The saved daily-brief city applies to briefs only, not standalone weather questions. Use qualifiers such as 'Tokyo, Japan' or 'West Covina, California'. No account needed. Ask for clarification on location_ambiguous or location_not_found; never substitute a different city or invent unavailable weather. For an explicit request to change future daily-brief weather, look up the city first, then acknowledge the requested preference; canonical memory maintenance retains it. A one-off weather lookup never changes that preference. A reset restores Westwood. Attribute forecasts to Open-Meteo.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", minLength: 1, maxLength: 120, pattern: "\\S", description: "City name, optionally qualified by country or state. Defaults to UCLA/Westwood." },
        },
        required: [],
        additionalProperties: false,
      },
    },
    operationClass: "read",
    batchMode: "parallel_read",
    execute: async (argumentsValue, context) => {
      const { city } = parseToolArguments(weatherArgumentsSchema, argumentsValue);
      return fetchDailyWeather({
        traceId: context.traceId,
        traces: input.traces,
        signal: context.signal ?? AbortSignal.timeout(5_000),
        ...(city === undefined ? {} : { city }),
        ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
      });
    },
  };
}
