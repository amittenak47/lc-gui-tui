/**
 * WebGL2 instanced sdRoundCone (tapered capsule). Draw the stroke AABB, not
 * the full screen. AA with smoothstep + fwidth.
 */

import {
  INSTANCE_FLOATS,
  type StrokeAabb,
} from "./instance";

const VERT = `#version 300 es
layout(location=0) in vec2 a_unit;
layout(location=1) in vec2 a_p0;
layout(location=2) in float a_r0;
layout(location=3) in vec2 a_p1;
layout(location=4) in float a_r1;
layout(location=5) in vec3 a_c0;
layout(location=6) in vec3 a_c1;
uniform vec2 u_view;
out vec2 v_p;
out vec2 v_p0;
out vec2 v_p1;
out float v_r0;
out float v_r1;
out vec3 v_c0;
out vec3 v_c1;
void main() {
  float rad = max(a_r0, a_r1) + 2.5;
  vec2 mn = min(a_p0, a_p1) - vec2(rad);
  vec2 mx = max(a_p0, a_p1) + vec2(rad);
  vec2 pos = mix(mn, mx, a_unit);
  v_p = pos;
  v_p0 = a_p0;
  v_p1 = a_p1;
  v_r0 = a_r0;
  v_r1 = a_r1;
  v_c0 = a_c0;
  v_c1 = a_c1;
  vec2 clip = (pos / u_view) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_p;
in vec2 v_p0;
in vec2 v_p1;
in float v_r0;
in float v_r1;
in vec3 v_c0;
in vec3 v_c1;
out vec4 frag;

float sdRoundCone(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 ba = b - a;
  float l2 = dot(ba, ba);
  if (l2 < 1e-8) return length(p - a) - ra;
  float h = clamp(dot(p - a, ba) / l2, 0.0, 1.0);
  float r = mix(ra, rb, h);
  return length(p - a - ba * h) - r;
}

void main() {
  float d = sdRoundCone(v_p, v_p0, v_p1, v_r0, v_r1);
  float aa = max(fwidth(d), 0.75);
  float alpha = 1.0 - smoothstep(-aa, aa, d);
  if (alpha < 0.004) discard;
  vec2 ba = v_p1 - v_p0;
  float l2 = max(dot(ba, ba), 1e-8);
  float h = clamp(dot(v_p - v_p0, ba) / l2, 0.0, 1.0);
  vec3 rgb = mix(v_c0, v_c1, h) / 255.0;
  frag = vec4(rgb * alpha, alpha);
  gl_FragDepth = clamp(0.5 + d * 0.02, 0.0, 1.0);
}
`;

export type SdfRenderer = {
  canvas: HTMLCanvasElement;
  resize(w: number, h: number): void;
  upload(data: Float32Array, count: number): void;
  /** Draw one new capsule without clearing. Live path only. */
  append(data: Float32Array, index: number, aabb: StrokeAabb): void;
  draw(aabb: StrokeAabb): void;
  clear(): void;
  destroy(): void;
};

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function makeGlCanvas(
  w: number,
  h: number,
  peer: (w: number, h: number) => HTMLCanvasElement | null,
): HTMLCanvasElement | null {
  const canvas = peer(w, h);
  return canvas;
}

