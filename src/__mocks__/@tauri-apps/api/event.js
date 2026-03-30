import { vi } from "vitest";

export const listen = vi.fn(async (_event, _handler) => {
  return () => {};
});

export const emit = vi.fn(async () => {});
