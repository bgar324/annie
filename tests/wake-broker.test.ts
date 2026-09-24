import { afterEach, describe, expect, it } from "vitest";

const brokerSecret = "wake-secret-value";
const appWakeUrl = "https://ben-production.example/internal/wake";
const fallbackIntervalMs = 6 * 60 * 60 * 1_000;
const maxHorizonMs = 30 * 24 * 60 * 60 * 1_000;

interface StoredWake {
  version: number;
  wakeAtMs: number;
  attempts: number;
  source: string;
  updatedAtMs: number;
  lastStatus?: number;
}

interface BrokerEnv {
  WAKE_SECRET?: string;
  APP_WAKE_URL?: string;
  WAKE_BROKER: {
    idFromName(name: string): string;
    get(id: string): { fetch(url: string, init?: RequestInit): Promise<Response> };
  };
}

interface BrokerObject {
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}

interface BrokerModule {
  default: {
    fetch(request: Request, env: BrokerEnv): Promise<Response>;
    scheduled(
      event: unknown,
      env: BrokerEnv,
      ctx: { waitUntil(promise: Promise<unknown>): void },
    ): Promise<void>;
  };
  WakeBroker: new (state: { storage: FakeStorage }, env: BrokerEnv) => BrokerObject;
}

// Runtime URL import: the broker is plain ESM that wrangler deploys to Cloudflare, so it is not
// part of the TypeScript program and a static import would not resolve.
const broker = (await import(
  new URL("../deploy/wake-broker.mjs", import.meta.url).href
)) as BrokerModule;

class FakeStorage {
  readonly values = new Map<string, unknown>();
  alarmAtMs: number | null = null;

  async get(key: string): Promise<unknown> {
    return this.values.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAtMs;
  }

  async setAlarm(atMs: number): Promise<void> {
    this.alarmAtMs = atMs;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAtMs = null;
  }
}

interface AppCall {
  url: string;
  authorization: string | null;
  body: string;
}

interface BrokerHarness {
  env: BrokerEnv;
  storage: FakeStorage;
  object: BrokerObject;
  appCalls: AppCall[];
  respondWith(status: number): void;
  failWith(error: Error): void;
  onWake(handler: (() => Promise<void>) | undefined): void;
  stored(): StoredWake | undefined;
  restart(): void;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createBrokerHarness(): BrokerHarness {
  const storage = new FakeStorage();
  const appCalls: AppCall[] = [];
  let status = 200;
  let failure: Error | undefined;
  let onWake: (() => Promise<void>) | undefined;
  let object: BrokerObject;

  const env: BrokerEnv = {
    WAKE_SECRET: brokerSecret,
    APP_WAKE_URL: appWakeUrl,
    WAKE_BROKER: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (url, init) => await object.fetch(new Request(url, init)),
      }),
    },
  };
  object = new broker.WakeBroker({ storage }, env);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    appCalls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: String(init?.body),
    });
    if (onWake !== undefined) {
      await onWake();
    }
    if (failure !== undefined) {
      throw failure;
    }
    return new Response("", { status });
  }) as typeof fetch;

  return {
    env,
    storage,
    get object(): BrokerObject {
      return object;
    },
    appCalls,
    respondWith(next: number): void {
      status = next;
      failure = undefined;
    },
    failWith(error: Error): void {
      failure = error;
    },
    onWake(handler: (() => Promise<void>) | undefined): void {
      onWake = handler;
    },
    stored(): StoredWake | undefined {
      return storage.values.get("wake") as StoredWake | undefined;
    },
    restart(): void {
      object = new broker.WakeBroker({ storage }, env);
    },
  };
}

function scheduleRequest(wakeAtMs: number, authorization?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }
  return new Request("https://broker.example/schedule", {
    method: "POST",
    headers,
    body: JSON.stringify({ nextWakeAt: wakeAtMs }),
  });
}

function requiredWake(harness: BrokerHarness): StoredWake {
  const stored = harness.stored();
  if (stored === undefined) {
    throw new Error("the broker stored no wake deadline");
  }
  return stored;
}

