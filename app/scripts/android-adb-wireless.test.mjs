import { describe, expect, it } from "vitest";

import { parseTarget, pickWirelessSerial, resolveSerial } from "./android-adb-wireless.mjs";

describe("parseTarget", () => {
  it("accepts ipv4 and port", () => {
    expect(parseTarget("192.168.1.20:41259")).toEqual({
      host: "192.168.1.20",
      port: "41259",
      serial: "192.168.1.20:41259",
    });
  });

  it("rejects a pairing code with no host", () => {
    expect(parseTarget("123456")).toBeNull();
  });
});

describe("pickWirelessSerial", () => {
  it("prefers ip:port over USB", () => {
    const text = [
      "List of devices attached",
      "R58M123ABCD\tdevice usb:1-2 product:magic_note",
      "192.168.1.20:41259\tdevice",
    ].join("\n");
    expect(pickWirelessSerial(text)).toBe("192.168.1.20:41259");
  });

  it("falls back to USB when nothing is wireless", () => {
    expect(pickWirelessSerial("R58M123ABCD\tdevice\n")).toBe("R58M123ABCD");
  });
});

describe("resolveSerial", () => {
  const two = [
    "List of devices attached",
    "emulator-5554\tdevice",
    "192.168.132.66:38985\tdevice",
  ].join("\n");

  it("keeps the saved wireless serial when still listed", () => {
    expect(resolveSerial(two, "192.168.132.66:38985")).toBe("192.168.132.66:38985");
  });

  it("ignores a saved serial that is gone", () => {
    expect(resolveSerial(two, "10.0.0.9:5555")).toBe("192.168.132.66:38985");
  });
});
