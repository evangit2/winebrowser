// SPDX-License-Identifier: MIT
// Pass-through clip-space vertices with a uv, used by both the offscreen pass
// and the composite pass that samples its result.
struct VertexInput
{
    float4 position : POSITION;
    float2 uv : TEXCOORD0;
};

struct VertexOutput
{
    float2 uv : TEXCOORD0;
    float4 position : SV_Position;
};

VertexOutput main(VertexInput input)
{
    VertexOutput output;
    output.position = input.position;
    output.uv = input.uv;
    return output;
}
