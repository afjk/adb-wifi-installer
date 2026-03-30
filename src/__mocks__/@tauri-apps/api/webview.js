import { vi } from "vitest";

export const getCurrentWebview = vi.fn(() => ({
  onDragDropEvent: vi.fn(async (_handler) => () => {}),
}));
