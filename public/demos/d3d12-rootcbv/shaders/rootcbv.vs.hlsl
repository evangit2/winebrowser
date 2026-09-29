// SPDX-License-Identifier: MIT
// The transform arrives through a *root* constant buffer view: the command list
// binds a GPU virtual address directly with SetGraphicsRootConstantBufferView,
// with no descriptor heap or table involved.
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
    float4 color : COLOR;
};

struct VertexOutput
{
    float4 color : COLOR;
    float4 position : SV_Position;
};

VertexOutput main(VertexInput input)
{
    VertexOutput output;
    float4 p = float4(input.position.xyz, 1.0);
    output.position = float4(dot(row0, p), dot(row1, p), dot(row2, p), dot(row3, p));
    output.color = input.color;
    return output;
}