describe("wake broker schedule route", () => {
  it("refuses a schedule without the shared secret and never stores one", async () => {
    const harness = createBrokerHarness();
    const wakeAtMs = Date.now() + 3_600_000;

    const anonymous = await broker.default.fetch(scheduleRequest(wakeAtMs), harness.env);
    const wrong = await broker.default.fetch(
      scheduleRequest(wakeAtMs, "Bearer wake-secret-valuf"),
      harness.env,
    );
    const malformed = await broker.default.fetch(
      scheduleRequest(wakeAtMs, brokerSecret),
      harness.env,
    );

    expect([anonymous.status, wrong.status, malformed.status]).toEqual([401, 401, 401]);
    expect(harness.stored()).toBeUndefined();
    expect(harness.storage.alarmAtMs).toBeNull();
  });

  it("answers 503 while the secret is unset", async () => {
    const harness = createBrokerHarness();
    delete harness.env.WAKE_SECRET;

    const response = await broker.default.fetch(
      scheduleRequest(Date.now() + 60_000, `Bearer ${brokerSecret}`),
      harness.env,
    );

    expect(response.status).toBe(503);
    expect(harness.stored()).toBeUndefined();
  });

  it("commits the deadline and its alarm before acknowledging", async () => {
    const harness = createBrokerHarness();
    const wakeAtMs = Date.now() + 3_600_000;

    const response = await broker.default.fetch(
      scheduleRequest(wakeAtMs, `Bearer ${brokerSecret}`),
      harness.env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, wakeAtMs });
    expect(harness.stored()).toMatchObject({ wakeAtMs, attempts: 0, source: "app", version: 1 });
    expect(harness.storage.alarmAtMs).toBe(wakeAtMs);
  });

  it("rejects a timestamp that is not a plausible millisecond instant", async () => {
    const harness = createBrokerHarness();
    const now = Date.now();
    const rejected = [
      Math.floor(now / 1_000),
      now + 1.5,
      now + maxHorizonMs + 60_000,
      Number.NaN,
    ];

    for (const value of rejected) {
      const response = await broker.default.fetch(
        scheduleRequest(value, `Bearer ${brokerSecret}`),
        harness.env,
      );
      expect(response.status).toBe(400);
    }
    expect(harness.stored()).toBeUndefined();
    expect(harness.storage.alarmAtMs).toBeNull();
  });

  it("clamps an already overdue deadline to now", async () => {
    const harness = createBrokerHarness();
    const before = Date.now();

    await broker.default.fetch(
      scheduleRequest(before - 500_000, `Bearer ${brokerSecret}`),
      harness.env,
    );

    const stored = harness.stored();
    expect(stored?.wakeAtMs).toBeGreaterThanOrEqual(before);
    expect(stored?.wakeAtMs).toBeLessThanOrEqual(Date.now());
  });

  it("reports the pending schedule only to an authorized caller", async () => {
    const harness = createBrokerHarness();
    const wakeAtMs = Date.now() + 1_800_000;
    await broker.default.fetch(scheduleRequest(wakeAtMs, `Bearer ${brokerSecret}`), harness.env);

    const anonymous = await broker.default.fetch(
      new Request("https://broker.example/health"),
      harness.env,
    );
    const authorized = await broker.default.fetch(
      new Request("https://broker.example/health", {
        headers: { authorization: `Bearer ${brokerSecret}` },
      }),
      harness.env,
    );

    expect(await anonymous.json()).toEqual({ status: "ok" });
    expect(await authorized.json()).toMatchObject({ wakeAtMs, alarmAtMs: wakeAtMs });
  });
});

