/**
 * Canvas-backed GDI text rasterizer for the browser worker. Canvas supplies
 * the platform's installed font matching and glyph rasterization; GDI uses the
 * returned alpha mask to apply each DC's foreground/background colors.
 */
export function createCanvasTextRasterizer(Canvas = globalThis.OffscreenCanvas) {
  if (typeof Canvas !== 'function') throw Error('OffscreenCanvas is unavailable');
  const measureCanvas = new Canvas(1, 1);
  const measure = measureCanvas.getContext('2d');
  const canvas = new Canvas(1, 1);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!measure || !context) throw Error('Canvas 2D context is unavailable');
  const cache = new Map();
  let cacheBytes = 0;
  const maxCacheBytes = 1024 * 1024;
  const maxCacheEntries = 256;
  return {
    rasterize(text, font) {
      const key = JSON.stringify([font.css, font.height, text]);
      const found = cache.get(key);
      if (found) {
        cache.delete(key);
        cache.set(key, found);
        return found.mask;
      }
      measure.font = font.css;
      const metrics = measure.measureText(text);
      const width = Math.max(0, Math.ceil(metrics.width));
      const height = font.height;
      if (width > 4096 || height > 256 || width * height > 1_048_576)
        throw Error('Text raster exceeds the supported canvas bounds');
      if (!width || !height)
        return { width, height, ascent: 0, alpha: new Uint8Array(width * height) };

      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.clearRect(0, 0, width, height);
      context.font = font.css;
      context.textBaseline = 'alphabetic';
      context.fillStyle = '#fff';
      const ascent = Math.max(
        0,
        Math.min(height, Math.ceil(metrics.actualBoundingBoxAscent || height * 0.8)),
      );
      context.fillText(text, 0, ascent);
      const rgba = context.getImageData(0, 0, width, height).data;
      const alpha = new Uint8Array(width * height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
      const mask = { width, height, ascent, alpha };
      const size = key.length * 2 + alpha.byteLength;
      if (size <= maxCacheBytes) {
        while (cache.size >= maxCacheEntries || cacheBytes + size > maxCacheBytes) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cacheBytes -= cache.get(oldest).size;
          cache.delete(oldest);
        }
        cache.set(key, { mask, size });
        cacheBytes += size;
      }
      return mask;
    },
  };
}

/** Read a bounded LOGFONT face-name string from guest memory. */
export function readGdiFontFace(runtime, pointer, wide) {
  if (!pointer) return '';
  if (wide) {
    let chars = '';
    for (let i = 0; i < 32; i++) {
      runtime.check(pointer + i * 2, 2);
      const unit = runtime.view.getUint16(pointer + i * 2, true);
      if (!unit) return chars;
      chars += String.fromCharCode(unit);
    }
  } else {
    const bytes = new Uint8Array(runtime.memory.buffer ?? runtime.memory);
    const encoded = [];
    for (let i = 0; i < 32; i++) {
      runtime.check(pointer + i, 1);
      const byte = bytes[pointer + i];
      if (!byte) return new TextDecoder('windows-1252').decode(new Uint8Array(encoded));
      encoded.push(byte);
    }
  }
  throw Error('Font face name exceeds 31 characters');
}

/**
 * Create a browser-backed font descriptor from CreateFont parameters. The
 * caller remains responsible for allocating/owning the returned HFONT.
 */
export function makeGdiFontDescriptor(runtime, argument, wide) {
  const heightArg = argument(0) | 0;
  const width = argument(1) | 0;
  const escapement = argument(2) | 0;
  const orientation = argument(3) | 0;
  const weight = argument(4) >>> 0;
  const italic = argument(5) >>> 0;
  const underline = argument(6) >>> 0;
  const strikeout = argument(7) >>> 0;
  const charset = argument(8) >>> 0;
  const outPrecision = argument(9) >>> 0;
  const clipPrecision = argument(10) >>> 0;
  const quality = argument(11) >>> 0;
  const pitchAndFamily = argument(12) >>> 0;
  if (
    width !== 0 ||
    escapement !== 0 ||
    orientation !== 0 ||
    ![0, 1].includes(italic) ||
    ![0, 1].includes(underline) ||
    ![0, 1].includes(strikeout) ||
    ![0, 1].includes(charset) ||
    outPrecision !== 0 ||
    clipPrecision !== 0 ||
    quality !== 0 ||
    pitchAndFamily !== 0 ||
    weight > 1000 ||
    Math.abs(heightArg) > 256
  )
    throw Error('Unsupported CreateFont parameters');

  const face = readGdiFontFace(runtime, argument(13) >>> 0, wide);
  const height = heightArg === 0 ? 16 : Math.max(1, Math.abs(heightArg));
  const cssWeight = weight === 0 ? 400 : weight;
  const css = `${italic ? 'italic ' : ''}${cssWeight} ${height}px ${JSON.stringify(face || 'sans-serif')}`;
  return {
    kind: 'font',
    css,
    height,
    requestedHeight: heightArg,
    face: face || 'sans-serif',
    weight: cssWeight,
    italic: !!italic,
    underline: !!underline,
    strikeout: !!strikeout,
  };
}

