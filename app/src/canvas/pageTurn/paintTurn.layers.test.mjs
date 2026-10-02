import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { paintTurn } from "./paintTurn";

function picture(color, width = 400) {
  const canvas = createCanvas(width, 600);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, 600);
  return canvas;
}

for (const restY of [300, 600]) {
  it(`leaves the next turn visible under a departing sheet held at ${restY}`, () => {
    const canvas = createCanvas(400, 600), ctx = canvas.getContext("2d");
    const frame = { layout: "sheet", width: 400, height: 600, from: picture("red"), to: picture("lime"),
      sourceWidth: 400, sourceHeight: 600, corner: { x: 100, y: restY }, bottom: true, restY, paper: "white" };
    paintTurn(ctx, frame);
    expect([...ctx.getImageData(399, 20, 1, 1).data]).toEqual([0, 255, 0, 255]);
    paintTurn(ctx, { ...frame, sheetOnly: true });
    expect(ctx.getImageData(399, 20, 1, 1).data[3]).toBe(0);
    expect([...ctx.getImageData(20, 300, 1, 1).data]).toEqual([255, 0, 0, 255]);
  });
}

it("omits the static spread behind an overlapping book sheet", () => {
  const canvas = createCanvas(800, 600), ctx = canvas.getContext("2d");
  const frame = { layout: "book", width: 800, height: 600, from: picture("red", 800), to: picture("lime", 800),
    sourceWidth: 800, sourceHeight: 600, corner: { x: 100, y: 590 }, bottom: true, restY: 600, paper: "white" };
  paintTurn(ctx, frame);
  expect(ctx.getImageData(10, 10, 1, 1).data[3]).toBe(255);
  paintTurn(ctx, { ...frame, sheetOnly: true });
  expect(ctx.getImageData(10, 10, 1, 1).data[3]).toBe(0);
});
