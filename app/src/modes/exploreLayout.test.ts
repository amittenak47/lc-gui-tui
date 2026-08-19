import { describe, expect, it } from "vitest";

import {
  clusterCentres,
  clusterLabels,
  makeBodies,
  makeBody,
  settle,
  step,
  type Body,
} from "./exploreLayout";
import type { NodeRef } from "../util/noteLinks";

const note = (id: string): NodeRef => ({ type: "annotate", id, title: id });
const board = (id: string): NodeRef => ({ type: "whiteboard", id, title: id });

function bodies(nodes: NodeRef[]): Body[] {
  return makeBodies(nodes, (node) => `${node.type}:${node.id}`);
}

function rest(nodes: NodeRef[], clustered = false): Body[] {
  const list = bodies(nodes);
  settle(list, clusterCentres(list.map((b) => b.node.type)), clustered);
  return list;
}

describe("makeBodies", () => {
  it("is stable for a set, so opening Explore twice looks the same", () => {
    const nodes = [note("one"), note("two"), note("three")];
    const a = bodies(nodes);
    const b = bodies(nodes);
    expect(a.map((x) => [x.x, x.y])).toEqual(b.map((x) => [x.x, x.y]));
  });

  it("does not depend on the order the library happened to list them", () => {
    // Ranking is by hash, not by insertion, or Recent's sort would move the map.
    const nodes = [note("one"), note("two"), note("three")];
    const forward = bodies(nodes);
    const backward = bodies([...nodes].reverse());
    for (const body of forward) {
      const twin = backward.find((other) => other.key === body.key)!;
      expect([twin.x, twin.y]).toEqual([body.x, body.y]);
    }
  });

  it("puts different nodes in different places", () => {
    const [a, b] = bodies([note("one"), note("two")]);
    expect([a!.x, a!.y]).not.toEqual([b!.x, b!.y]);
  });

  it("starts inside the box, not on its edge", () => {
    for (const body of bodies(["a", "b", "c", "dd", "eee", "ffff"].map(note))) {
      expect(body.x).toBeGreaterThan(0.1);
      expect(body.x).toBeLessThan(0.9);
      expect(body.y).toBeGreaterThan(0.1);
      expect(body.y).toBeLessThan(0.9);
    }
  });

  it("still seeds a lone body handed no home", () => {
    // The single-body entry point is kept for callers outside the set path.
    const solo = makeBody("annotate:solo", note("solo"));
    expect(solo.x).toBeGreaterThan(0.1);
    expect(solo.y).toBeLessThan(0.9);
  });
});

