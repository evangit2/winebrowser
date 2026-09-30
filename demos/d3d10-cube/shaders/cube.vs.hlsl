// SPDX-License-Identifier: MIT
// D3D10 has no root signature: a constant buffer is bound to a register by the
// application (VSSetConstantBuffers) and the shader names the register here.
// This is the vertex stage's b0, which is a different resource from the pixel
// stage's b0 in the same draw.
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
    float3 normal : NORMAL;
};

struct VertexOutput
{
    float4 color : COLOR;
    float3 normal : NORMAL;
    float3 objectPosition : TEXCOORD0;
    float4 position : SV_Position;
};

VertexOutput main(VertexInput input)
{
    VertexOutput output;
    float4 p = float4(input.position.xyz, 1.0);
    output.position = float4(dot(row0, p), dot(row1, p), dot(row2, p), dot(row3, p));
    output.color = input.color;
    output.normal = input.normal;
    output.objectPosition = input.position.xyz;
    return output;
}
