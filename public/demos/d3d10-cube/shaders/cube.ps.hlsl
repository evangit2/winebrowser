// SPDX-License-Identifier: MIT
// D3D10 keeps one register file per shader stage: this b0 is *not* the vertex
// shader's b0. PSSetConstantBuffers(0, ...) binds a different resource than
// VSSetConstantBuffers(0, ...), and the two must stay distinct bindings in the
// translated pipeline. The vertex stage declares `row0..row3`, this stage
// declares `lightDirection`/`lightColour` — same register, different data.
cbuffer Light : register(b0)
{
    float4 lightDirection;
    float4 lightColour;
};

struct PixelInput
{
    float4 color : COLOR;
    float3 normal : NORMAL;
    float3 objectPosition : TEXCOORD0;
};

float4 main(PixelInput input) : SV_Target
{
    // A cube's face normal is constant, so a flat normal would give a flat
    // fill. Perturbing it with a procedural bump from the object-space
    // position makes every fragment evaluate its own lighting, which is what
    // proves the interpolants and this stage's b0 both reach the GPU.
    float3 n = normalize(input.normal
        + 0.40 * float3(sin(input.objectPosition.y * 5.0),
                        sin(input.objectPosition.z * 5.0),
                        sin(input.objectPosition.x * 5.0)));
    float3 l = normalize(lightDirection.xyz);
    // The view direction varies across the face, so the highlight sweeps
    // rather than sitting at one constant value.
    float3 v = normalize(float3(-input.objectPosition.x, -input.objectPosition.y, 2.6));
    float3 h = normalize(l + v);
    float diffuse = saturate(dot(n, l));
    float specular = pow(saturate(dot(n, h)), 20.0) * 0.45;
    // A procedural checker rides on the same position, so the fine pattern no
    // per-vertex colour could carry is visible alongside the gradient.
    float3 cell = floor(input.objectPosition * 3.0);
    float checker = fmod(cell.x + cell.y + cell.z, 2.0);
    float3 base = input.color.rgb * (0.25 + 0.75 * diffuse) * lightColour.rgb;
    base = lerp(base * 0.70, base * 1.20, checker);
    return float4(saturate(base + specular), 1.0);
}