describe("wake broker alarm", () => {
  it("wakes the application and falls back to the six-hour boundary", async () => {
    const harness = createBrokerHarness();
    await broker.default.fetch(scheduleRequest(Date.now(), `Bearer ${brokerSecret}`), harness.env);

    await harness.object.alarm();

    expect(harness.appCalls).toEqual([
      { url: appWakeUrl, authorization: `Bearer ${brokerSecret}`, body: "{}" },
    ]);
    const fallbackAtMs =
      Math.floor(Date.now() / fallbackIntervalMs) * fallbackIntervalMs + fallbackIntervalMs;
    expect(harness.stored()).toMatchObject({
      wakeAtMs: fallbackAtMs,
      attempts: 0,
      source: "fallback",
    });
    expect(harness.storage.alarmAtMs).toBe(fallbackAtMs);
  });

  it("keeps retrying a cold application instead of dropping the wake", async () => {
    const harness = createBrokerHarness();
    await broker.default.fetch(scheduleRequest(Date.now(), `Bearer ${brokerSecret}`), harness.env);
    harness.respondWith(502);

    await harness.object.alarm();

    expect(harness.appCalls).toHaveLength(1);
    const first = requiredWake(harness);
    expect(first).toMatchObject({ attempts: 1, source: "app", lastStatus: 502 });
    expect(first.wakeAtMs).toBeGreaterThan(Date.now() + 10_000);
    expect(harness.storage.alarmAtMs).toBe(first.wakeAtMs);

    // The retry alarm fires: pull its deadline into the past rather than waiting for it.
    harness.storage.values.set("wake", { ...first, wakeAtMs: Date.now() - 1 });
    harness.failWith(new TypeError("fetch failed"));
    await harness.object.alarm();

    const second = requiredWake(harness);
    expect(harness.appCalls).toHaveLength(2);
    expect(second).toMatchObject({ attempts: 2 });
    expect(second.wakeAtMs).toBeGreaterThan(Date.now() + 50_000);

    harness.storage.values.set("wake", { ...second, wakeAtMs: Date.now() - 1 });
    harness.respondWith(200);
    await harness.object.alarm();

    expect(harness.appCalls).toHaveLength(3);
    expect(harness.stored()).toMatchObject({ attempts: 0, source: "fallback" });
  });

  it("does not wake the application when its alarm runs early", async () => {
    const harness = createBrokerHarness();
    const wakeAtMs = Date.now() + 600_000;
    await broker.default.fetch(scheduleRequest(wakeAtMs, `Bearer ${brokerSecret}`), harness.env);
    harness.storage.alarmAtMs = null;

    await harness.object.alarm();

    expect(harness.appCalls).toEqual([]);
    expect(harness.stored()).toMatchObject({ wakeAtMs, version: 1 });
    expect(harness.storage.alarmAtMs).toBe(wakeAtMs);
  });

  it("keeps a deadline published while the wake was in flight", async () => {
    const harness = createBrokerHarness();
    const newerWakeAtMs = Date.now() + 7_200_000;
    await broker.default.fetch(scheduleRequest(Date.now(), `Bearer ${brokerSecret}`), harness.env);
    harness.onWake(async () => {
      await broker.default.fetch(
        scheduleRequest(newerWakeAtMs, `Bearer ${brokerSecret}`),
        harness.env,
      );
    });

    await harness.object.alarm();

    expect(harness.appCalls).toHaveLength(1);
    expect(harness.stored()).toMatchObject({ wakeAtMs: newerWakeAtMs, source: "app", version: 2 });
    expect(harness.storage.alarmAtMs).toBe(newerWakeAtMs);
  });

  it("arms the fallback when an alarm fires with no stored deadline", async () => {
    const harness = createBrokerHarness();

    await harness.object.alarm();

    const fallbackAtMs =
      Math.floor(Date.now() / fallbackIntervalMs) * fallbackIntervalMs + fallbackIntervalMs;
    expect(harness.appCalls).toEqual([]);
    expect(harness.stored()).toMatchObject({ wakeAtMs: fallbackAtMs, source: "fallback" });
    expect(harness.storage.alarmAtMs).toBe(fallbackAtMs);
  });
});

describe("wake broker hourly repair", () => {
  it("re-arms an alarm lost across a restart without touching the application", async () => {
    const harness = createBrokerHarness();
    const wakeAtMs = Date.now() + 5_400_000;
    await broker.default.fetch(scheduleRequest(wakeAtMs, `Bearer ${brokerSecret}`), harness.env);
    harness.storage.alarmAtMs = null;
    harness.restart();

    await broker.default.scheduled({}, harness.env, { waitUntil: () => undefined });

    expect(harness.storage.alarmAtMs).toBe(wakeAtMs);
    expect(harness.stored()).toMatchObject({ wakeAtMs, version: 1 });
    expect(harness.appCalls).toEqual([]);
  });

  it("leaves a healthy schedule alone and never calls the application hourly", async () => {
    const harness = createBrokerHarness();
    const wakeAtMs = Date.now() + 5_400_000;
    await broker.default.fetch(scheduleRequest(wakeAtMs, `Bearer ${brokerSecret}`), harness.env);

    await broker.default.scheduled({}, harness.env, { waitUntil: () => undefined });
    await broker.default.scheduled({}, harness.env, { waitUntil: () => undefined });

    expect(harness.storage.alarmAtMs).toBe(wakeAtMs);
    expect(harness.stored()).toMatchObject({ version: 1, attempts: 0 });
    expect(harness.appCalls).toEqual([]);
  });

  it("arms the fallback when a restart finds neither a deadline nor an alarm", async () => {
    const harness = createBrokerHarness();

    await broker.default.scheduled({}, harness.env, { waitUntil: () => undefined });

    const fallbackAtMs =
      Math.floor(Date.now() / fallbackIntervalMs) * fallbackIntervalMs + fallbackIntervalMs;
    expect(harness.stored()).toMatchObject({ wakeAtMs: fallbackAtMs, source: "fallback" });
    expect(harness.storage.alarmAtMs).toBe(fallbackAtMs);
    expect(harness.appCalls).toEqual([]);
  });
});
