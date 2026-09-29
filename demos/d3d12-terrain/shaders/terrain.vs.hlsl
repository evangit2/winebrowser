// SPDX-License-Identifier: MIT
// Terrain vertex shader: the per-frame transform arrives as a constant buffer
// bound through a CBV descriptor table, and the vertex normal is interpolated
// for the pixel stage to light.
cbuffer Frame : register(b0)
{
    float4 row0;
    float4 row1;
    float4 row2;
    float4 row3;
};

struct VertexInput
{
    float3 position : POSITION;
    float3 normal : NORMAL;
    float3 color : COLOR;
};

struct VertexOutput
{
    float3 normal : NORMAL;
    float3 color : COLOR;
    float4 position : SV_Position;
};

VertexOutput main(VertexInput input)
{
    VertexOutput output;
    float4 p = float4(input.position, 1.0);
    output.position = float4(dot(row0, p), dot(row1, p), dot(row2, p), dot(row3, p));
    output.normal = input.normal;
    output.color = input.color;
    return output;
}
