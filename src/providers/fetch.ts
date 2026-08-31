import type { TraceId } from "../core/ids.js";
import type { TraceStore } from "../tracing/store.js";

export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function createTracedProviderFetch(input: {
  traces: TraceStore;
  traceId: TraceId;
  component: string;
  timeoutMs: number;
  fetchImpl?: ProviderFetch;
}): ProviderFetch {
  let sequence = 0;
  return async (requestInput, init) => {
    sequence += 1;
    const requestNumber = sequence;
    const request = new Request(requestInput, init);
    input.traces.append({
      traceId: input.traceId,
      component: input.component,
      event: "request_attempted",
      outcome: request.method,
      data: { requestNumber, url: request.url },
    });
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
    const signal = request.signal.aborted
      ? request.signal
      : AbortSignal.any([request.signal, timeoutSignal]);
    try {
      const response = await (input.fetchImpl ?? fetch)(request, { signal });
      input.traces.append({
        traceId: input.traceId,
        component: input.component,
        event: "request_completed",
        outcome: String(response.status),
        providerRequestId: providerRequestId(response.headers),
        data: { requestNumber, url: response.url, status: response.status },
      });
      return response;
    } catch (error) {
      input.traces.append({
        traceId: input.traceId,
        component: input.component,
        event: "request_failed",
        outcome: error instanceof Error ? error.name : "UnknownError",
        data: {
          requestNumber,
          url: request.url,
          error: error instanceof Error ? error.message : "Unknown provider request failure",
        },
      });
      throw error;
    }
  };
}

function providerRequestId(headers: Headers): string | undefined {
  for (const name of ["x-request-id", "request-id", "x-guploader-uploadid"] as const) {
    const value = headers.get(name);
    if (value !== null) {
      return value;
    }
  }
  return undefined;
}
