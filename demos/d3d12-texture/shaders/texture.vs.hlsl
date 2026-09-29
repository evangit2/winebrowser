// SPDX-License-Identifier: MIT
// Root constants carry the transform; texture coordinates come from the vertex
// buffer so the pixel stage can sample a bound 2D texture.
cbuffer Transform : register(b0)
{
    float4 row0;
    float4 row1;
    float4 row2;
    float4 row3;
};

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
    float4 p = float4(input.position.xyz, 1.0);
    output.position = float4(dot(row0, p), dot(row1, p), dot(row2, p), dot(row3, p));
    output.uv = input.uv;
    return output;
}
