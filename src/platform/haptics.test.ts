import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, capabilities } = vi.hoisted(() => ({ invoke: vi.fn(), capabilities: { haptics: true } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./capabilities", () => ({ capabilities }));

const haptics = await import("./haptics");

describe("haptics", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    capabilities.haptics = true;
  });

  it("asks the koona-mobile plugin for the system's own feedback, by name", async () => {
    await haptics.selection();
    await haptics.impactLight();
    await haptics.impactMedium();
    await haptics.success();
    expect(invoke.mock.calls).toEqual([
      ["plugin:koona-mobile|haptic", { kind: "selection" }],
      ["plugin:koona-mobile|haptic", { kind: "impactLight" }],
      ["plugin:koona-mobile|haptic", { kind: "impactMedium" }],
      ["plugin:koona-mobile|haptic", { kind: "success" }],
    ]);
  });

  it("does nothing without the capability", async () => {
    capabilities.haptics = false;
    await haptics.selection();
    await haptics.impactLight();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("never throws: a refused or broken call is lost", async () => {
    invoke.mockRejectedValueOnce(new Error("no plugin"));
    await expect(haptics.selection()).resolves.toBeUndefined();
    invoke.mockImplementationOnce(() => {
      throw new Error("no bridge");
    });
    await expect(haptics.impactLight()).resolves.toBeUndefined();
  });
});
