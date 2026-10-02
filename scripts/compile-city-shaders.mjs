// Compile Microsoft's original HLSL to SM5 DXBC using the same browser
// compiler shipped with WineBrowser. Application C++ remains native PE code.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const directory = resolve(process.argv[2] ?? '.cache/microsoft-dx12-city');
const server = await createServer({
  logLevel: 'error',
  server: { port: 0, watch: null, hmr: false },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${server.httpServer.address().port}/`);
  for (const name of [
    'shader_mesh_simple_vert',
    'shader_mesh_simple_pixel',
    'shader_mesh_alt_pixel',
  ]) {
    const source = await readFile(resolve(directory, name + '.hlsl'), 'utf8');
    const vertex = name.endsWith('_vert');
    const result = await page.evaluate(
      async ({ source, name, vertex }) => {
        const { ShaderCompiler } = await import('/src/shader-compiler.js');
        const compiler = new ShaderCompiler();
        const result = await compiler.compileHLSL(
          new TextEncoder().encode(source),
          vertex ? 'VSMain' : 'PSMain',
          vertex ? 'vs_5_0' : 'ps_5_0',
          name + '.hlsl',
        );
        return { bytes: [...result.bytes], messages: result.messages };
      },
      { source, name, vertex },
    );
    await writeFile(resolve(directory, name + '.cso'), Buffer.from(result.bytes));
    console.log(name + ': ' + result.bytes.length + ' bytes. ' + result.messages);
  }
} finally {
  await browser?.close();
  await server.close();
}
