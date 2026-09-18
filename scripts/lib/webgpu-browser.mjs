// Linux CI has no physical GPU. Route both ANGLE and WebGPU through the same
// Vulkan/SwiftShader backend so OffscreenCanvas presentation can be exercised.
// These launch flags apply only to automated fixture tests, never the harness.
export const webgpuBrowserOptions = {
  channel: process.env.BROWSER_CHANNEL || 'chrome',
  args: [
    '--enable-unsafe-webgpu',
    ...(process.platform === 'linux'
      ? [
          '--use-angle=vulkan',
          '--enable-features=Vulkan',
          '--use-vulkan=swiftshader',
          '--disable-vulkan-surface',
        ]
      : []),
  ],
};
