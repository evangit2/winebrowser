const INVALID = 0x8876086c;
export const LIGHT_STATE_DEFAULTS = Object.freeze({
  29: 0,
  137: 1,
  139: 0,
  141: 1,
  142: 1,
  143: 0,
  145: 1,
  146: 2,
  147: 0,
  148: 0,
});
export function initLighting() {
  return {
    lightState: { ...LIGHT_STATE_DEFAULTS },
    material: new Float32Array(17),
    lights: new Map(),
  };
}
export function setLightingState(state, type, value) {
  if (type === 139 || ([145, 146, 147, 148].includes(type) ? value <= 2 : value <= 1)) {
    state.lightState[type] = value;
    return 0;
  }
  return INVALID;
}
function readFloats(r, pointer, count) {
  r.check(pointer, count * 4);
  return new Float32Array(r.data.slice(pointer, pointer + count * 4).buffer);
}
function writeFloats(r, pointer, values) {
  r.check(pointer, values.byteLength, true);
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
  bits.forEach((v, i) => r.write32(pointer + i * 4, v));
}
export const validMaterial = (m) =>
  m instanceof Float32Array && m.length === 17 && m.every(Number.isFinite) && m[16] >= 0;
export function validLight(light) {
  if (!(light instanceof Float32Array) || light.length !== 26) return false;
  const type = new Uint32Array(light.buffer, light.byteOffset, 1)[0];
  return (
    [1, 2, 3].includes(type) &&
    light.subarray(1).every(Number.isFinite) &&
    (type === 3 || (light[19] >= 0 && light[21] >= 0 && light[22] >= 0 && light[23] >= 0)) &&
    (type !== 2 ||
      (light[20] >= 0 &&
        light[24] >= 0 &&
        light[24] <= light[25] &&
        light[25] <= Math.fround(Math.PI)))
  );
}
function defaultLight() {
  const l = new Float32Array(26);
  new Uint32Array(l.buffer)[0] = 3;
  l.set([1, 1, 1], 1);
  l[18] = 1;
  return l;
}
export const lightingMethods = {
  49: {
    argc: 2,
    invoke(r, a, o) {
      if (!a(1)) return INVALID;
      const material = readFloats(r, a(1), 17);
      if (!validMaterial(material)) return INVALID;
      o.state.material = material;
      return 0;
    },
  },
  50: {
    argc: 2,
    invoke(r, a, o) {
      if (!a(1)) return INVALID;
      writeFloats(r, a(1), o.state.material);
      return 0;
    },
  },
  51: {
    argc: 3,
    invoke(r, a, o) {
      if (!a(2)) return INVALID;
      const light = readFloats(r, a(2), 26),
        index = a(1) >>> 0;
      if (!validLight(light)) return INVALID;
      if (!o.state.lights.has(index) && o.state.lights.size >= 256)
        throw Error('D3D stored light limit exceeded');
      o.state.lights.set(index, {
        values: light,
        enabled: o.state.lights.get(index)?.enabled ?? false,
      });
      return 0;
    },
  },
  52: {
    argc: 3,
    invoke(r, a, o) {
      const l = o.state.lights.get(a(1) >>> 0);
      if (!l || !a(2)) return INVALID;
      writeFloats(r, a(2), l.values);
      return 0;
    },
  },
  53: {
    argc: 3,
    invoke(_r, a, o) {
      const lights = o.state.lights,
        index = a(1) >>> 0,
        enable = !!a(2),
        previous = lights.get(index);
      if (enable && !previous?.enabled && [...lights.values()].filter((l) => l.enabled).length >= 8)
        return INVALID;
      if (!previous && lights.size >= 256) throw Error('D3D stored light limit exceeded');
      lights.set(index, { values: previous?.values ?? defaultLight(), enabled: enable });
      return 0;
    },
  },
  54: {
    argc: 3,
    invoke(r, a, o) {
      const l = o.state.lights.get(a(1) >>> 0);
      if (!l || !a(2)) return INVALID;
      r.check(a(2), 4, true);
      r.write32(a(2), l.enabled ? 128 : 0);
      return 0;
    },
  },
};
export function lightingSnapshot(state) {
  if (!state.lightState[137]) return null;
  return {
    states: { ...state.lightState },
    material: state.material.slice(),
    lights: [...state.lights.values()].filter((l) => l.enabled).map((l) => l.values.slice()),
  };
}
export function validLighting(value) {
  if (!value) return true;
  return (
    validMaterial(value.material) &&
    Array.isArray(value.lights) &&
    value.lights.length <= 8 &&
    value.lights.every(validLight) &&
    Object.keys(LIGHT_STATE_DEFAULTS).every((k) => {
      const n = value.states?.[k];
      return (
        Number.isInteger(n) &&
        n >= 0 &&
        n <= (+k === 139 ? 0xffffffff : [145, 146, 147, 148].includes(+k) ? 2 : 1)
      );
    })
  );
}
// Inverse transpose of the world-view linear part. D3D row-vector matrices
// arrive transposed as WGSL column matrices. Translation does not affect normals.
export function normalMatrix(world, view) {
  if ([world, view].some((m) => m[3] || m[7] || m[11] || m[15] !== 1))
    throw Error('D3D lighting requires affine world and view transforms');
  const m = Array.from({ length: 3 }, (_, row) =>
    Array.from(
      { length: 3 },
      (_, col) =>
        view[row] * world[col * 4] +
        view[4 + row] * world[col * 4 + 1] +
        view[8 + row] * world[col * 4 + 2],
    ),
  );
  const [a, b, c] = m;
  const cross = (u, v) => [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const cof = [cross(b, c), cross(c, a), cross(a, b)],
    det = a.reduce((s, v, i) => s + v * cof[0][i], 0);
  if (!Number.isFinite(det) || det === 0)
    throw Error('D3D lighting requires an invertible world-view transform');
  const result = new Float32Array(12);
  for (let col = 0; col < 3; col++)
    for (let row = 0; row < 3; row++) result[col * 4 + row] = cof[row][col] / det;
  if (!result.every(Number.isFinite)) throw Error('D3D normal transform exceeds finite precision');
  return result;
}
export function lightingUniforms(command) {
  const l = command.lighting,
    data = new Float32Array(308);
  data.set([...command.world, ...command.view, ...command.projection]);
  data.set(
    command.fvf & 0x10
      ? normalMatrix(command.world, command.view)
      : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    48,
  );
  data.set(l.material.subarray(0, 16), 60);
  data[76] = l.material[16];
  data[77] = l.lights.length;
  const ambient = l.states[139];
  data.set(
    [((ambient >>> 16) & 255) / 255, ((ambient >>> 8) & 255) / 255, (ambient & 255) / 255, 1],
    80,
  );
  l.lights.forEach((v, i) => {
    const offset = 84 + i * 28,
      type = new Uint32Array(v.buffer, v.byteOffset, 1)[0];
    data.set([...v.subarray(13, 16), type], offset);
    data.set([...v.subarray(16, 19), v[19]], offset + 4);
    data.set(v.subarray(1, 5), offset + 8);
    data.set(v.subarray(5, 9), offset + 12);
    data.set(v.subarray(9, 13), offset + 16);
    data.set([v[21], v[22], v[23], v[20]], offset + 20);
    data.set([Math.cos(v[24] / 2), Math.cos(v[25] / 2), 0, 0], offset + 24);
  });
  return data;
}
export const lightingStruct = `
struct Light { position:vec4<f32>, direction:vec4<f32>, diffuse:vec4<f32>, specular:vec4<f32>, ambient:vec4<f32>, attenuation:vec4<f32>, cone:vec4<f32> }
`;
export const lightingFields = `, normal:mat3x3<f32>, materialDiffuse:vec4<f32>, materialAmbient:vec4<f32>, materialSpecular:vec4<f32>, materialEmissive:vec4<f32>, lightParams:vec4<f32>, globalAmbient:vec4<f32>, lights:array<Light,8>`;
export function lightingCode(command, layout) {
  const states = command.lighting.states;
  const source = (state, material) =>
    states[141] && states[state] === 1 && layout.diffuse !== null
      ? 'color1'
      : states[141] && states[state] === 2 && layout.specular !== null
        ? 'color2'
        : `transforms.material${material}`;
  return `
fn safeNormalize(v:vec3<f32>)->vec3<f32> { return v * inverseSqrt(max(dot(v,v),1e-30)); }
fn lightVertex(position:vec3<f32>, inputNormal:vec3<f32>, color1:vec4<f32>, color2:vec4<f32>)->array<vec4<f32>,2> {
  let normal = ${states[143] ? 'safeNormalize(transforms.normal * inputNormal)' : 'transforms.normal * inputNormal'};
  let materialDiffuse = ${source(145, 'Diffuse')};
  let materialAmbient = ${source(147, 'Ambient')};
  let materialSpecular = ${source(146, 'Specular')};
  let materialEmissive = ${source(148, 'Emissive')};
  var ambient = transforms.globalAmbient.rgb;
  var diffuse = vec3(0.0);var specular=vec3(0.0);
  for(var i=0u;i<u32(transforms.lightParams.y);i++) {
    let light=transforms.lights[i];
    let direction=safeNormalize((transforms.view * vec4(light.direction.xyz,0.0)).xyz);
    var toLight = -direction;var attenuation=1.0;
    if(light.position.w != 3.0) {
      let delta=(transforms.view*vec4(light.position.xyz,1.0)).xyz-position;
      let distance=length(delta);toLight=safeNormalize(delta);
      if(distance>light.direction.w) {continue;}
      let denominator=dot(light.attenuation.xyz,vec3(1.0,distance,distance*distance));
      attenuation=1.0/max(denominator,1e-20);
      if(light.position.w == 2.0) {
        let cosine=dot(-toLight,direction);
        if(cosine<=light.cone.y){attenuation=0.0;}
        else if(cosine<light.cone.x){attenuation*=pow((cosine-light.cone.y)/(light.cone.x-light.cone.y),light.attenuation.w);}
      }
    }
    ambient += light.ambient.rgb*attenuation;
    let ndotl=dot(normal,toLight);
    diffuse += light.diffuse.rgb*clamp(ndotl,0.0,1.0)*attenuation;
    ${
      states[29]
        ? `let viewer=${states[142] ? 'safeNormalize(-position)' : 'vec3(0.0,0.0,-1.0)'};
    let highlight=dot(normal,safeNormalize(toLight+viewer));
    if(ndotl>0.0 && highlight>0.0){specular+=light.specular.rgb*pow(highlight,transforms.lightParams.x)*attenuation;}`
        : ''
    }
  }
  let color=clamp(materialEmissive.rgb+materialAmbient.rgb*ambient+materialDiffuse.rgb*diffuse,vec3(0.0),vec3(1.0));
  return array<vec4<f32>,2>(vec4(color,materialDiffuse.a),vec4(clamp(materialSpecular.rgb*specular,vec3(0.0),vec3(1.0)),0.0));
}`;
}
