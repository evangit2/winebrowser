// SPDX-License-Identifier: MIT
// The texture arrives through an SRV descriptor table at t0 and the sampler
// through a static sampler the root signature declares at s0.
Texture2D albedo : register(t0);
SamplerState filter : register(s0);

struct VertexOutput
{
    float2 uv : TEXCOORD0;
    float4 position : SV_Position;
};

float4 main(VertexOutput input) : SV_Target
{
    return albedo.Sample(filter, input.uv);
}
