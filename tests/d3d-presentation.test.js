import test from 'node:test';
import assert from 'node:assert/strict';
import { clearColor, rgb565Shader } from '../src/d3d-presentation.js';

test('clear conversion rounds into RGB565 storage without losing RGB32 alpha', () => {
  assert.deepEqual(clearColor(0x807f3f1f, 22), {
    r: 127 / 255,
    g: 63 / 255,
    b: 31 / 255,
    a: 128 / 255,
  });
  assert.deepEqual(clearColor(0x007f3f1f, 23), { r: 15 / 31, g: 16 / 63, b: 4 / 31, a: 1 });
  assert.deepEqual(clearColor(0xffffffff, 23), { r: 1, g: 1, b: 1, a: 1 });
});

test('RGB565 wrapping retains shader bodies and separates entry-point IO from ordinary parameters', () => {
  const code = `@fragment fn main(@location(0) @interpolate(flat, first) c: vec4<f32>, @builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    if (pos.x < 4.0) { discard; } return c;
  }`;
  const result = rgb565Shader(code, 'main', true);
  assert.equal((result.match(/@fragment/g) ?? []).length, 1);
  assert.equal((result.match(/@builtin\(position\)/g) ?? []).length, 1);
  assert.match(result, /fn winebrowser_color_guest\(c: vec4<f32>, pos: vec4<f32>\)/);
  assert.match(result, /if \(pos.x < 4.0\) \{ discard; \} return c;/);
  assert.match(result, /winebrowser_color_guest\(c, pos\)/);
});

test('RGB565 wrapping changes only location zero in a struct and avoids identifier collisions', () => {
  const code = `struct Result { @location(0) rgb: vec4<f32>, @builtin(frag_depth) z: f32, }
    var<private> winebrowser_color_value: f32;
    @fragment fn main() -> Result { return Result(vec4(0.5), 0.25); }`;
  const result = rgb565Shader(code, 'main');
  assert.match(result, /winebrowser_color_xvalue\.rgb = winebrowser_color_xconvert/);
  assert.match(result, /return Result\(vec4\(0.5\), 0.25\)/);
  assert.doesNotMatch(result, /\.z = /);
  assert.match(result, /@builtin\(position\)/);
  assert.throws(() => rgb565Shader('@vertex fn main() {}', 'main'), /no fragment entry/);
  assert.throws(
    () =>
      rgb565Shader('@fragment fn main() -> @location(1) vec4<f32> { return vec4(1.0); }', 'main'),
    /Unsupported.*outputs/,
  );
  assert.throws(
    () =>
      rgb565Shader(
        `struct Result { @location(0) a: vec4<f32>, @location(1) b: vec4<f32> }
    @fragment fn main() -> Result { return Result(); }`,
        'main',
      ),
    /Unsupported.*outputs/,
  );
});
