// Adapt iced's published Node binding to browser ESM; the decoder WASM is unchanged.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
const dir = new URL('../public/vendor/', import.meta.url);
await mkdir(dir, { recursive: true });
let source = await readFile(
  new URL('../node_modules/iced-x86/iced_x86.js', import.meta.url),
  'utf8',
);
source =
  'const module = {exports:{}};\n' +
  source.replace('const { TextDecoder, TextEncoder } = require(`util`);', '');
const start = source.lastIndexOf("const path = require('path')");
if (start < 0) throw Error('iced binding format changed');
source =
  source.slice(0, start) +
  `\nexport async function init() {\n const response = await fetch(new URL('./iced_x86_bg.wasm',import.meta.url));\n if (!response.ok) throw Error('Decoder download failed');\n wasm = (await WebAssembly.instantiate(await response.arrayBuffer(), imports)).instance.exports;\n return module.exports;\n}\n`;
await writeFile(new URL('iced.js', dir), source);
await copyFile(
  new URL('../node_modules/iced-x86/iced_x86_bg.wasm', import.meta.url),
  new URL('iced_x86_bg.wasm', dir),
);
await copyFile(
  new URL('../node_modules/iced-x86/LICENSE.txt', import.meta.url),
  new URL('../third_party/iced-x86-LICENSE.txt', import.meta.url),
);
