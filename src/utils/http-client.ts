import { gotScraping } from "got-scraping";
import { CookieJar } from "tough-cookie";

const cookieJars = new Map<string, CookieJar>();

export interface RequestOptions {
  url: string | URL;
  referer: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  json?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
  engine?: "fetch" | "got-scraping";
  responseType?: "json" | "text";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusFromError(error: unknown) {
  if (!error || typeof error !== "object") return undefined;

  const maybeResponse = "response" in error ? error.response : undefined;
  if (maybeResponse && typeof maybeResponse === "object" && "statusCode" in maybeResponse) {
    const statusCode = maybeResponse.statusCode;
    return typeof statusCode === "number" ? statusCode : undefined;
  }

  if ("status" in error && typeof error.status === "number") return error.status;
  return undefined;
}

function isTimeoutError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function permanentStatusMessage(status: number, url: string) {
  return `HTTP ${status} - Bloqueio permanente. Abortando retry para ${url}`;
}

export async function httpClient<T>(options: RequestOptions): Promise<T> {
  const {
    url,
    referer,
    method = "GET",
    headers = {},
    json,
    timeoutMs = 7000,
    maxRetries = 1,
    engine = "fetch",
    responseType = "json"
  } = options;

  const requestUrl = url instanceof URL ? url.href : url;
  const origin = new URL(referer).origin;

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      if (engine === "fetch") {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(requestUrl, {
            method,
            headers: {
              ...headers,
              ...(json === undefined ? {} : { "content-type": headers["content-type"] ?? "application/json" }),
              referer
            },
            body: json === undefined ? undefined : JSON.stringify(json),
            signal: controller.signal
          });

          if (!res.ok) throw { response: { statusCode: res.status } };
          return (responseType === "text" ? await res.text() : await res.json()) as T;
        } finally {
          clearTimeout(timeoutId);
        }
      }

      let jar = cookieJars.get(origin);
      if (!jar) {
        jar = new CookieJar();
        cookieJars.set(origin, jar);
      }

      const res = await gotScraping({
        url: requestUrl,
        method,
        headers: { ...headers, referer },
        json,
        cookieJar: jar,
        timeout: { request: timeoutMs },
        responseType,
        retry: { limit: 0 }
      });
      return res.body as T;
    } catch (error) {
      const status = statusFromError(error);
      const isTimeout = isTimeoutError(error);

      if (status === 403 || status === 404 || status === 400 || status === 401) {
        throw new Error(permanentStatusMessage(status, requestUrl));
      }

      if (attempt < maxRetries && (isTimeout || status === 429 || (status != null && status >= 500))) {
        attempt += 1;
        await sleep(500 * attempt);
        continue;
      }

      throw error;
    }
  }

  throw new Error("Unreachable");
}
