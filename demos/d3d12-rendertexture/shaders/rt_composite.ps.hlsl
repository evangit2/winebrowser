// SPDX-License-Identifier: MIT
// The composite pass: sample the offscreen render texture through an SRV and
// halve it, so the final colour proves the value came from the texture rather
// than from the composite shader computing it directly.
Texture2D scene : register(t0);
SamplerState filter : register(s0);

struct VertexOutput
{
    float2 uv : TEXCOORD0;
    float4 position : SV_Position;
};

float4 main(VertexOutput input) : SV_Target
{
    return scene.Sample(filter, input.uv) * 0.5;
}
