// Bitmap-created cursor images retain their supplied straight-alpha colors.
// Monochrome AND/XOR cursors need a destination-inverting layer rather than
// treating every masked pixel as transparent.
export function cursorPresentation(image) {
  const { width, height, pixels, native } = image;
  const normal = pixels.slice(),
    inverse = new Uint8Array(pixels.length);
  let inversion = false;
  if (native && !native.alpha) {
    for (let i = 0; i < width * height; i++) {
      const at = i * 4;
      if (!native.mask[i]) {
        normal.set(native.color.subarray(at, at + 3), at);
        normal[at + 3] = 255;
      } else {
        normal.fill(0, at, at + 4);
        const rgb = native.color.subarray(at, at + 3);
        if (rgb.some((value) => value !== 0 && value !== 255))
          throw Error('Arbitrary color XOR cursor presentation is unsupported');
        if (rgb.some((value) => value)) {
          inverse.set(rgb, at);
          inverse[at + 3] = 255;
          inversion = true;
        }
      }
    }
  }
  return { normal, inverse, inversion };
}
