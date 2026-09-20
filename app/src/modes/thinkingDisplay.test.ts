import { expect, it } from "vitest";
import { thinkingStepColor, thinkingStepKey } from "./thinkingDisplay";
it("keeps color and identity stable as text grows", () => {
  const before = {kind:"stage" as const,label:"reason",detail:"One",ts:1,updateId:"reason-1-0"};
  const after = {...before,detail:"One long complete step",ts:2};
  expect(thinkingStepKey(before,0)).toBe(thinkingStepKey(after,3));
  expect(thinkingStepColor(thinkingStepKey(before,0))).toBe(thinkingStepColor(thinkingStepKey(after,3)));
  expect(new Set([0,1,2,3,4].map(i => thinkingStepColor(`reason-1-${i}`))).size).toBe(5);
});
