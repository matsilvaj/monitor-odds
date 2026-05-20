export type CollectorLogLevel = "info" | "warn" | "error";

function shouldPrint(level: CollectorLogLevel) {
  if (level === "error") return true;
  return process.env.COLLECT_DEBUG === "true" || process.env.COLLECT_DEBUG === "1";
}

export function logCollectorMessage(
  bookmakerSlug: string,
  level: CollectorLogLevel,
  message: string,
  context: Record<string, unknown> = {}
) {
  if (!shouldPrint(level)) return;

  const contextText = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  const line = `[${bookmakerSlug}] ${message}${contextText}`;
  const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  method(line);
}
