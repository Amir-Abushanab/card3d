// The PMREM lod planes: clip-space y is flipped so the atlas keeps three's GL row order.

struct PlaneOut {
    @builtin(position) pos: vec4f,
    @location(0) dir: vec3f,
};

// PMREM face-indexing convention (right-handed).
fn get_direction(uv_in: vec2f, face: f32) -> vec3f {
    let uv = 2.0 * uv_in - 1.0;
    var d = vec3f(uv, 1.0);
    if (face == 0.0) { d = d.zyx; }
    else if (face == 1.0) { d = d.xzy; d = vec3f(-d.x, d.y, -d.z); }
    else if (face == 2.0) { d.x = -d.x; }
    else if (face == 3.0) { d = d.zyx; d = vec3f(-d.x, d.y, -d.z); }
    else if (face == 4.0) { d = d.xzy; d = vec3f(-d.x, -d.y, d.z); }
    else if (face == 5.0) { d.z = -d.z; }
    return d;
}

@vertex
fn vs_plane(@location(0) position: vec2f, @location(1) uv: vec2f, @location(2) face: f32) -> PlaneOut {
    var o: PlaneOut;
    o.pos = vec4f(position.x, -position.y, 0.0, 1.0);
    o.dir = get_direction(uv, face);
    return o;
}
