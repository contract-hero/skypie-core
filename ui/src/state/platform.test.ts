import { afterEach, describe, expect, it, vi } from "vitest";
import {
  guessPlatformOs,
  parsePlatformOs,
  platformBodyClass,
  platformOverride,
  resolvePlatformOs,
} from "./platform";

describe("parsePlatformOs", () => {
  it("recognizes ios", () => {
    expect(parsePlatformOs({ os: "ios" })).toBe("ios");
  });

  it("recognizes macos", () => {
    expect(parsePlatformOs({ os: "macos" })).toBe("macos");
  });

  it("falls back to macos for an unknown os value", () => {
    expect(parsePlatformOs({ os: "windows" })).toBe("macos");
  });

  it("falls back to macos for null, undefined, or non-object input", () => {
    expect(parsePlatformOs(null)).toBe("macos");
    expect(parsePlatformOs(undefined)).toBe("macos");
    expect(parsePlatformOs("ios")).toBe("macos");
    expect(parsePlatformOs(42)).toBe("macos");
  });

  it("falls back to macos when the os field is missing", () => {
    expect(parsePlatformOs({})).toBe("macos");
  });
});

describe("resolvePlatformOs", () => {
  it("returns macos when platformInfo is not wired", async () => {
    await expect(resolvePlatformOs({})).resolves.toBe("macos");
  });

  it("returns macos when platformInfo rejects", async () => {
    const ipc = { platformInfo: () => Promise.reject(new Error("no such command")) };
    await expect(resolvePlatformOs(ipc)).resolves.toBe("macos");
  });

  it("returns ios when platformInfo resolves to ios", async () => {
    const ipc = { platformInfo: () => Promise.resolve({ os: "ios" as const }) };
    await expect(resolvePlatformOs(ipc)).resolves.toBe("ios");
  });

  it("returns macos when platformInfo resolves to an unexpected shape", async () => {
    const ipc = { platformInfo: () => Promise.resolve({ os: "android" } as never) };
    await expect(resolvePlatformOs(ipc)).resolves.toBe("macos");
  });

  it("returns macos when platformInfo throws synchronously", async () => {
    const ipc = {
      platformInfo: () => {
        throw new Error("boom");
      },
    };
    await expect(resolvePlatformOs(ipc)).resolves.toBe("macos");
  });
});

describe("guessPlatformOs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubUserAgent = (userAgent: string | null): void => {
    vi.stubGlobal("navigator", userAgent === null ? undefined : { userAgent });
  };

  it("guesses ios for an iPhone, iPad or iPod user agent", () => {
    for (const device of ["iPhone", "iPad", "iPod"]) {
      stubUserAgent(`Mozilla/5.0 (${device}; CPU OS 17_0 like Mac OS X)`);
      expect(guessPlatformOs()).toBe("ios");
    }
  });

  it("guesses macos for a desktop user agent", () => {
    stubUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(guessPlatformOs()).toBe("macos");
  });

  it("guesses macos when there is no navigator at all", () => {
    stubUserAgent(null);
    expect(guessPlatformOs()).toBe("macos");
  });
});

describe("platformBodyClass", () => {
  it("maps ios/macos to their body class", () => {
    expect(platformBodyClass("ios")).toBe("platform-ios");
    expect(platformBodyClass("macos")).toBe("platform-macos");
  });
});

describe("platformOverride", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubLocalStorage = (value: string | null): void => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "skypie.platformOverride" ? value : null),
    });
  };

  // Vitest runs in Vite's non-production mode, so `import.meta.env.DEV` is
  // true for every case below — exactly the condition under which the e2e
  // harness's own dev-profile binary runs (ui/e2e/README.md), which is the
  // one place this seam is meant to work.
  it("returns null when nothing is set", () => {
    stubLocalStorage(null);
    expect(platformOverride()).toBeNull();
  });

  it("returns null when there is no localStorage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(platformOverride()).toBeNull();
  });

  it("recognizes ios and macos", () => {
    stubLocalStorage("ios");
    expect(platformOverride()).toBe("ios");
    stubLocalStorage("macos");
    expect(platformOverride()).toBe("macos");
  });

  it("ignores an unrecognized value", () => {
    stubLocalStorage("android");
    expect(platformOverride()).toBeNull();
  });
});
