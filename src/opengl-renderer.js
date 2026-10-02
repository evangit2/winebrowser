import { browserGLSL } from './opengl-shaders.js';

// One WebGL2 context per guest WGL context, owned by the terminable CPU worker.
// Numeric guest names stay here; browser objects never enter guest memory.
export class OpenGLRenderer {
  constructor({ emit = () => {}, canvasFactory = (w, h) => new OffscreenCanvas(w, h) } = {}) {
    this.emit = emit;
    this.canvasFactory = canvasFactory;
    this.contexts = new Map();
    this.nextContext = 1;
    this.frames = 0;
    this.draws = 0;
  }

  create(description) {
    if (this.contexts.size >= 4) throw Error('OpenGL context limit exceeded');
    const { width, height } = description;
    if (![width, height].every((v) => Number.isInteger(v) && v > 0 && v <= 2048))
      throw Error('Invalid OpenGL window dimensions');
    const canvas = this.canvasFactory(width, height);
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      depth: true,
      stencil: true,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw Error('WebGL2 is unavailable in this browser worker');
    const id = this.nextContext++;
    const context = {
      ...description,
      id,
      canvas,
      gl,
      names: new Map(),
      nextName: 1,
      sources: new Map(),
    };
    this.contexts.set(id, context);
    canvas.addEventListener?.('webglcontextlost', (event) => {
      event.preventDefault();
      context.failure = 'OpenGL browser context lost';
    });
    this.emit({
      type: 'log',
      text: 'OpenGL desktop GLSL → WebGL2 compiler initialized in the runtime worker',
    });
    return id;
  }

  object(context, name, kind, nullable = false) {
    if (!name && nullable) return null;
    const entry = context.names.get(name);
    if (!entry || entry.kind !== kind) throw Error(`Invalid OpenGL ${kind} name ${name}`);
    return entry.object;
  }

  name(context, kind, object) {
    if (!object) return 0;
    if (context.names.size >= 4096) throw Error('OpenGL object limit exceeded');
    const name = context.nextName++;
    context.names.set(name, { kind, object });
    return name;
  }

  compile(context, shaderName) {
    const gl = context.gl;
    const shader = this.object(context, shaderName, 'shader');
    const stage = gl.getShaderParameter(shader, gl.SHADER_TYPE);
    const source = browserGLSL(context.sources.get(shaderName) ?? '', stage);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    this.emit({
      type: 'log',
      text: `OpenGL GLSL ${stage === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader compiled in browser (${gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? 'success' : gl.getShaderInfoLog(shader)})`,
    });
  }

  async present(context, description) {
    if (context.failure || context.gl.isContextLost())
      throw Error(context.failure ?? 'OpenGL context lost');
    if (context.windowId !== description.windowId)
      throw Error('SwapBuffers DC does not own the current context');
    context.gl.flush();
    // createImageBitmap snapshots without discarding the GL drawing buffer.
    const bitmap = await createImageBitmap(context.canvas);
    this.frames++;
    this.emit({
      type: 'frame',
      windowId: context.windowId,
      width: context.canvas.width,
      height: context.canvas.height,
      bitmap,
      renderer: 'webgl2',
      graphicsApi: 'opengl',
      graphicsFrames: this.frames,
      graphicsDraws: this.draws,
    });
    await new Promise((resolve) => setTimeout(resolve, context.interval === 0 ? 0 : 16));
  }

  destroy(id) {
    const context = this.contexts.get(id);
    if (!context) return false;
    context.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.contexts.delete(id);
    return true;
  }

  dispose() {
    for (const id of this.contexts.keys()) this.destroy(id);
  }
}
