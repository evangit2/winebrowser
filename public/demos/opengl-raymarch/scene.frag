#version 330 core
out vec4 color;
uniform float time;
uniform float camera;
uniform vec2 resolution;
vec2 scene(vec3 p) {
    float c = cos(time * 0.5), s = sin(time * 0.5);
    vec3 q = p - vec3(0.0, 1.25, 0.0);
    q.xy = mat2(c, -s, s, c) * q.xy;
    float torus = length(vec2(length(q.xz) - 0.92, q.y)) - 0.23;
    vec2 d = vec2(torus, 1.0);
    float sphere = length(p - vec3(-1.75, 0.7 + 0.15 * sin(time), 0.3)) - 0.7;
    if (sphere < d.x) d = vec2(sphere, 2.0);
    float box = length(max(abs(p - vec3(1.7, 0.6, 0.0)) - vec3(0.45), 0.0)) - 0.12;
    if (box < d.x) d = vec2(box, 3.0);
    if (p.y < d.x) d = vec2(p.y, 4.0);
    return d;
}
vec3 normalAt(vec3 p) {
    vec2 e = vec2(0.002, 0.0);
    return normalize(vec3(scene(p + e.xyy).x - scene(p - e.xyy).x,
        scene(p + e.yxy).x - scene(p - e.yxy).x,
        scene(p + e.yyx).x - scene(p - e.yyx).x));
}
float shadow(vec3 p, vec3 light) {
    float shade = 1.0, t = 0.03;
    for (int i = 0; i < 40; ++i) {
        float h = scene(p + light * t).x;
        shade = min(shade, 12.0 * h / t);
        t += clamp(h, 0.02, 0.4);
        if (t > 8.0 || h < 0.001) break;
    }
    return clamp(shade, 0.15, 1.0);
}
void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - resolution) / resolution.y;
    vec3 eye = vec3(5.5 * sin(camera), 3.0, 5.5 * cos(camera));
    vec3 forward = normalize(vec3(0.0, 0.8, 0.0) - eye);
    vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, forward);
    vec3 ray = normalize(uv.x * right + uv.y * up + 1.8 * forward);
    float t = 0.0;
    vec2 hit = vec2(0.0);
    for (int i = 0; i < 80; ++i) {
        hit = scene(eye + t * ray);
        if (hit.x < 0.001 || t > 35.0) break;
        t += hit.x;
    }
    vec3 sky = mix(vec3(0.025, 0.04, 0.08), vec3(0.18, 0.3, 0.48), max(ray.y, 0.0));
    vec3 rgb = sky;
    if (t < 35.0) {
        vec3 p = eye + ray * t;
        vec3 n = normalAt(p);
        vec3 light = normalize(vec3(-3.0, 5.0, 4.0));
        vec3 base = vec3(0.13, 0.63, 0.85);
        if (hit.y == 2.0) base = vec3(0.9, 0.27, 0.12);
        if (hit.y == 3.0) base = vec3(0.85, 0.65, 0.19);
        if (hit.y == 4.0) base = mix(vec3(0.16, 0.19, 0.24), vec3(0.34, 0.4, 0.48),
            mod(floor(p.x) + floor(p.z), 2.0));
        float ao = 1.0;
        for (int i = 1; i <= 4; ++i) {
            float stepSize = float(i) * 0.12;
            ao -= (stepSize - scene(p + n * stepSize).x) * 0.22;
        }
        float lit = max(dot(n, light), 0.0) * shadow(p + n * 0.005, light);
        float specular = pow(max(dot(reflect(-light, n), -ray), 0.0), 64.0);
        rgb = base * (0.18 * ao + 0.95 * lit) + vec3(0.9) * specular * lit;
        rgb += base * pow(1.0 - max(dot(n, -ray), 0.0), 3.0) * 0.18;
        rgb = mix(rgb, sky, 1.0 - exp(-t * 0.025));
    }
    rgb = pow(rgb, vec3(1.0 / 2.2));
    rgb *= 1.0 - 0.12 * dot(uv, uv);
    color = vec4(rgb, 1.0);
}
