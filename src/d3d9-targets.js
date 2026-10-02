import {
  deviceSurface,
  surfaceStorage,
  releaseDeviceSurface,
  freeTexture,
  invalidate,
} from './d3d9-textures.js';
import { defaultViewport } from './d3d-viewport.js';

const INVALID = 0x8876086c;
const DEPTH_FORMATS = { 75: 'depth24plus-stencil8', 77: 'depth24plus', 80: 'depth16unorm' };
const owner = (surface) => surface.state.texture?.state ?? surface.state;

function targetId(runtime, surface) {
  const level = surface.state.level;
  if (!level.targetId) {
    runtime.d3dTargetSequence = (runtime.d3dTargetSequence ?? 0) + 1;
    if (runtime.d3dTargetSequence > 0xffffffff) throw Error('D3D target identity limit exceeded');
    level.targetId = runtime.d3dTargetSequence;
  }
  return level.targetId;
}

export function targetDescription(runtime, device, surface = device.state.renderTarget) {
  if (surface === device.state.backBuffer) return null;
  const level = surface.state.level;
  return {
    id: targetId(runtime, surface),
    width: level.width,
    height: level.height,
    colorFormat: owner(surface).format,
  };
}

export function depthDescription(runtime, device) {
  const surface = device.state.depthStencil;
  if (!surface) return null;
  if (surface === device.state.depthSurface) return { implicit: true };
  const level = surface.state.level;
  return {
    id: targetId(runtime, surface),
    width: level.width,
    height: level.height,
    format: DEPTH_FORMATS[owner(surface).format],
  };
}

// Preserve the native level's BGRA / RGB565 bytes. The first implementation
// reads back on an offscreen batch boundary so normal texture snapshots and
// surface copies see every preceding write in guest call order.
export function storeTargetPixels(runtime, surface, rgba) {
  const state = owner(surface),
    level = surface.state.level;
  if (!(rgba instanceof Uint8Array) || rgba.length !== level.width * level.height * 4)
    throw Error('Invalid D3D target readback');
  const base = state.base || surfaceStorage(runtime, surface);
  if (!base) throw Error('D3D target CPU storage limit exceeded');
  for (let y = 0; y < level.height; y++)
    for (let x = 0; x < level.width; x++) {
      const p = base + level.offset + y * level.pitch + x * state.bpp,
        q = (y * level.width + x) * 4;
      if (state.format === 23) {
        const value =
          (Math.round((rgba[q] * 31) / 255) << 11) |
          (Math.round((rgba[q + 1] * 63) / 255) << 5) |
          Math.round((rgba[q + 2] * 31) / 255);
        runtime.view.setUint16(p, value, true);
      } else {
        runtime.data[p] = rgba[q + 2];
        runtime.data[p + 1] = rgba[q + 1];
        runtime.data[p + 2] = rgba[q];
        runtime.data[p + 3] = state.format === 22 ? 255 : rgba[q + 3];
      }
    }
  if (surface.state.texture) invalidate(surface.state.texture);
}

export async function flushTargets(runtime, device) {
  const state = device.state;
  if (!state.commands.length) return;
  const target = targetDescription(runtime, device);
  if (!runtime.graphics?.render) throw Error('D3D target rendering backend is unavailable');
  const rgba = await runtime.graphics.render({
    id: state.id,
    commands: [...state.commands],
    target,
    depth: depthDescription(runtime, device),
    readback: !!target,
  });
  if (target) storeTargetPixels(runtime, state.renderTarget, rgba);
  state.commands = [];
  state.frameBytes = state.frameTextureBytes = 0;
  state.textureSnapshots.clear();
}

// Binding retains private references, allowing GetRenderTarget to return a
// surface after the caller releases its original reference. Texture storage
// stays alive without retaining an external device reference through a cycle.
function retainBinding(surface) {
  if (!surface) return;
  surface.state.internalRefs++;
  if (surface.state.texture) surface.state.texture.state.internalRefs++;
}

