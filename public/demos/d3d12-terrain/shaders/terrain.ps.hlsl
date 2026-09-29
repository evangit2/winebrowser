// SPDX-License-Identifier: MIT
// Lambert shading with a rim term, so the terrain relief reads clearly.
float4 main(float3 normal : NORMAL, float3 color : COLOR) : SV_Target
{
    float3 n = normalize(normal);
    float3 light = normalize(float3(0.45, 0.80, 0.35));
    float diffuse = saturate(dot(n, light));
    float rim = pow(saturate(1.0 - n.y), 3.0);
    float3 shaded = color * (0.30 + 0.70 * diffuse) + rim * 0.10;
    return float4(saturate(shaded), 1.0);
}
