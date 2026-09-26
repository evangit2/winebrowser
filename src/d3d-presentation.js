// RGB565 storage uses expanded UNORM8 values because WebGPU has no RGB565
// attachment. Convert each write, preserving earlier pixels across draws/flips.
export function clearColor(argb, format) {
  const rgb = [(argb >>> 16) & 255, (argb >>> 8) & 255, argb & 255].map((v, i) =>
    format === 23 ? Math.round((v * (i === 1 ? 63 : 31)) / 255) / (i === 1 ? 63 : 31) : v / 255,
  );
  return { r: rgb[0], g: rgb[1], b: rgb[2], a: format === 23 ? 1 : (argb >>> 24) / 255 };
}

function splitArguments(text) {
  const args = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(' || text[i] === '<') depth++;
    if (text[i] === ')' || text[i] === '>') depth--;
    if (text[i] === ',' && !depth) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) args.push(text.slice(start).trim());
  return args;
}
const stripBindings = (text) => text.replace(/@\w+(?:\([^)]*\))?\s*/g, '').trim();
function structBody(wgsl, type) {
  return new RegExp(`\\bstruct\\s+${type}\\s*\\{([^}]+)\\}`).exec(wgsl)?.[1] ?? '';
}

// Wrap Naga's canonical WGSL entry point, leaving all original shader logic
// (including discard and depth output) intact. WebGPU validates the result.
// This applies only to the supported single RGBA color output.
export function rgb565Shader(wgsl, entryPoint, dither = false) {
  const match = new RegExp(`@fragment\\s+fn\\s+${entryPoint}\\s*\\(`).exec(wgsl);
  if (!match) throw Error('RGB565 shader has no fragment entry point');
  let close = match.index + match[0].length,
    nesting = 1;
  const start = close;
  while (close < wgsl.length && nesting) {
    if (wgsl[close] === '(') nesting++;
    if (wgsl[close] === ')') nesting--;
    close++;
  }
  const body = wgsl.indexOf('{', close);
  if (nesting || body < 0) throw Error('Invalid RGB565 fragment signature');
  const result = wgsl
    .slice(close, body)
    .trim()
    .replace(/^->\s*/, '');
  const type = stripBindings(result);
  let output = '';
  if (!/^@location\(0\)\s+vec4<f32>$/.test(result)) {
    const members = structBody(wgsl, type);
    const locations = [...members.matchAll(/@location\((\d+)\)/g)];
    const field = /@location\(0\)\s+(\w+)\s*:\s*vec4<f32>/.exec(members);
    if (locations.length !== 1 || !field) throw Error('Unsupported RGB565 fragment color outputs');
    output = '.' + field[1];
  }
  let prefix = 'winebrowser_color_';
  while (wgsl.includes(prefix)) prefix += 'x';
  const args = splitArguments(wgsl.slice(start, close - 1));
  const plain = args.map(stripBindings);
  const names = plain.map((a) => {
    const found = /^(\w+)\s*:/.exec(a);
    if (!found) throw Error('Invalid RGB565 fragment input');
    return found[1];
  });
  let position;
  for (let i = 0; i < args.length; i++) {
    if (/@builtin\(position\)/.test(args[i])) position = names[i];
    const type = /:\s*(\w+)\s*$/.exec(plain[i])?.[1];
    if (type) {
      const member = /@builtin\(position\)\s+(\w+)\s*:/.exec(structBody(wgsl, type));
      if (member) position = names[i] + '.' + member[1];
    }
  }
  if (!position) {
    position = prefix + 'position';
    args.push(`@builtin(position) ${position}: vec4<f32>`);
  }
  const original =
    wgsl.slice(0, match.index) +
    `fn ${prefix}guest(${plain.join(', ')}) -> ${type} ` +
    wgsl.slice(body);
  return (
    original +
    `
fn ${prefix}convert(color: vec4<f32>, position: vec2<f32>) -> vec4<f32> {
  let rgb = clamp(color.rgb, vec3(0.0), vec3(1.0));
  let levels = vec3(31.0, 63.0, 31.0);
  ${
    dither
      ? `let bayer = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
  let p = vec2<u32>(position) & vec2<u32>(3u);
  let threshold = (f32(bayer[p.y * 4u + p.x]) + 0.5) / 16.0;`
      : 'let threshold = 0.5;'
  }
  return vec4(floor(rgb * levels + vec3(threshold)) / levels, 1.0);
}
@fragment fn ${entryPoint}(${args.join(', ')}) -> ${result} {
  var ${prefix}value = ${prefix}guest(${names.join(', ')});
  ${prefix}value${output} = ${prefix}convert(${prefix}value${output}, ${position}.xy);
  return ${prefix}value;
}
`
  );
}
