// SPDX-License-Identifier: MIT
struct VertexInput
{
    float4 position : POSITION;
    float4 color : COLOR;
    // Retain D3D's draw-index contract in the portable SPIR-V interface.
    uint vertex_id : SV_VertexID;
};

struct VertexOutput
{
    float4 color : COLOR;
    float4 position : SV_Position;
};

VertexOutput main(VertexInput input)
{
    VertexOutput output;
    output.position = input.position;
    output.color = input.color;
    return output;
}
