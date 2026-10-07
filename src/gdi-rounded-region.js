/*
 * Rounded region scan conversion adapted from Wine 11.0 win32u/region.c,
 * NtGdiCreateRoundRectRgn (algorithm based on Alois Zingl).
 * Copyright 1993, 1994, 1995 Alexandre Julliard
 * Modifications and additions: Copyright 1998 Huw Davies
 *                            1999 Alex Korobka
 * LGPL-2.1-or-later. Full source: third_party/wine/win32u-region.c;
 * full license: third_party/wine/COPYING.LIB.
 * JavaScript adaptation and bounded allocation: WineBrowser contributors.
 */
import { MAX_REGION_SCANLINES } from './gdi-polygon-region.js';

export function roundedRegion([left, top, right, bottom], width, height, maxRects) {
  // Windows' rounded region excludes an additional right/bottom pixel,
  // including its rectangular fallback. Do not substitute CreateRectRgn.
  right--;
  bottom--;
  width = Math.min(right - left, Math.abs(width));
  height = Math.min(bottom - top, Math.abs(height));
  if (width < 2 || height < 2) {
    const rect = [
      Math.min(left, right),
      Math.min(top, bottom),
      Math.max(left, right),
      Math.max(top, bottom),
    ];
    return rect[0] < rect[2] && rect[1] < rect[3] ? [rect] : [];
  }
  if (height > MAX_REGION_SCANLINES || width > MAX_REGION_SCANLINES) return null;
  const rows = Array.from({ length: height }, () => [0, 0, 0, 0]);
  const a = BigInt(width - 1),
    b = BigInt(height - 1),
    asq = 8n * a * a,
    bsq = 8n * b * b;
  let dx = 4n * b * b * (1n - a),
    dy = 4n * a * a * (1n + (b % 2n)),
    error = dx + dy + a * a * (b % 2n),
    x = 0,
    y = Math.floor(height / 2);
  rows[y][0] = left;
  rows[y][2] = right;
  while (x <= Math.floor(width / 2)) {
    const twice = 2n * error;
    if (twice >= dx) {
      x++;
      dx += bsq;
      error += dx;
    }
    if (twice <= dy) {
      y++;
      dy += asq;
      error += dy;
      if (y < height) {
        rows[y][0] = left + x;
        rows[y][2] = right - x;
      }
    }
  }
  for (let i = 0; i < height; i++) {
    if (i < Math.floor(height / 2)) {
      rows[i][0] = rows[height - 1 - i][0];
      rows[i][2] = rows[height - 1 - i][2];
      rows[i][1] = top + i;
    } else rows[i][1] = bottom - height + i;
    rows[i][3] = rows[i][1] + 1;
  }
  rows[Math.floor(height / 2)][1] = top + Math.floor(height / 2);
  const output = [];
  for (const row of rows) {
    if (row[0] >= row[2] || row[1] >= row[3]) continue;
    const last = output.at(-1);
    if (last && last[0] === row[0] && last[2] === row[2] && last[3] === row[1]) last[3] = row[3];
    else output.push(row);
    if (output.length > maxRects) return null;
  }
  return output;
}