describe("step", () => {
  it("keeps every node on the page", () => {
    // Positions are normalized, so "on the page" is 0..1 whatever the box is.
    const list = rest(Array.from({ length: 14 }, (_, i) => note(`n${i}`)));
    for (const body of list) {
      expect(body.x).toBeGreaterThanOrEqual(0.05);
      expect(body.x).toBeLessThanOrEqual(0.95);
      expect(body.y).toBeGreaterThanOrEqual(0.05);
      expect(body.y).toBeLessThanOrEqual(0.95);
    }
  });

  it("pushes overlapping nodes apart", () => {
    const list = bodies([note("a"), note("b")]);
    // Start them on top of each other, which seeding would never do.
    list[0]!.x = 0.5;
    list[0]!.y = 0.5;
    list[1]!.x = 0.505;
    list[1]!.y = 0.5;
    settle(list, clusterCentres(["annotate"]), false);
    const gap = Math.hypot(list[0]!.x - list[1]!.x, list[0]!.y - list[1]!.y);
    expect(gap).toBeGreaterThan(0.02);
  });

  it("leaves room under every node for its label", () => {
    // The failure this guards against is not ugliness, it is unreadability:
    // captions sit under the dots, so nodes packed tighter than the gap put
    // one label on top of another.
    const list = rest(Array.from({ length: 9 }, (_, i) => note(`mdink-${i}`)));
    let closest = Infinity;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        closest = Math.min(closest, Math.hypot(list[i]!.x - list[j]!.x, list[i]!.y - list[j]!.y));
      }
    }
    expect(closest).toBeGreaterThan(0.07);
  });

  it("fills the box rather than a band across the middle", () => {
    // Straight per-id hashing clumped: six uniform samples leave half the
    // canvas empty, and no amount of repulsion fixes where they started.
    const list = rest(Array.from({ length: 6 }, (_, i) => note(`mdink-${i}`)));
    const xs = list.map((b) => b.x);
    const ys = list.map((b) => b.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.5);
  });

  it("covers the box at every library size", () => {
    for (const count of [3, 5, 9, 16]) {
      const list = rest(Array.from({ length: count }, (_, i) => note(`n${i}`)));
      const ys = list.map((b) => b.y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.4);
    }
  });

  it("gathers a kind tightly enough to read as a group", () => {
    // Repulsion is sized for captions when loose. At that width it simply
    // cancels the cluster pull and nothing visibly gathers, so clustering
    // shrinks the gap it has to overcome.
    const nodes = [note("a"), note("b"), note("c"), note("d")];
    const tight = rest(nodes, true);
    const cx = tight.reduce((sum, b) => sum + b.x, 0) / tight.length;
    const cy = tight.reduce((sum, b) => sum + b.y, 0) / tight.length;
    const furthest = Math.max(...tight.map((b) => Math.hypot(b.x - cx, b.y - cy)));
    expect(furthest).toBeLessThan(0.22);
  });

  it("gathers each kind when clustering is on", () => {
    const nodes = [note("a"), note("b"), note("c"), board("d"), board("e")];
    const loose = rest(nodes, false);
    const tight = rest(nodes, true);
    const spread = (list: Body[], type: string) => {
      const members = list.filter((b) => b.node.type === type);
      const cx = members.reduce((sum, b) => sum + b.x, 0) / members.length;
      const cy = members.reduce((sum, b) => sum + b.y, 0) / members.length;
      return members.reduce((sum, b) => sum + Math.hypot(b.x - cx, b.y - cy), 0) / members.length;
    };
    expect(spread(tight, "annotate")).toBeLessThan(spread(loose, "annotate"));
  });

  it("survives a frame that took far too long", () => {
    // A backgrounded tab comes back with a huge delta. The caller clamps it;
    // this checks the clamp is enough to keep everything finite and on-page.
    const list = rest([note("a"), note("b")]);
    step(list, clusterCentres(["annotate"]), { clustered: false, dt: 1 / 20, time: 3, aspect: 4 });
    for (const body of list) {
      expect(Number.isFinite(body.x)).toBe(true);
      expect(Number.isFinite(body.y)).toBe(true);
      expect(body.x).toBeLessThanOrEqual(0.95);
    }
  });

  it("does not care what shape the box is", () => {
    // Explore can be half a split pane. Nothing in the simulation knows pixels,
    // so a tall box and a wide one both produce usable spacing.
    for (const aspect of [0.4, 1, 3.5]) {
      const list = bodies([note("a"), note("b"), note("c")]);
      for (let i = 0; i < 120; i += 1) {
        step(list, clusterCentres(["annotate"]), { clustered: false, dt: 1 / 60, time: 0, aspect });
      }
      for (const body of list) {
        expect(Number.isFinite(body.x)).toBe(true);
        expect(body.x).toBeGreaterThanOrEqual(0.05);
      }
    }
  });
});

describe("clusterCentres", () => {
  it("centres a lone kind rather than parking it in a corner", () => {
    const centre = clusterCentres(["annotate"]).get("annotate")!;
    expect(centre).toEqual({ x: 0.5, y: 0.5 });
  });

  it("spreads the kinds that exist over the whole box", () => {
    const centres = clusterCentres(["annotate", "whiteboard"]);
    const a = centres.get("annotate")!;
    const b = centres.get("whiteboard")!;
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(0.2);
  });

  it("centres a short last row instead of leaving a hole", () => {
    // Three kinds on a 2x2 grid used to park two at the top and one
    // bottom-left, wasting a quarter of the canvas.
    const centres = clusterCentres(["annotate", "whiteboard", "practice"]);
    expect(centres.get("practice")).toEqual({ x: 0.5, y: 0.75 });
  });

  it("gives no slot to a kind that is not present", () => {
    expect(clusterCentres(["annotate"]).has("practice")).toBe(false);
    expect(clusterCentres([]).size).toBe(0);
  });
});

describe("clusterLabels", () => {
  it("labels every kind on screen and nothing else", () => {
    const list = rest([note("a"), board("b")], true);
    expect(clusterLabels(list).map((row) => row.type)).toEqual(["annotate", "whiteboard"]);
  });

  it("anchors a caption above its own members", () => {
    const list = rest([note("a"), note("b"), note("c")], true);
    const label = clusterLabels(list)[0]!;
    expect(label.y).toBeLessThanOrEqual(Math.min(...list.map((b) => b.y)));
  });

  it("lifts a caption clear of another cluster's nodes", () => {
    // "WEB" landed on top of a note that happened to sit there, which is worse
    // than no caption. The caption walks up until its patch is free.
    const list = rest([note("a"), note("b"), board("c"), board("d")], true);
    for (const label of clusterLabels(list)) {
      const clash = list.some(
        (body) =>
          body.node.type !== label.type &&
          Math.abs(body.x - label.x) < 0.1 &&
          Math.abs(body.y - label.y) < 0.045,
      );
      expect(clash).toBe(false);
    }
  });

  it("has nothing to say about an empty canvas", () => {
    expect(clusterLabels([])).toEqual([]);
  });
});
