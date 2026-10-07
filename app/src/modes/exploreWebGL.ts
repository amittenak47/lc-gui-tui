import type { EdgePoint } from "./exploreEdge";
export interface BeamGeometry {
  id: string;
  from: EdgePoint;
  control: EdgePoint;
  to: EdgePoint;
}
export interface BeamStyle {
  id: string;
  glow: string;
  core: string;
  dim: boolean;
  leaving: boolean;
}
export interface GraphNodeStyle {
  id: string;
  tint: string;
  diameter: number;
  label: string;
  font: string;
  lineHeight: number;
  selected: boolean;
  here: boolean;
  missing: boolean;
  dim: boolean;
  leaving: boolean;
}
export interface GraphNodePosition {
  id: string;
  x: number;
  y: number;
}
export interface GraphPalette {
  surface: string;
  accent: string;
  ink: string;
  muted: string;
}
type Rgba = [
  number,
  number,
  number,
  number
];
interface Animation {
  from: number;
  to: number;
  at: number;
  duration: number;
}
interface Sprite {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
}
interface AtlasPage {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  rowHeight: number;
  dirty: boolean;
}
interface StyledNode {
  style: GraphNodeStyle;
  dot: Sprite;
  rim: Sprite | null;
  here: [
    Sprite,
    Sprite
  ] | null;
  hover: Sprite | null;
  label: Sprite;
  animation: Animation;
}
interface StyledBeam {
  style: BeamStyle;
  glow: Rgba;
  core: Rgba;
  animation: Animation;
}
const VIEW_VERTEX = `#version 300 es
layout(location=0) in vec2 aStep;
layout(location=1) in vec2 aFrom;
layout(location=2) in vec2 aControl;
layout(location=3) in vec2 aTo;
layout(location=4) in vec4 aColor;
uniform vec2 uSize;
uniform float uWidth;
out vec4 vColor;
void main(){
float t=aStep.x,s=1.-t;
vec2 p=s*s*aFrom+2.*s*t*aControl+t*t*aTo;
vec2 tangent=2.*(s*(aControl-aFrom)+t*(aTo-aControl));
vec2 normal=vec2(-tangent.y,tangent.x)/max(length(tangent),.000001);
p+=normal*aStep.y*uWidth*.5;
gl_Position=vec4(p/uSize*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);vColor=aColor;
}`;
const COLOR_FRAGMENT = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 result;
void main(){result=vec4(vColor.rgb*vColor.a,vColor.a);}`;
const SPRITE_VERTEX = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aBox;
layout(location=2) in vec4 aUvBox;
layout(location=3) in vec4 aColor;
layout(location=4) in float aPage;
uniform vec2 uSize;
out vec2 vUv;
out vec4 vColor;
flat out float vPage;
void main(){
vec2 p=aBox.xy+aCorner*aBox.zw;
gl_Position=vec4(p/uSize*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);
vUv=aUvBox.xy+aCorner*aUvBox.zw;vColor=aColor;vPage=aPage;
}`;
const SPRITE_FRAGMENT = `#version 300 es
precision mediump float;
uniform highp sampler2DArray uAtlas;
in vec2 vUv;
in vec4 vColor;
flat in float vPage;
out vec4 result;
void main(){vec4 t=texture(uAtlas,vec3(vUv,vPage));result=vec4(t.rgb*t.a*vColor.rgb*vColor.a,t.a*vColor.a);}`;
function alphaAt(animation: Animation, now: number): number {
  const t = animation.duration ? Math.min(1, Math.max(0, (now - animation.at) / animation.duration)) : 1;
  return animation.from + (animation.to - animation.from) * (1 - (1 - t) ** 3);
}
function animate(previous: Animation | undefined, leaving: boolean, now: number, reduced: boolean, enter: number, exit = 180): Animation {
  const to = leaving ? 0 : 1;
  if (!reduced && previous?.to === to)
    return previous;
  return { from: reduced ? to : previous ? alphaAt(previous, now) : 0, to, at: now, duration: reduced ? 0 : previous ? exit : enter };
}
function program(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const shaders: WebGLShader[] = [];
  let result: WebGLProgram | null = null;
  try {
    for (const [kind, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(kind);
      if (!shader)
        throw Error("Could not allocate graph shader");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(shader) ?? "Graph shader failed");
    }
    result = gl.createProgram();
    if (!result)
      throw Error("Could not allocate graph program");
    for (const shader of shaders)
      gl.attachShader(result, shader);
    gl.linkProgram(result);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(result) ?? "Graph program failed");
    return result;
  }
  catch (cause) {
    if (result)
      gl.deleteProgram(result);
    throw cause;
  }
  finally {
    for (const shader of shaders)
      gl.deleteShader(shader);
  }
}
/** A reusable typed vertex buffer; frame work does not allocate one array per node. */
class Batch {
  data = new Float32Array(4096);
  count = 0;
  allocated = 0;
  readonly buffer: WebGLBuffer;
  constructor(private gl: WebGL2RenderingContext) {
    const buffer = gl.createBuffer();
    if (!buffer)
      throw Error("Could not allocate graph buffer");
    this.buffer = buffer;
  }
  add(...values: number[]): void {
    if (this.count + values.length > this.data.length) {
      const next = new Float32Array(Math.max(this.data.length * 2, this.count + values.length));
      next.set(this.data);
      this.data = next;
    }
    this.data.set(values, this.count);
    this.count += values.length;
  }
  upload(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (this.allocated < this.data.byteLength) {
      gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
      this.allocated = this.data.byteLength;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, this.count));
  }
  dispose(): void { this.gl.deleteBuffer(this.buffer); }
}
/** CSS is rasterized once into an atlas; movement only changes GPU vertices. */
class Atlas {
  readonly pages: AtlasPage[] = [];
  private sprites = new Map<string, Sprite>();
  readonly size: number;
  readonly texture: WebGLTexture;
  private layers = 0;
  get cachedCount(): number { return this.sprites.size; }
  constructor(private gl: WebGL2RenderingContext, readonly ratio: number) {
    this.size = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const texture = gl.createTexture();
    if (!texture)
      throw Error("Could not allocate graph atlas");
    this.texture = texture;
  }
  get(key: string, width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): Sprite {
    const cached = this.sprites.get(key);
    if (cached)
      return cached;
    const pw = Math.ceil(width * this.ratio) + 2, ph = Math.ceil(height * this.ratio) + 2;
    if (pw > this.size || ph > this.size)
      throw Error("Graph sprite exceeds texture size");
    let page = this.pages.at(-1);
    if (page && page.x + pw > this.size) {
      page.x = 0;
      page.y += page.rowHeight;
      page.rowHeight = 0;
    }
    if (!page || page.y + ph > this.size) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = this.size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw Error("Could not allocate graph atlas");
      }
      page = { canvas, ctx, x: 0, y: 0, rowHeight: 0, dirty: true };
      this.pages.push(page);
    }
    const sprite = { page: this.pages.length - 1, x: page.x + 1, y: page.y + 1, width: pw - 2, height: ph - 2, cssWidth: width, cssHeight: height };
    page.ctx.save();
    page.ctx.translate(sprite.x, sprite.y);
    page.ctx.scale(this.ratio, this.ratio);
    draw(page.ctx);
    page.ctx.restore();
    page.x += pw;
    page.rowHeight = Math.max(page.rowHeight, ph);
    page.dirty = true;
    this.sprites.set(key, sprite);
    return sprite;
  }
  upload(): void {
    const gl = this.gl;
    if (!this.pages.length)
      return;
    if (this.pages.length > gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS))
      throw Error("Graph exceeds atlas layer limit");
    // One texture array preserves sprite ordering even after the atlas grows.
    // Upload unpremultiplied colour; the sprite shader premultiplies for blending.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    if (this.layers !== this.pages.length) {
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, this.size, this.size, this.pages.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.layers = this.pages.length;
      for (const page of this.pages)
        page.dirty = true;
    }
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i]!;
      if (!page.dirty)
        continue;
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, this.size, this.size, 1, gl.RGBA, gl.UNSIGNED_BYTE, page.canvas);
      page.dirty = false;
    }
    const error = gl.getError();
    if (error !== gl.NO_ERROR)
      throw Error(`Graph atlas upload failed (${error})`);
  }
  dispose(): void { this.gl.deleteTexture(this.texture); this.pages.length = 0; this.sprites.clear(); }
}
/** Shared curve mesh. The shader evaluates one instance per edge on the GPU. */
export function beamTemplate(segments = 16): Float32Array {
  const data = new Float32Array(segments * 12);
  for (let i = 0; i < segments; i++) {
    const a = i / segments, b = (i + 1) / segments;
    data.set([a, 1, a, -1, b, 1, b, 1, a, -1, b, -1], i * 12);
  }
  return data;
}
export class ExploreWebGLRenderer {
  private flat: WebGLProgram;
  private sprites: WebGLProgram;
  private edgeBatch: Batch;
  private template: WebGLBuffer;
  private quad: WebGLBuffer;
  private edgeVao: WebGLVertexArrayObject;
  private spriteVao: WebGLVertexArrayObject;
  private flatSize: WebGLUniformLocation | null;
  private flatWidth: WebGLUniformLocation | null;
  private spriteSize: WebGLUniformLocation | null;
  private spriteAtlas: WebGLUniformLocation | null;
  private spriteBatch: Batch;
  private atlas: Atlas;
  private nodes = new Map<string, StyledNode>();
  private beams = new Map<string, StyledBeam>();
  private colors = new Map<string, Rgba>();
  private colorCanvas: CanvasRenderingContext2D;
  private palette: GraphPalette = { surface: "white", accent: "blue", ink: "black", muted: "gray" };
  private reduced = false;
  private hovered: string | null = null;
  private focused: string | null = null;
  private width = 0;
  private height = 0;
  private styles: {
    nodes: readonly GraphNodeStyle[];
    beams: readonly BeamStyle[];
    palette: GraphPalette;
  } | null = null;
  private fontEpoch = 0;
  constructor(private canvas: HTMLCanvasElement, private gl: WebGL2RenderingContext, ratio: number) {
    // Roll back every partial allocation if initialization fails.
    const cleanup: Array<() => void> = [];
    try {
      this.flat = program(gl, VIEW_VERTEX, COLOR_FRAGMENT);
      cleanup.push(() => gl.deleteProgram(this.flat));
      this.sprites = program(gl, SPRITE_VERTEX, SPRITE_FRAGMENT);
      cleanup.push(() => gl.deleteProgram(this.sprites));
      this.edgeBatch = new Batch(gl);
      cleanup.push(() => this.edgeBatch.dispose());
      this.spriteBatch = new Batch(gl);
      cleanup.push(() => this.spriteBatch.dispose());
      const template = gl.createBuffer(), quad = gl.createBuffer(), edgeVao = gl.createVertexArray(), spriteVao = gl.createVertexArray();
      if (template)
        cleanup.push(() => gl.deleteBuffer(template));
      if (quad)
        cleanup.push(() => gl.deleteBuffer(quad));
      if (edgeVao)
        cleanup.push(() => gl.deleteVertexArray(edgeVao));
      if (spriteVao)
        cleanup.push(() => gl.deleteVertexArray(spriteVao));
      if (!template || !quad || !edgeVao || !spriteVao)
        throw Error("Could not allocate graph geometry");
      this.template = template;
      this.quad = quad;
      this.edgeVao = edgeVao;
      this.spriteVao = spriteVao;
      gl.bindVertexArray(edgeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, template);
      gl.bufferData(gl.ARRAY_BUFFER, beamTemplate(), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBatch.buffer);
      for (const [at, size, offset] of [[1, 2, 0], [2, 2, 8], [3, 2, 16], [4, 4, 24]]) {
        gl.enableVertexAttribArray(at!);
        gl.vertexAttribPointer(at!, size!, gl.FLOAT, false, 40, offset!);
        gl.vertexAttribDivisor(at!, 1);
      }
      gl.bindVertexArray(spriteVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      gl.bindVertexArray(null);
      this.flatSize = gl.getUniformLocation(this.flat, "uSize");
      this.flatWidth = gl.getUniformLocation(this.flat, "uWidth");
      this.spriteSize = gl.getUniformLocation(this.sprites, "uSize");
      this.spriteAtlas = gl.getUniformLocation(this.sprites, "uAtlas");
      this.atlas = new Atlas(gl, ratio);
      cleanup.push(() => this.atlas.dispose());
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx)
        throw Error("Graph label rasterizer unavailable");
      ctx.canvas.width = ctx.canvas.height = 1;
      this.colorCanvas = ctx;
    }
    catch (cause) {
      for (const release of cleanup.reverse())
        release();
      throw cause;
    }
  }
  private color(value: string): Rgba {
    const cached = this.colors.get(value);
    if (cached)
      return cached;
    const ctx = this.colorCanvas;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const p = ctx.getImageData(0, 0, 1, 1).data, result: [
      number,
      number,
      number,
      number
    ] = [p[0]! / 255, p[1]! / 255, p[2]! / 255, p[3]! / 255];
    this.colors.set(value, result);
    return result;
  }
  private rgba(value: string, alpha = 1): string { const c = this.color(value); return `rgba(${c[0] * 255},${c[1] * 255},${c[2] * 255},${c[3] * alpha})`; }
  private dot(style: GraphNodeStyle): Sprite {
    const diameter = style.diameter, radius = diameter / 2, size = diameter + 48, tint = this.color(style.tint);
    const key = JSON.stringify(["dot", style.tint, diameter, style.selected, style.here, style.missing, this.palette.surface, this.palette.accent, this.palette.muted]);
    return this.atlas.get(key, size, size, ctx => {
      const middle = size / 2;
      ctx.translate(middle, middle);
      const circle = (r: number) => { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); };
      if (style.missing) {
        ctx.strokeStyle = this.rgba(this.palette.muted, .75);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.stroke();
        return;
      }
      if (style.selected && !style.here) {
        ctx.shadowColor = this.rgba(style.tint, .75);
        ctx.shadowBlur = 20;
        ctx.fillStyle = style.tint;
        circle(radius + 6);
        ctx.shadowBlur = 0;
        ctx.fillStyle = this.rgba(this.palette.surface, .9);
        circle(radius + 4);
      }
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 1.9);
      halo.addColorStop(.5, "transparent");
      halo.addColorStop(.53, this.rgba(style.tint, .45));
      halo.addColorStop(1, "transparent");
      ctx.fillStyle = halo;
      circle(radius * 1.9);
      const shade = (factor: number, white = 0, alpha = 1) => `rgba(${tint[0] * 255 * factor + 255 * white},${tint[1] * 255 * factor + 255 * white},${tint[2] * 255 * factor + 255 * white},${alpha * tint[3]})`;
      const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
      gradient.addColorStop(0, shade(.55));
      gradient.addColorStop(.4, shade(.8));
      gradient.addColorStop(.7, style.tint);
      gradient.addColorStop(.92, shade(.55, .45));
      gradient.addColorStop(1, shade(1, 0, .8));
      ctx.fillStyle = gradient;
      circle(radius);
    });
  }
  private halo(style: GraphNodeStyle, spread: number, opacity: number, blur: number, shadow: number, color = this.palette.accent): Sprite {
    const size = style.diameter + 64;
    return this.atlas.get(JSON.stringify(["halo", style.diameter, spread, opacity, blur, shadow, color]), size, size, ctx => {
      const middle = size / 2, r = style.diameter / 2;
      ctx.translate(middle, middle);
      ctx.shadowColor = this.rgba(color, shadow);
      ctx.shadowBlur = blur;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (spread) {
        ctx.fillStyle = this.rgba(color, opacity);
        ctx.beginPath();
        ctx.arc(0, 0, r + spread, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
  private rim(diameter: number): Sprite {
    return this.atlas.get(`rim:${diameter}`, diameter, diameter, ctx => {
      const r = diameter / 2, g = ctx.createRadialGradient(r, r, 0, r, r, r);
      g.addColorStop(.55, "transparent");
      g.addColorStop(.88, "rgba(255,255,255,.85)");
      g.addColorStop(1, "transparent");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, diameter, diameter);
    });
  }
  private label(style: GraphNodeStyle): Sprite {
    const width = 124, height = Math.ceil(style.lineHeight) + 2;
    return this.atlas.get(JSON.stringify(["label", style.label, style.font, height, this.fontEpoch]), width, height, ctx => {
      ctx.font = style.font;
      ctx.fillStyle = "white";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      let text = style.label;
      if (ctx.measureText(text).width > 122) {
        while (text.length && ctx.measureText(text + "…").width > 122)
          text = text.slice(0, -1);
        text += "…";
      }
      ctx.fillText(text, width / 2, height / 2);
    });
  }
  setStyles(nodes: readonly GraphNodeStyle[], beams: readonly BeamStyle[], palette: GraphPalette, now: number, reduced: boolean): void {
    if (this.atlas.cachedCount > Math.max(128, nodes.length * 4) || JSON.stringify(palette) !== JSON.stringify(this.palette)) {
      this.atlas.dispose();
      this.atlas = new Atlas(this.gl, this.atlas.ratio);
    }
    this.styles = { nodes, beams, palette };
    this.palette = palette;
    this.reduced = reduced;
    const next = new Map<string, StyledNode>();
    for (const style of nodes)
      next.set(style.id, { style, dot: this.dot(style), rim: style.missing ? null : this.rim(style.diameter), here: style.here && !style.missing ? [this.halo(style, 4, .24, 18, .7), this.halo(style, 9, .06, 22, .4)] : null, hover: style.missing ? null : this.halo(style, 0, 0, 9, .8, style.tint), label: this.label(style), animation: animate(this.nodes.get(style.id)?.animation, style.leaving, now, reduced, 320, 320) });
    this.nodes = next;
    const edges = new Map<string, StyledBeam>();
    for (const style of beams)
      edges.set(style.id, { style, glow: this.color(style.glow), core: this.color(style.core), animation: animate(this.beams.get(style.id)?.animation, style.leaving, now, reduced, 220) });
    this.beams = edges;
    this.atlas.upload();
  }
  setInteraction(hovered: string | null, focused: string | null): void { this.hovered = hovered; this.focused = focused; }
  setReducedMotion(reduced: boolean, now: number): void {
    if (reduced !== this.reduced && this.styles)
      this.setStyles(this.styles.nodes, this.styles.beams, this.palette, now, reduced);
  }
  invalidateFonts(now: number): void {
    this.fontEpoch++;
    this.atlas.dispose();
    this.atlas = new Atlas(this.gl, this.atlas.ratio);
    if (this.styles)
      this.setStyles(this.styles.nodes, this.styles.beams, this.palette, now, this.reduced);
  }
  private sprite(sprite: Sprite, x: number, y: number, width: number, height: number, color: Rgba, alpha: number): void {
    const u = sprite.x / this.atlas.size, v = sprite.y / this.atlas.size, du = sprite.width / this.atlas.size, dv = sprite.height / this.atlas.size;
    this.spriteBatch.add(x, y, width, height, u, v, du, dv, color[0], color[1], color[2], alpha * color[3], sprite.page);
  }
  paint(positions: readonly GraphNodePosition[], geometry: readonly BeamGeometry[], width: number, height: number, ratio: number, now: number): void {
    if (width <= 0 || height <= 0 || this.gl.isContextLost())
      return;
    ratio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    if (this.atlas.ratio !== ratio) {
      this.atlas.dispose();
      this.atlas = new Atlas(this.gl, ratio);
      if (this.styles)
        this.setStyles(this.styles.nodes, this.styles.beams, this.palette, now, this.reduced);
    }
    const gl = this.gl;
    if (width !== this.width || height !== this.height || this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.max(1, Math.round(width * ratio));
      this.canvas.height = Math.max(1, Math.round(height * ratio));
      this.width = width;
      this.height = height;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.flat);
    gl.uniform2f(this.flatSize, width, height);
    gl.bindVertexArray(this.edgeVao);
    for (const glow of [true, false]) {
      this.edgeBatch.count = 0;
      for (const line of geometry) {
        const edge = this.beams.get(line.id);
        if (!edge)
          continue;
        const alpha = alphaAt(edge.animation, now) * (edge.style.dim ? .07 : glow ? .32 : .95);
        if (alpha > 0) {
          const c = glow ? edge.glow : edge.core;
          this.edgeBatch.add(line.from.x, line.from.y, line.control.x, line.control.y, line.to.x, line.to.y, c[0], c[1], c[2], alpha * c[3]);
        }
      }
      if (this.edgeBatch.count) {
        this.edgeBatch.upload();
        gl.uniform1f(this.flatWidth, glow ? 4 : .8);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 96, this.edgeBatch.count / 10);
      }
    }
    this.spriteBatch.count = 0;
    const white: Rgba = [1, 1, 1, 1], ink = this.color(this.palette.ink), muted = this.color(this.palette.muted);
    for (const position of positions) {
      const node = this.nodes.get(position.id);
      if (!node)
        continue;
      const hovered = position.id === this.hovered || position.id === this.focused;
      const alpha = alphaAt(node.animation, now) * (node.style.dim ? .22 : 1);
      if (alpha <= 0)
        continue;
      const scale = (hovered ? 1.18 : 1) * (.2 + .8 * alphaAt(node.animation, now));
      const size = node.dot.cssWidth * scale;
      if (node.here) {
        const pulse = this.reduced ? 0 : (1 - Math.cos(now / 2800 * Math.PI * 2)) / 2;
        for (let i = 0; i < 2; i++) {
          const halo = node.here[i]!, extent = halo.cssWidth * scale;
          this.sprite(halo, position.x - extent / 2, position.y - extent / 2, extent, extent, white, alpha * (i ? pulse : 1 - pulse));
        }
      }
      else if (hovered && node.hover && !node.style.selected) {
        const extent = node.hover.cssWidth * scale;
        this.sprite(node.hover, position.x - extent / 2, position.y - extent / 2, extent, extent, white, alpha);
      }
      this.sprite(node.dot, position.x - size / 2, position.y - size / 2, size, size, white, alpha);
      if (node.rim && (node.style.selected || hovered)) {
        const diameter = node.style.diameter * scale, pulse = this.reduced ? .45 : .45 - .25 * Math.cos(now / 2400 * Math.PI * 2);
        this.sprite(node.rim, position.x - diameter / 2, position.y - diameter / 2, diameter, diameter, white, alpha * pulse);
      }
      this.sprite(node.label, position.x - node.label.cssWidth / 2, position.y + 19, node.label.cssWidth, node.label.cssHeight, node.style.selected || node.style.here || hovered ? ink : muted, alpha);
    }
    gl.useProgram(this.sprites);
    gl.bindVertexArray(this.spriteVao);
    gl.uniform2f(this.spriteSize, width, height);
    gl.uniform1i(this.spriteAtlas, 0);
    gl.activeTexture(gl.TEXTURE0);
    const batch = this.spriteBatch;
    if (batch.count) {
      batch.upload();
      for (const [at, size, offset] of [[1, 4, 0], [2, 4, 16], [3, 4, 32], [4, 1, 48]]) {
        gl.enableVertexAttribArray(at!);
        gl.vertexAttribPointer(at!, size!, gl.FLOAT, false, 52, offset!);
        gl.vertexAttribDivisor(at!, 1);
      }
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas.texture);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batch.count / 13);
    }
  }
  dispose(): void {
    this.gl.deleteBuffer(this.template);
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteVertexArray(this.edgeVao);
    this.gl.deleteVertexArray(this.spriteVao);
    this.edgeBatch.dispose();
    this.spriteBatch.dispose();
    this.atlas.dispose();
    this.gl.deleteProgram(this.flat);
    this.gl.deleteProgram(this.sprites);
  }
}
export function createExploreWebGL(canvas: HTMLCanvasElement): ExploreWebGLRenderer | null {
  if (typeof WebGL2RenderingContext === "undefined")
    return null;
  try {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, premultipliedAlpha: true });
    return gl ? new ExploreWebGLRenderer(canvas, gl, window.devicePixelRatio || 1) : null;
  }
  catch {
    return null;
  }
}
