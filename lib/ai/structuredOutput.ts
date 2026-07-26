export type StructuredOutputResult<T> = { provider: "local" | "openrouter"; value: T; promptVersion: string };
