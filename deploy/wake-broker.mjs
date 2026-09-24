/**
 * Annie's external wake broker: one Cloudflare Worker route plus one Durable Object that owns
 * the next absolute instant the application must be running.
 *
 * The application keeps every durable job in its own SQLite database. This object stores a
 * single timestamp and an alarm, so it can call the application back when a deadline passes
 * and stay silent the rest of the time. It never carries message content, never retries a
 * provider write, and never pings the application on a schedule of its own: the hourly cron
 * only repairs a missing alarm.
 *
 * Deploy with `wrangler deploy -c deploy/wrangler.jsonc`; set the shared secret with
 * `wrangler secret put WAKE_SECRET -c deploy/wrangler.jsonc`. The same secret authenticates
 * both directions: the application's POST /schedule and this object's POST /internal/wake.
 */

const brokerObjectName = "annie";
const stateKey = "wake";
const internalOrigin = "https://wake-broker.internal";
const fallbackIntervalMs = 6 * 60 * 60 * 1_000;
const maxHorizonMs = 30 * 24 * 60 * 60 * 1_000;
// A seconds-precision timestamp sent by mistake lands decades before this floor.
const earliestValidWakeAtMs = Date.UTC(2020, 0, 1);
const wakeTimeoutMs = 20_000;
// A cold application answers 502 or nothing at all, so the first retries are quick and the
// last one is hourly: a wake is never dropped, and an unreachable application is never hammered.
const retryBackoffMs = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const alarmSkewMs = 1_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return textResponse("method not allowed", 405);
      }
      if ((await authorize(request, env)) !== "ok") {
        return jsonResponse({ status: "ok" });
      }
      return await brokerStub(env).fetch(`${internalOrigin}/state`);
    }

    if (url.pathname === "/schedule") {
      if (request.method !== "POST") {
        return textResponse("method not allowed", 405);
      }
      const authorization = await authorize(request, env);
      if (authorization === "unconfigured") {
        return textResponse("wake broker is not configured", 503);
      }
      if (authorization !== "ok") {
        return textResponse("unauthorized", 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return textResponse("invalid body", 400);
      }
      const wakeAtMs = validWakeAt(body?.nextWakeAt, Date.now());
      if (wakeAtMs === undefined) {
        return textResponse("invalid nextWakeAt", 400);
      }
      return await brokerStub(env).fetch(`${internalOrigin}/schedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wakeAtMs }),
      });
    }

    return textResponse("not found", 404);
  },

  /** Hourly repair. Re-arms a lost alarm without touching the application. */
  async scheduled(event, env, ctx) {
    const repair = brokerStub(env).fetch(`${internalOrigin}/repair`, { method: "POST" });
    if (ctx !== undefined && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(repair);
    }
    await repair;
  },
};

export class WakeBroker {
  #state;
  #env;

  constructor(state, env) {
    this.#state = state;
    this.#env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/schedule" && request.method === "POST") {
      const body = await request.json();
      return jsonResponse(await this.#schedule(body.wakeAtMs));
    }
    if (url.pathname === "/repair" && request.method === "POST") {
      return jsonResponse(await this.#repair());
    }
    if (url.pathname === "/state") {
      return jsonResponse(await this.#snapshot());
    }
    return textResponse("not found", 404);
  }

  async alarm() {
    const nowMs = Date.now();
    const current = await this.#state.storage.get(stateKey);
    if (current === undefined) {
      await this.#commit({
        version: 1,
        wakeAtMs: fallbackWakeAt(nowMs),
        attempts: 0,
        source: "fallback",
        updatedAtMs: nowMs,
      });
      return;
    }
    if (current.wakeAtMs > nowMs + alarmSkewMs) {
      // A later deadline replaced the one this alarm was armed for; waking now would be early.
      await this.#state.storage.setAlarm(current.wakeAtMs);
      return;
    }

    const outcome = await this.#wakeApplication();

    // The application may have published a new deadline while the wake was in flight. That
    // deadline is newer than anything this alarm knows, so it must survive untouched.
    const latest = await this.#state.storage.get(stateKey);
    if (latest === undefined || latest.version !== current.version) {
      const pendingMs = latest?.wakeAtMs ?? fallbackWakeAt(Date.now());
      await this.#state.storage.setAlarm(Math.max(pendingMs, Date.now()));
      return;
    }

    if (outcome.ok) {
      // Acknowledged. Until the application publishes its own next deadline, the six-hour
      // fallback is the only thing standing between a lost publish and an unreachable app.
      await this.#commit({
        version: current.version + 1,
        wakeAtMs: fallbackWakeAt(Date.now()),
        attempts: 0,
        source: "fallback",
        updatedAtMs: Date.now(),
      });
      return;
    }

    const attempts = current.attempts + 1;
    const retryInMs = retryBackoffMs[Math.min(attempts, retryBackoffMs.length) - 1];
    await this.#commit({
      version: current.version + 1,
      wakeAtMs: Date.now() + retryInMs,
      attempts,
      source: current.source,
      updatedAtMs: Date.now(),
      lastStatus: outcome.status,
    });
  }

  async #schedule(wakeAtMs) {
    const current = await this.#state.storage.get(stateKey);
    const next = {
      version: (current?.version ?? 0) + 1,
      wakeAtMs,
      attempts: 0,
      source: "app",
      updatedAtMs: Date.now(),
    };
    await this.#commit(next);
    return { accepted: true, wakeAtMs, version: next.version };
  }

  async #repair() {
    const nowMs = Date.now();
    const current = await this.#state.storage.get(stateKey);
    const alarmAtMs = await this.#state.storage.getAlarm();
    const armed = alarmAtMs !== null && alarmAtMs !== undefined;
    if (current === undefined) {
      if (armed) {
        return { repaired: false, reason: "idle" };
      }
      const wakeAtMs = fallbackWakeAt(nowMs);
      await this.#commit({
        version: 1,
        wakeAtMs,
        attempts: 0,
        source: "fallback",
        updatedAtMs: nowMs,
      });
      return { repaired: true, reason: "fallback_armed", wakeAtMs };
    }
    // The stored deadline is authoritative and is never rewritten here: repair only re-arms an
    // alarm that was lost or left later than the deadline it is supposed to serve.
    if (!armed || alarmAtMs > current.wakeAtMs) {
      await this.#state.storage.setAlarm(Math.max(current.wakeAtMs, nowMs));
      return { repaired: true, reason: armed ? "alarm_late" : "alarm_missing", wakeAtMs: current.wakeAtMs };
    }
    return { repaired: false, reason: "armed", wakeAtMs: current.wakeAtMs };
  }

  async #snapshot() {
    const current = await this.#state.storage.get(stateKey);
    const alarmAtMs = await this.#state.storage.getAlarm();
    return {
      status: "ok",
      wakeAtMs: current?.wakeAtMs ?? null,
      version: current?.version ?? 0,
      attempts: current?.attempts ?? 0,
      source: current?.source ?? null,
      alarmAtMs: alarmAtMs ?? null,
    };
  }

  async #commit(next) {
    // Storage first, alarm second: an overdue alarm must never fire against a state that has
    // not landed yet.
    await this.#state.storage.put(stateKey, next);
    await this.#state.storage.setAlarm(Math.max(next.wakeAtMs, Date.now()));
  }

  async #wakeApplication() {
    const url = this.#env.APP_WAKE_URL;
    const secret = this.#env.WAKE_SECRET;
    if (typeof url !== "string" || url.length === 0 || typeof secret !== "string" || secret.length === 0) {
      return { ok: false, status: 0 };
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(wakeTimeoutMs),
      });
      return { ok: response.status >= 200 && response.status < 300, status: response.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }
}

function brokerStub(env) {
  return env.WAKE_BROKER.get(env.WAKE_BROKER.idFromName(brokerObjectName));
}

function fallbackWakeAt(nowMs) {
  return Math.floor(nowMs / fallbackIntervalMs) * fallbackIntervalMs + fallbackIntervalMs;
}

function validWakeAt(value, nowMs) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }
  if (value < earliestValidWakeAtMs || value > nowMs + maxHorizonMs) {
    return undefined;
  }
  return Math.max(value, nowMs);
}

async function authorize(request, env) {
  const secret = env.WAKE_SECRET;
  if (typeof secret !== "string" || secret.length === 0) {
    return "unconfigured";
  }
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return "denied";
  }
  // Digests equalise length before the comparison, so neither the secret's length nor its
  // matching prefix leaks through timing.
  const [presented, expected] = await Promise.all([
    sha256(header.slice(prefix.length)),
    sha256(secret),
  ]);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= presented[index] ^ expected[index];
  }
  return difference === 0 ? "ok" : "denied";
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(message, status) {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}
