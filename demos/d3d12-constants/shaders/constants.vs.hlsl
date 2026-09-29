// SPDX-License-Identifier: MIT
// The transform reaches this shader as D3D12 root constants: a 32-bit-constants
// root parameter covering cbuffer register b0. Four explicit float4 rows keep
// the cbuffer packing unambiguous, and the shader does the matrix multiply on
// the GPU, so the application uploads only 16 DWORDs per frame.
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