/** Decode the explicit-length ANSI/UTF-16 range supplied to TextOut. */
export function readGdiText(runtime, pointer, count, wide) {
  if (count === 0) return '';
  if (!pointer || count < 0 || count > 32768) throw Error('Invalid text range');
  const bytesPerChar = wide ? 2 : 1;
  runtime.check(pointer, count * bytesPerChar);
  const bytes = new Uint8Array(runtime.memory.buffer ?? runtime.memory);
  if (!wide)
    return new TextDecoder('windows-1252').decode(bytes.subarray(pointer, pointer + count));
  const units = new Array(count);
  for (let i = 0; i < count; i++) units[i] = runtime.view.getUint16(pointer + i * 2, true);
  return String.fromCharCode(...units);
}

/** Render text through the injected real canvas backend; absent backends fail. */
export function rasterizeGdiText(runtime, text, font) {
  const rasterizer = runtime.gdiTextRasterizer;
  if (!rasterizer || typeof rasterizer.rasterize !== 'function') return { error: 'backend' };
  let mask;
  try {
    mask = rasterizer.rasterize(text, font);
  } catch {
    return { error: 'invalid' };
  }
  if (
    !mask ||
    !Number.isInteger(mask.width) ||
    !Number.isInteger(mask.height) ||
    mask.width < 0 ||
    mask.height < 0 ||
    mask.width > 4096 ||
    mask.height > 256 ||
    !(mask.alpha instanceof Uint8Array) ||
    mask.alpha.length !== mask.width * mask.height
  )
    return { error: 'invalid' };
  return { mask };
}

/** Composite one alpha mask into the selected DC surface and mark it dirty. */
export function paintGdiText(surface, dc, x, y, mask, font) {
  const left = Math.max(0, x),
    top = Math.max(0, y);
  const right = Math.min(surface.width, x + mask.width);
  const bottom = Math.min(surface.height, y + mask.height);
  if (dc.bkMode === 2 && right > left && bottom > top) {
    const bg = surfaceRgb(surface, colorRefRgb(dc.backgroundColor));
    for (let py = top; py < bottom; py++)
      for (let px = left; px < right; px++) {
        const offset = (py * surface.width + px) * 4;
        surface.pixels[offset] = bg[0];
        surface.pixels[offset + 1] = bg[1];
        surface.pixels[offset + 2] = bg[2];
        surface.pixels[offset + 3] = 255;
      }
    surface.dirty = true;
  }
  const fg = surfaceRgb(surface, colorRefRgb(dc.textColor));
  let changed = false;
  for (let py = top; py < bottom; py++)
    for (let px = left; px < right; px++) {
      const alpha = mask.alpha[(py - y) * mask.width + (px - x)];
      if (!alpha) continue;
      const offset = (py * surface.width + px) * 4;
      const inverse = 255 - alpha;
      const red = Math.round((fg[0] * alpha + surface.pixels[offset] * inverse) / 255);
      const green = Math.round((fg[1] * alpha + surface.pixels[offset + 1] * inverse) / 255);
      const blue = Math.round((fg[2] * alpha + surface.pixels[offset + 2] * inverse) / 255);
      if (
        surface.pixels[offset] !== red ||
        surface.pixels[offset + 1] !== green ||
        surface.pixels[offset + 2] !== blue
      )
        changed = true;
      surface.pixels[offset] = red;
      surface.pixels[offset + 1] = green;
      surface.pixels[offset + 2] = blue;
      surface.pixels[offset + 3] = 255;
    }
  if (changed) surface.dirty = true;
  for (const decorationY of [
    font.underline ? Math.min(bottom - 1, y + font.height - 2) : -1,
    font.strikeout ? y + Math.floor(font.height / 2) : -1,
  ]) {
    if (decorationY >= top && decorationY < bottom) {
      for (let px = left; px < right; px++) {
        const offset = (decorationY * surface.width + px) * 4;
        surface.pixels[offset] = fg[0];
        surface.pixels[offset + 1] = fg[1];
        surface.pixels[offset + 2] = fg[2];
        surface.pixels[offset + 3] = 255;
      }
      surface.dirty = true;
    }
  }
}
import { colorRefRgb, surfaceRgb } from './gdi-raster.js';

export const DEFAULT_GDI_FONT = Object.freeze({
  kind: 'font',
  css: '16px sans-serif',
  height: 16,
  face: 'sans-serif',
  weight: 400,
  italic: false,
  underline: false,
  strikeout: false,
});
