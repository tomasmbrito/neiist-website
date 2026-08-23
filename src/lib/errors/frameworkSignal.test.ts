import { describe, expect, it } from "vitest";
import { isFrameworkSignal } from "./frameworkSignal";

/**
 * #111 and #153. This predicate decides whether a `catch` is allowed to keep an error, and
 * getting it wrong is invisible: too narrow and the framework's control flow is cancelled
 * silently, too wide and real failures escape as unhandled errors.
 */
describe("isFrameworkSignal", () => {
  it("recognises the three signals Next throws", () => {
    // Shapes taken from what Next actually throws: a string `digest` is the marker.
    const dynamicServer = Object.assign(new Error("Dynamic server usage"), {
      digest: "DYNAMIC_SERVER_USAGE",
    });
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/unauthorized;307;",
    });
    const notFound = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });

    expect(isFrameworkSignal(dynamicServer)).toBe(true);
    expect(isFrameworkSignal(redirect)).toBe(true);
    expect(isFrameworkSignal(notFound)).toBe(true);
  });

  it("does not claim ordinary failures", () => {
    // These must stay caught. A database outage is ours to handle; letting it escape would turn
    // a degraded page into a 500 on every route, since the root layout runs everywhere.
    expect(isFrameworkSignal(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(false);
    expect(isFrameworkSignal({ code: "NEI07", message: "last admin" })).toBe(false);
    expect(isFrameworkSignal("a string")).toBe(false);
    expect(isFrameworkSignal(null)).toBe(false);
    expect(isFrameworkSignal(undefined)).toBe(false);
  });

  it("requires the digest to be a string", () => {
    // A non-string `digest` is not Next's marker. Accepting one would let an arbitrary object
    // with that field cancel the framework's control flow.
    expect(isFrameworkSignal({ digest: 12345 })).toBe(false);
    expect(isFrameworkSignal({ digest: undefined })).toBe(false);
    expect(isFrameworkSignal({ digest: {} })).toBe(false);
  });
});
