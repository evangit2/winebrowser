import { colorRefRgb, rgbColorRef } from './gdi-raster.js';
import { expandDibChannel } from './gdi-dib.js';
export function createNearestColorApis({ stateFor, getDc, dibPalette, success, failure }) {
  return {
    'gdi32.dll!GetNearestColor': (r, a) => {
      const state = stateFor(r),
        dc = getDc(r, state, a(0));
      if (!dc) return failure(r, 6, 0xffffffff, 2);
      const color = a(1) >>> 0;
      if (dc.kind !== 'memory-dc') return success(color, 2);
      let rgb = colorRefRgb(color);
      if (color & 0x01000000) {
        const palette = dibPalette(state, dc);
        rgb = palette?.[color & 0xffff] ?? palette?.[0] ?? [0, 0, 0];
      }
      const layout = dc.surface.dib?.layout,
        depth = layout?.depth ?? dc.surface.depth ?? (dc.surface.monochrome ? 1 : 32);
      if (color >>> 16 === 0x10ff) {
        const table =
          layout?.palette ??
          (depth === 1
            ? [
                [0, 0, 0],
                [255, 255, 255],
              ]
            : []);
        return success(rgbColorRef(table[color & 0xffff] ?? [0, 0, 0]), 2);
      }
      if (depth <= 8) {
        const palette = layout?.palette ?? [
          [0, 0, 0],
          [255, 255, 255],
        ];
        let nearest = palette[0],
          best = Infinity;
        for (const entry of palette) {
          const distance = rgb.reduce((sum, v, i) => sum + (v - entry[i]) ** 2, 0);
          if (distance < best) {
            nearest = entry;
            best = distance;
          }
          if (!distance) break;
        }
        return success(rgbColorRef(nearest), 2);
      }
      if (layout && [16, 32].includes(depth))
        rgb = rgb.map((channel, i) => {
          const mask = layout.masks[i],
            low = (mask & -mask) >>> 0,
            max = (mask >>> 0) / low,
            bits = Math.log2(max + 1);
          if (bits >= 8) return channel;
          const value = channel >> (8 - bits);
          return expandDibChannel(value, bits);
        });
      return success(rgbColorRef(rgb), 2);
    },
  };
}
