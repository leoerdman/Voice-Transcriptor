import { describe, expect, it } from "vitest";
import { networkVerdict } from "../src/network-probe";

describe("networkVerdict (FU-02)", () => {
  it("does not call a backend that is not answering 'internet offline'", () => {
    const v = networkVerdict({ kind: "health-failed" });
    expect(v.backendReachable).toBe(false);
    expect(v.internetOnline).toBeNull();
  });

  it("keeps the last known internet state when the network probe itself failed", () => {
    expect(networkVerdict({ kind: "network-failed" })).toEqual({
      backendReachable: true,
      internetOnline: null,
      latencyMs: null,
    });
  });

  it("is offline only when the backend reports online: false", () => {
    expect(networkVerdict({ kind: "network", online: false, latencyMs: null }).internetOnline).toBe(false);
    expect(networkVerdict({ kind: "network", online: true, latencyMs: 40 })).toEqual({
      backendReachable: true,
      internetOnline: true,
      latencyMs: 40,
    });
  });

  it("treats a declined probe (rate limit) as online, as before", () => {
    expect(networkVerdict({ kind: "network-not-ok" }).internetOnline).toBe(true);
  });
});
