import { CookieJar } from "tough-cookie";
import { loadGotScraping } from "./got-scraping.js";

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
  responseType?: "json" | "text" | "buffer";
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

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;

  const directCode = "code" in error ? error.code : undefined;
  if (typeof directCode === "string") return directCode;

  const cause = "cause" in error ? error.cause : undefined;
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string") {
    return cause.code;
  }

  return null;
}

function isTransientNetworkError(error: unknown) {
  const code = errorCode(error);
  if (
    code &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ECONNABORTED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
      "EPIPE",
      "ERR_CRYPTO_OPERATION_FAILED",
      "ERR_SSL_UNSUPPORTED_ELLIPTIC_CURVE",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT"
    ].includes(code)
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("other side closed") ||
    message.includes("failed to set ecdh curve") ||
    message.includes("unsupported_elliptic_curve") ||
    message.includes("unsupported elliptic curve") ||
    message.includes("err_crypto_operation_failed")
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
  while (true) {
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
          if (responseType === "text") return (await res.text()) as T;
          if (responseType === "buffer") return Buffer.from(await res.arrayBuffer()) as T;
          return (await res.json()) as T;
        } finally {
          clearTimeout(timeoutId);
        }
      }

      let jar = cookieJars.get(origin);
      if (!jar) {
        jar = new CookieJar();
        cookieJars.set(origin, jar);
      }

      const gotScraping = await loadGotScraping();
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
      const isNetworkError = isTransientNetworkError(error);
      const retryLimit = isNetworkError ? Math.max(maxRetries, 3) : maxRetries;

      if (status === 403 || status === 404 || status === 400 || status === 401) {
        throw new Error(permanentStatusMessage(status, requestUrl));
      }

      if (attempt < retryLimit && (isTimeout || isNetworkError || status === 429 || (status != null && status >= 500))) {
        attempt += 1;
        await sleep(500 * attempt + Math.floor(Math.random() * 500));
        continue;
      }

      throw error;
    }
  }

  throw new Error("Unreachable");
}
