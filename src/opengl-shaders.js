// Convert the supported desktop GLSL interface to the browser's GLSL ES 3.00.
// The guest supplies the complete shader; no application shader is substituted.
export function browserGLSL(source, stage) {
  if (typeof source !== 'string' || source.length > 1024 * 1024)
    throw Error('OpenGL shader source limit exceeded');
  const version = source.match(/^\s*#\s*version\s+(\d+)(?:\s+\w+)?/m);
  if (
    version &&
    ![110, 120, 130, 140, 150, 330, 300, 400, 410, 420, 430, 440, 450, 460].includes(
      Number(version[1]),
    )
  )
    throw Error(`Unsupported desktop GLSL version ${version[1]}`);
  source = source.replace(/^\s*#\s*version[^\n]*(?:\n|$)/m, '');
  let fragmentOutput = false;
  const builtins = new Set();
  // Tokenize comments as well as identifiers so words in a comment are kept.
  source = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|\b[A-Za-z_]\w*\b/g, (token) => {
    if (token.startsWith('/')) return token;
    if (token === 'gl_Vertex' || token === 'gl_ModelViewProjectionMatrix') {
      builtins.add(token);
      return token === 'gl_Vertex' ? '_wbVertex' : '_wbMVP';
    }
    if (token === 'attribute') return 'in';
    if (token === 'varying') return stage === 0x8b31 ? 'out' : 'in';
    if (token === 'gl_FragColor') {
      fragmentOutput = true;
      return 'wbFragmentColor';
    }
    return { texture2D: 'texture', textureCube: 'texture', texture3D: 'texture' }[token] ?? token;
  });
  return (
    '#version 300 es\nprecision highp float;\nprecision highp int;\n' +
    (fragmentOutput ? 'out vec4 wbFragmentColor;\n' : '') +
    (builtins.has('gl_Vertex') ? 'layout(location=0) in vec4 _wbVertex;\n' : '') +
    (builtins.has('gl_ModelViewProjectionMatrix')
      ? 'uniform mat4 _wbMVP;\ninvariant gl_Position;\n'
      : '') +
    '#line 1\n' +
    source
  );
}
