mod draw_parameters;

use wasm_bindgen::prelude::*;

const MAX_SPIRV_BYTES: usize = 4 * 1024 * 1024;
const SPIRV_MAGIC_LE: [u8; 4] = [0x03, 0x02, 0x23, 0x07];

/// Converts a complete little-endian SPIR-V module to WGSL for WebGPU.
/// The D3D-to-SPIR-V stage assigns bindings; this library never guesses them.
#[wasm_bindgen]
pub fn spirv_to_wgsl(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() < 20 || bytes.len() > MAX_SPIRV_BYTES || bytes.len() % 4 != 0 {
        return Err("SPIR-V input must be 20 bytes to 4 MiB and DWORD-aligned".into());
    }
    if !bytes.starts_with(&SPIRV_MAGIC_LE) {
        return Err("SPIR-V input has no little-endian magic word".into());
    }

    // D3D and WebGPU both use depth 0..1. The renderer handles viewport
    // orientation and winding, so Naga must not adjust the clip coordinates.
    let options = naga::front::spv::Options {
        adjust_coordinate_space: false,
        ..Default::default()
    };
    let normalized = draw_parameters::lower(bytes)?;
    let module = naga::front::spv::parse_u8_slice(&normalized, &options)
        .map_err(|error| format!("SPIR-V parse failed: {error}"))?;
    if module.entry_points.is_empty() {
        return Err("SPIR-V module has no shader entry point".into());
    }
    let validator = || {
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        )
    };
    let information = validator()
        .validate(&module)
        .map_err(|error| format!("SPIR-V validation failed: {error}"))?;
    let wgsl = naga::back::wgsl::write_string(
        &module,
        &information,
        naga::back::wgsl::WriterFlags::empty(),
    )
    .map_err(|error| format!("WGSL emission failed: {error}"))?;

    let reparsed = naga::front::wgsl::parse_str(&wgsl).map_err(|error| {
        format!(
            "Generated WGSL parse failed: {}",
            error.emit_to_string(&wgsl)
        )
    })?;
    validator()
        .validate(&reparsed)
        .map_err(|error| format!("Generated WGSL validation failed: {error}"))?;
    Ok(wgsl)
}
