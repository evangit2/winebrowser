// Win32 DLUs use the dialog font's alphabet average and text line height.
// Canvas supplies the browser's actual font substitution metrics; fallback
// metrics keep headless unit execution bounded when no display is present.
export function measureDialogUnits(font, Canvas = globalThis.OffscreenCanvas) {
  if (!font) return { x: 8, y: 16 };
  const fallback = { x: Math.max(1, Math.round(font.height / 2)), y: font.height };
  if (typeof Canvas !== 'function') return fallback;
  const context = new Canvas(1, 1).getContext('2d');
  if (!context) return fallback;
  context.font = font.css;
  const metrics = context.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
  const width = metrics.width;
  const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  return {
    x:
      Number.isFinite(width) && width > 0
        ? Math.max(1, Math.floor((Math.floor(width / 26) + 1) / 2))
        : fallback.x,
    y: Number.isFinite(height) && height > 0 ? Math.ceil(height) : fallback.y,
  };
}
const mulDiv = (value, base, divisor) =>
  Math.sign(value) * Math.floor((Math.abs(value) * base) / divisor + 0.5);
export const dialogX = (units, value) => mulDiv(value, units?.x ?? 8, 4);
export const dialogY = (units, value) => mulDiv(value, units?.y ?? 16, 8);
