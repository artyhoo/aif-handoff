import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "./uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("randomUUID", () => {
  it("returns a valid v4 UUID via native randomUUID (secure context)", () => {
    expect(randomUUID()).toMatch(V4);
  });

  it("falls back to getRandomValues when randomUUID is missing (insecure http context)", () => {
    // Simulate plain-HTTP, non-localhost origin: randomUUID is undefined,
    // getRandomValues is still present. This is the case that used to throw
    // `TypeError: crypto.randomUUID is not a function`.
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends ArrayBufferView>(arr: T): T => {
        const view = arr as unknown as Uint8Array;
        for (let i = 0; i < view.length; i++) view[i] = (i * 37 + 11) & 0xff;
        return arr;
      },
    });

    const id = randomUUID();
    expect(id).toMatch(V4);
    // Version + variant nibbles must be set correctly.
    expect(id[14]).toBe("4");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("still returns a valid v4 UUID with no Web Crypto at all (last resort)", () => {
    vi.stubGlobal("crypto", undefined);
    expect(randomUUID()).toMatch(V4);
  });

  it("produces unique values", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => randomUUID()));
    expect(ids.size).toBe(1000);
  });
});
