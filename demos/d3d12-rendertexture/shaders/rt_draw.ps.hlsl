// SPDX-License-Identifier: MIT
// The offscreen pass: a strongly coloured gradient, so the composite pass has
// unmistakable content to sample.
float4 main(float2 uv : TEXCOORD0) : SV_Target
{
    return float4(uv.x, uv.y, 1.0 - uv.x, 1.0);
}
