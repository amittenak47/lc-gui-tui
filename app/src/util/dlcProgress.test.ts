import {expect, it} from "vitest";
import type {DlcStatus} from "../api/client";
import {dlcProgressLabel, mergeDlcStatus} from "./dlcProgress";
const row: DlcStatus = {slug:"leetcode",label:"LeetCode",phase:"downloading",installed:false,count:2869,progress:-1,error:null,revision:1};
it("does not flash an old problem total before the download starts", () => {
  expect(dlcProgressLabel(row,String)).toBe("Connecting…");
  expect(dlcProgressLabel({...row,phase:"unpacking"},String)).toBe("Unpacking downloaded files…");
  expect(dlcProgressLabel({...row,phase:"indexing",count:1},String)).toContain("Preparing problems · 1 indexed");
});
it("does not let a late command response overwrite newer event progress", () => {
  const live = {...row,revision:4,phase:"indexing",count:20};
  expect(mergeDlcStatus([live],[row])).toEqual([live]);
  const ready = {...live,revision:5,installed:true,phase:"idle",count:2869};
  expect(mergeDlcStatus([live],[ready])).toEqual([ready]);
});