function releaseBinding(runtime, surface) {
  if (!surface) return;
  surface.state.internalRefs--;
  if (surface.state.texture) {
    surface.state.texture.state.internalRefs--;
    freeTexture(runtime, surface.state.texture);
  } else if (!surface.refs && !surface.state.internalRefs) releaseDeviceSurface(runtime, surface);
}

export function initializeTargetBindings(device) {
  retainBinding(device.state.renderTarget);
  retainBinding(device.state.depthStencil);
}

export function releaseTargetBindings(runtime, device) {
  releaseBinding(runtime, device.state.renderTarget);
  releaseBinding(runtime, device.state.depthStencil);
  device.state.renderTarget = device.state.depthStencil = null;
}

export function returnTargetSurface(runtime, surface, output) {
  if (!output) return INVALID;
  runtime.check(output, 4, true);
  runtime.write32(output, 0);
  if (!surface) return 0;
  if (surface.refs >= 0x7fffffff) throw Error('D3D surface reference limit exceeded');
  if (!surface.refs) {
    if (!surface.state.internalRefs) return INVALID;
    const texture = surface.state.texture,
      device = surface.state.device;
    if (device.refs >= 0x7fffffff || (texture && texture.refs >= 0x7fffffff))
      throw Error('D3D resource reference limit exceeded');
    if (texture) {
      if (!texture.refs) device.refs++;
      texture.refs++;
    } else if (!surface.state.implicit) device.refs++;
    runtime.comObjects.liveObjects++;
  }
  surface.refs++;
  runtime.write32(output, surface.pointer);
  return 0;
}

export async function setTarget(runtime, device, pointer, depth = false) {
  const state = device.state;
  const next = validatedTarget(runtime, device, pointer, depth);
  if (next === undefined) return INVALID;
  const field = depth ? 'depthStencil' : 'renderTarget';
  const previous = state[field];
  // Even rebinding the same color surface resets the viewport in D3D9.
  if (previous !== next) {
    await flushTargets(runtime, device);
    retainBinding(next);
    state[field] = next;
    releaseBinding(runtime, previous);
  }
  if (depth) {
    state.hasDepth = !!next;
    state.hasStencil = !!next && owner(next).format === 75;
  } else {
    const level = next.state.level;
    state.viewport = defaultViewport(level.width, level.height);
  }
  return 0;
}

export function validatedTarget(runtime, device, pointer, depth = false) {
  const surface = pointer ? deviceSurface(runtime, pointer, device) : null;
  if ((!depth && !surface) || (pointer && !surface)) return undefined;
  if (surface) {
    const resource = owner(surface);
    if (
      surface.state.level.locked ||
      !(resource.usage & (depth ? 2 : 1)) ||
      resource.pool !== 0 ||
      (depth ? !DEPTH_FORMATS[resource.format] : ![21, 22, 23].includes(resource.format))
    )
      return undefined;
  }
  return surface;
}

export async function readTargetPixels(runtime, device, source) {
  await flushTargets(runtime, device);
  const rgba = await runtime.graphics.render({
    id: device.state.id,
    commands: [],
    target: targetDescription(runtime, device, source),
    depth: null,
    readback: true,
  });
  storeTargetPixels(runtime, source, rgba);
  return rgba;
}

export async function getRenderTargetData(runtime, device, sourcePointer, destinationPointer) {
  const source = deviceSurface(runtime, sourcePointer, device),
    destination = deviceSurface(runtime, destinationPointer, device);
  if (!source || !destination || source === destination) return INVALID;
  const src = owner(source),
    dst = owner(destination),
    a = source.state.level,
    b = destination.state.level;
  if (
    !(src.usage & 1) ||
    dst.usage ||
    dst.pool !== 2 ||
    src.format !== dst.format ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.locked ||
    b.locked
  )
    return INVALID;
  const rgba = await readTargetPixels(runtime, device, source);
  storeTargetPixels(runtime, destination, rgba);
  return 0;
}