export function tryCreateSdfRenderer(
  w: number,
  h: number,
  peer: (w: number, h: number) => HTMLCanvasElement | null,
): SdfRenderer | null {
  const canvas = makeGlCanvas(w, h, peer);
  if (!canvas) return null;
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      depth: true,
    }) as WebGL2RenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const uView = gl.getUniformLocation(prog, "u_view");

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const inst = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  const stride = INSTANCE_FLOATS * 4;
  const specs: Array<[number, number, number]> = [
    [1, 2, 0],
    [2, 1, 2],
    [3, 2, 3],
    [4, 1, 5],
    [5, 3, 6],
    [6, 3, 9],
  ];
  for (const [loc, size, offsetFloats] of specs) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offsetFloats * 4);
    gl.vertexAttribDivisor(loc, 1);
  }

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.clearColor(0, 0, 0, 0);

  let count = 0;
  let instCap = 32;
  let viewW = canvas.width;
  let viewH = canvas.height;
  gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  gl.bufferData(gl.ARRAY_BUFFER, instCap * stride, gl.DYNAMIC_DRAW);

  const bindInstAt = (index: number) => {
    gl!.bindBuffer(gl.ARRAY_BUFFER, inst);
    const base = index * stride;
    for (const [loc, size, offsetFloats] of specs) {
      gl!.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, base + offsetFloats * 4);
    }
  };

  const growInst = (n: number) => {
    if (n <= instCap) return false;
    while (instCap < n) instCap *= 2;
    gl!.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl!.bufferData(gl.ARRAY_BUFFER, instCap * stride, gl.DYNAMIC_DRAW);
    return true;
  };

  const scissorAabb = (aabb: StrokeAabb) => {
    const pad = 2;
    const x0 = Math.max(0, Math.floor(aabb.minX) - pad);
    const y0 = Math.max(0, Math.floor(aabb.minY) - pad);
    const x1 = Math.min(viewW, Math.ceil(aabb.maxX) + pad);
    const y1 = Math.min(viewH, Math.ceil(aabb.maxY) + pad);
    if (x1 > x0 && y1 > y0 && x1 - x0 < viewW && y1 - y0 < viewH) {
      gl!.enable(gl.SCISSOR_TEST);
      gl!.scissor(x0, viewH - y1, x1 - x0, y1 - y0);
    } else {
      gl!.disable(gl.SCISSOR_TEST);
    }
  };

  const resize = (nw: number, nh: number) => {
    const width = Math.max(1, nw);
    const height = Math.max(1, nh);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    viewW = width;
    viewH = height;
    gl!.viewport(0, 0, width, height);
  };
  resize(w, h);

  return {
    canvas,
    resize,
    upload(data, n) {
      count = Math.max(0, n);
      growInst(Math.max(count, 1));
      gl!.bindBuffer(gl.ARRAY_BUFFER, inst);
      if (count > 0) {
        gl!.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * INSTANCE_FLOATS));
      }
    },
    append(data, index, aabb) {
      const grew = growInst(index + 1);
      gl!.bindBuffer(gl.ARRAY_BUFFER, inst);
      if (grew) {
        gl!.bufferSubData(
          gl.ARRAY_BUFFER,
          0,
          data.subarray(0, (index + 1) * INSTANCE_FLOATS),
        );
      } else {
        gl!.bufferSubData(
          gl.ARRAY_BUFFER,
          index * stride,
          data.subarray(index * INSTANCE_FLOATS, (index + 1) * INSTANCE_FLOATS),
        );
      }
      count = index + 1;
      gl!.viewport(0, 0, viewW, viewH);
      gl!.useProgram(prog);
      gl!.uniform2f(uView, viewW, viewH);
      gl!.bindVertexArray(vao);
      bindInstAt(index);
      scissorAabb(aabb);
      gl!.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);
      bindInstAt(0);
      gl!.disable(gl.SCISSOR_TEST);
    },
    clear() {
      count = 0;
      gl!.viewport(0, 0, viewW, viewH);
      gl!.disable(gl.SCISSOR_TEST);
      gl!.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    },
    draw(aabb) {
      gl!.viewport(0, 0, viewW, viewH);
      gl!.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (count < 1) return;
      gl!.useProgram(prog);
      gl!.uniform2f(uView, viewW, viewH);
      gl!.bindVertexArray(vao);
      bindInstAt(0);
      scissorAabb(aabb);
      gl!.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      gl!.disable(gl.SCISSOR_TEST);
    },
    destroy() {
      gl!.deleteBuffer(quad);
      gl!.deleteBuffer(inst);
      gl!.deleteVertexArray(vao);
      gl!.deleteProgram(prog);
      gl!.deleteShader(vs);
      gl!.deleteShader(fs);
    },
  };
}
