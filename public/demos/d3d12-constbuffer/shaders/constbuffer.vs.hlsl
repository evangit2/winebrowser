// SPDX-License-Identifier: MIT
// The transform arrives in a constant buffer bound through a CBV descriptor
// table at register b0 — the D3D12HelloConstBuffers shape. Unlike the
// root-constants demo, the data is a real upload-heap buffer the vertex shader
// reads through a constant buffer view.
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
