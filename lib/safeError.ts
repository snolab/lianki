type ErrorMetadata = {
  message: string;
  name?: string;
  code?: string;
  status?: number;
  type?: string;
  stackPreview?: string;
};

const SECRET_REPLACEMENTS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /vlt_[A-Za-z0-9]{20,}/g,
  /(Bearer\s+)[A-Za-z0-9._-]+/gi,
];

function redactSecrets(input: string): string {
  return SECRET_REPLACEMENTS.reduce((value, pattern) => value.replace(pattern, "[REDACTED]"), input);
}

function trimMessage(input: string, maxLength = 500): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength)}...`;
}

export function summarizeError(error: unknown): ErrorMetadata {
  if (error instanceof Error) {
    const enriched = error as Error & {
      code?: string;
      status?: number;
      type?: string;
    };

    const summary: ErrorMetadata = {
      name: enriched.name,
      message: trimMessage(redactSecrets(enriched.message || String(error))),
      code: enriched.code,
      status: enriched.status,
      type: enriched.type,
    };

    if (process.env.NODE_ENV !== "production" && enriched.stack) {
      summary.stackPreview = trimMessage(
        redactSecrets(enriched.stack.split("\n").slice(0, 3).join("\n")),
        700,
      );
    }
    return summary;
  }

  return {
    message: trimMessage(redactSecrets(String(error))),
  };
}

export function logSanitizedError(
  context: string,
  error: unknown,
  extra: Record<string, unknown> = {},
) {
  console.error(`[${context}]`, {
    ...extra,
    error: summarizeError(error),
  });
}
