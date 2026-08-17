import { describe, expect, it } from "vitest";

import {
  LIBRARY_DELETE_ARM_MS,
  armLibraryDelete,
  isLibraryDeleteArmed,
  libraryDeleteArmRemaining,
  resetLibraryDeleteArmForTests,
} from "./armedDelete";

describe("library delete arm", () => {
  it("is unarmed until a confirmed delete", () => {
    resetLibraryDeleteArmForTests();
    expect(isLibraryDeleteArmed(1_000)).toBe(false);
  });

  it("allows tap-delete inside the window, then lapses", () => {
    resetLibraryDeleteArmForTests();
    armLibraryDelete(1_000);
    expect(isLibraryDeleteArmed(1_000)).toBe(true);
    expect(libraryDeleteArmRemaining(1_000)).toBe(LIBRARY_DELETE_ARM_MS);
    expect(isLibraryDeleteArmed(1_000 + LIBRARY_DELETE_ARM_MS - 1)).toBe(true);
    expect(isLibraryDeleteArmed(1_000 + LIBRARY_DELETE_ARM_MS)).toBe(false);
    expect(libraryDeleteArmRemaining(1_000 + LIBRARY_DELETE_ARM_MS)).toBe(0);
  });
});
