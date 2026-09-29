// SPDX-License-Identifier: MIT
// Clip-space triangles with a per-vertex colour and alpha; the pipeline's
// blend state decides how the two layers combine.
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
    output.position = input.position;
    output.color = input.color;
    return output;
}
