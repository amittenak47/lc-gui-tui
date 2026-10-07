/** @vitest-environment jsdom */
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, expect, it, vi } from "vitest";
import { ExploreWebGLRenderer, type GraphNodeStyle } from "./exploreWebGL";

afterEach(() => vi.restoreAllMocks());

function graphics() {
  const allocated = { buffers: new Set(), textures: new Set(), programs: new Set(), vaos: new Set() };
  const drawArrays = vi.fn(), drawArraysInstanced = vi.fn(), texImage2D = vi.fn();
  const allocation = (set: Set<unknown>) => () => { const handle = {}; set.add(handle); return handle; };
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, MAX_TEXTURE_SIZE: 3, FLOAT: 4, NO_ERROR: 0,
    createShader: () => ({}), shaderSource: vi.fn(), compileShader: vi.fn(), getShaderParameter: () => true,
    getProgramParameter: () => true, attachShader: vi.fn(), linkProgram: vi.fn(), deleteShader: vi.fn(),
    createProgram: allocation(allocated.programs), deleteProgram: (h: unknown) => allocated.programs.delete(h),
    createBuffer: allocation(allocated.buffers), deleteBuffer: (h: unknown) => allocated.buffers.delete(h),
    createTexture: allocation(allocated.textures), deleteTexture: (h: unknown) => allocated.textures.delete(h),
    createVertexArray: allocation(allocated.vaos), deleteVertexArray: (h: unknown) => allocated.vaos.delete(h),
    getParameter: () => 2048, getUniformLocation: () => ({}), isContextLost: () => false,
    bindBuffer: vi.fn(), bufferData: vi.fn(), bufferSubData: vi.fn(), bindVertexArray: vi.fn(),
    enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), vertexAttribDivisor: vi.fn(),
    pixelStorei: vi.fn(), bindTexture: vi.fn(), texParameteri: vi.fn(), texSubImage3D: texImage2D, texImage3D: vi.fn(), getError: () => 0,
    viewport: vi.fn(), enable: vi.fn(), blendFunc: vi.fn(), clearColor: vi.fn(), clear: vi.fn(),
    useProgram: vi.fn(), uniform2f: vi.fn(), uniform1f: vi.fn(), uniform1i: vi.fn(), activeTexture: vi.fn(),
    drawArrays, drawArraysInstanced,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function(this: HTMLCanvasElement) {
    return createCanvas(this.width, this.height).getContext("2d") as unknown as CanvasRenderingContext2D;
  });
  return { gl: gl as unknown as WebGL2RenderingContext, allocated, drawArrays, drawArraysInstanced, texImage2D };
}

const palette = { surface: "white", accent: "blue", ink: "black", muted: "gray" };
const node: GraphNodeStyle = {
  id: "a", tint: "red", diameter: 13, label: "A book", font: "11px sans-serif", lineHeight: 14.3,
  selected: false, here: false, missing: false, dim: false, leaving: false,
};

it("batches growing edge counts and moves existing artwork without uploading textures again", () => {
  const { gl, drawArraysInstanced, texImage2D, allocated } = graphics();
  const renderer = new ExploreWebGLRenderer(document.createElement("canvas"), gl, 1);
  const edges = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), glow: "purple", core: "white", dim: false, leaving: false }));
  renderer.setStyles([node], edges, palette, 0, true);
  const uploads = texImage2D.mock.calls.length;
  const geometry = edges.map(edge => ({ id: edge.id, from: { x: 10, y: 10 }, control: { x: 50, y: 80 }, to: { x: 100, y: 20 } }));
  renderer.paint([{ id: "a", x: 10, y: 10 }], geometry, 600, 400, 1, 100);
  renderer.paint([{ id: "a", x: 30, y: 40 }], geometry, 600, 400, 1, 111);
  expect(drawArraysInstanced.mock.calls.filter(call => call[3] === 1000)).toHaveLength(4); // Two edge layers per frame.
  expect(drawArraysInstanced).toHaveBeenCalledTimes(6); // Plus one sprite batch per frame.
  expect(texImage2D).toHaveBeenCalledTimes(uploads);
  renderer.dispose();
  for (const handles of Object.values(allocated)) expect(handles.size).toBe(0);
});

it("refreshes fonts and display density and bounds cached labels after repeated renames", () => {
  const { gl, allocated, texImage2D } = graphics();
  const renderer = new ExploreWebGLRenderer(document.createElement("canvas"), gl, 1);
  for (let i = 0; i < 150; i++) renderer.setStyles([{ ...node, label: `Renamed ${i}` }], [], palette, i, true);
  expect(allocated.textures.size).toBe(1);
  const before = texImage2D.mock.calls.length;
  renderer.invalidateFonts(200);
  renderer.paint([{ id: "a", x: 30, y: 40 }], [], 600, 400, 2, 211);
  expect(texImage2D.mock.calls.length).toBeGreaterThan(before);
  expect(allocated.textures.size).toBe(1);
  renderer.dispose();
  for (const handles of Object.values(allocated)) expect(handles.size).toBe(0);
});

it("releases partial allocations when GPU initialization fails", () => {
  const { gl, allocated } = graphics();
  Object.assign(gl, { createVertexArray: () => null });
  expect(() => new ExploreWebGLRenderer(document.createElement("canvas"), gl, 1)).toThrow("geometry");
  for (const handles of Object.values(allocated)) expect(handles.size).toBe(0);
});

it("keeps overlapping sprites in drawing order across multiple atlas layers", () => {
  const { gl, drawArraysInstanced } = graphics();
  const renderer = new ExploreWebGLRenderer(document.createElement("canvas"), gl, 1);
  const nodes = [node, ...Array.from({ length: 2200 }, (_, i) => ({ ...node, id: `extra${i}`, label: `Label ${i}` })),
    { ...node, id: "blue", tint: "blue", label: "Last" }];
  renderer.setStyles(nodes, [], palette, 0, true);
  renderer.paint([{ id: "blue", x: 50, y: 50 }, { id: "a", x: 50, y: 50 }], [], 100, 100, 1, 100);
  const data = vi.mocked(gl.bufferSubData).mock.calls.at(-1)![2] as Float32Array;
  // Blue's newer layer must precede red's original layer when red is on top.
  expect(data[12]).toBeGreaterThan(0);
  expect(data[38]).toBe(0);
  expect(drawArraysInstanced).toHaveBeenCalledOnce();
  expect(drawArraysInstanced.mock.calls[0]![3]).toBe(4);
  renderer.dispose();
});
