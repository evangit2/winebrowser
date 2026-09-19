/* SPDX-License-Identifier: MIT
 * Browser-facing ABI for unmodified LGPL vkd3d-shader 2.1. DXBC carries its
 * shader stage; no application-specific shader substitutions are made here.
 */
#include "vkd3d_shader.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define WB_MAX_DXBC (1024u * 1024u)
#define WB_MAX_SPIRV (16u * 1024u * 1024u)
#define WB_MAX_MESSAGES 8192u
#define WB_LEGACY_STAGES 2u
#define WB_MAX_LEGACY_BINDINGS 64u
#define WB_MAX_LEGACY_VARYINGS 12u

static struct vkd3d_shader_code wb_result;
static struct vkd3d_shader_code wb_legacy_results[WB_LEGACY_STAGES];
static struct vkd3d_shader_scan_signature_info wb_legacy_signatures[WB_LEGACY_STAGES];
static struct vkd3d_shader_scan_descriptor_info wb_legacy_descriptors[WB_LEGACY_STAGES];
static char wb_messages[WB_MAX_MESSAGES];
static unsigned int wb_root_flags;

static void wb_capture_messages(char *messages)
{
    if (messages)
    {
        snprintf(wb_messages, sizeof(wb_messages), "%s", messages);
        vkd3d_shader_free_messages(messages);
    }
}

void wb_clear(void)
{
    unsigned int i;

    vkd3d_shader_free_shader_code(&wb_result);
    memset(&wb_result, 0, sizeof(wb_result));
    for (i = 0; i < WB_LEGACY_STAGES; ++i)
    {
        vkd3d_shader_free_shader_code(&wb_legacy_results[i]);
        vkd3d_shader_free_scan_signature_info(&wb_legacy_signatures[i]);
        vkd3d_shader_free_scan_descriptor_info(&wb_legacy_descriptors[i]);
        memset(&wb_legacy_results[i], 0, sizeof(wb_legacy_results[i]));
        memset(&wb_legacy_signatures[i], 0, sizeof(wb_legacy_signatures[i]));
        memset(&wb_legacy_descriptors[i], 0, sizeof(wb_legacy_descriptors[i]));
    }
    wb_messages[0] = '\0';
    wb_root_flags = 0;
}

static int wb_legacy_validate(unsigned int stage, const void *bytes, unsigned int length)
{
    uint32_t version, end;
    unsigned int major, minor, expected;

    if (stage >= WB_LEGACY_STAGES || !bytes || length < 8 || length > WB_MAX_DXBC || length % 4)
    {
        snprintf(wb_messages, sizeof(wb_messages), "Legacy shader input must be 8..%u bytes and DWORD-aligned", WB_MAX_DXBC);
        return 0;
    }
    memcpy(&version, bytes, sizeof(version));
    memcpy(&end, (const uint8_t *)bytes + length - sizeof(end), sizeof(end));
    expected = stage ? 0xffffu : 0xfffeu;
    major = (version >> 8) & 0xffu;
    minor = version & 0xffu;
    if ((version >> 16) != expected
            || (stage == 0 && !((major == 1 && minor == 1)
                    || ((major == 2 || major == 3) && minor == 0)))
            || (stage == 1 && !((major == 1 && minor <= 4)
                    || ((major == 2 || major == 3) && minor == 0))))
    {
        snprintf(wb_messages, sizeof(wb_messages), "Legacy shader stage/version %#x is unsupported", version);
        return 0;
    }
    if (end != 0x0000ffffu)
    {
        snprintf(wb_messages, sizeof(wb_messages), "Legacy shader END token is missing");
        return 0;
    }
    return 1;
}

static int wb_legacy_scan(unsigned int stage, const void *bytes, unsigned int length)
{
    struct vkd3d_shader_compile_info info = {0};
    char *messages = NULL;
    int result;

    wb_legacy_signatures[stage].type = VKD3D_SHADER_STRUCTURE_TYPE_SCAN_SIGNATURE_INFO;
    wb_legacy_descriptors[stage].type = VKD3D_SHADER_STRUCTURE_TYPE_SCAN_DESCRIPTOR_INFO;
    wb_legacy_descriptors[stage].next = &wb_legacy_signatures[stage];
    info.type = VKD3D_SHADER_STRUCTURE_TYPE_COMPILE_INFO;
    info.next = &wb_legacy_descriptors[stage];
    info.source.code = bytes;
    info.source.size = length;
    info.source_type = VKD3D_SHADER_SOURCE_D3D_BYTECODE;
    info.target_type = VKD3D_SHADER_TARGET_SPIRV_BINARY;
    info.log_level = VKD3D_SHADER_LOG_WARNING;
    result = vkd3d_shader_scan(&info, &messages);
    wb_capture_messages(messages);
    if (result < 0)
    {
        if (!wb_messages[0]) snprintf(wb_messages, sizeof(wb_messages), "Legacy shader scan failed (%d)", result);
        return 0;
    }
    return 1;
}

static int wb_legacy_compile_stage(unsigned int stage, const void *bytes, unsigned int length,
        const struct vkd3d_shader_varying_map_info *varying_map)
{
    const struct vkd3d_shader_compile_option options[] =
    {
        {VKD3D_SHADER_COMPILE_OPTION_WRITE_TESS_GEOM_POINT_SIZE, 0},
    };
    struct vkd3d_shader_resource_binding bindings[WB_MAX_LEGACY_BINDINGS];
    struct vkd3d_shader_d3dbc_source_info source = {0};
    struct vkd3d_shader_spirv_target_info target = {0};
    struct vkd3d_shader_interface_info interface = {0};
    struct vkd3d_shader_compile_info info = {0};
    const struct vkd3d_shader_descriptor_info *descriptor;
    struct vkd3d_shader_resource_binding *binding;
    unsigned int i, group = stage;
    char *messages = NULL;
    int result;

    if (wb_legacy_descriptors[stage].descriptor_count > WB_MAX_LEGACY_BINDINGS)
    {
        snprintf(wb_messages, sizeof(wb_messages), "Legacy shader descriptor count exceeds %u", WB_MAX_LEGACY_BINDINGS);
        return 0;
    }
    for (i = 0; i < wb_legacy_descriptors[stage].descriptor_count; ++i)
    {
        descriptor = &wb_legacy_descriptors[stage].descriptors[i];
        binding = &bindings[i];
        memset(binding, 0, sizeof(*binding));
        if (descriptor->register_space || descriptor->count != 1
                || (descriptor->type != VKD3D_SHADER_DESCRIPTOR_TYPE_CBV
                    && descriptor->type != VKD3D_SHADER_DESCRIPTOR_TYPE_SRV
                    && descriptor->type != VKD3D_SHADER_DESCRIPTOR_TYPE_SAMPLER))
        {
            snprintf(wb_messages, sizeof(wb_messages), "Unsupported legacy descriptor type or range");
            return 0;
        }
        binding->type = descriptor->type;
        binding->register_index = descriptor->register_index;
        binding->shader_visibility = stage ? VKD3D_SHADER_VISIBILITY_PIXEL : VKD3D_SHADER_VISIBILITY_VERTEX;
        binding->binding.set = group;
        binding->binding.count = 1;
        if (descriptor->type == VKD3D_SHADER_DESCRIPTOR_TYPE_CBV)
        {
            if (descriptor->register_index > VKD3D_SHADER_D3DBC_BOOL_CONSTANT_REGISTER)
            {
                snprintf(wb_messages, sizeof(wb_messages), "Unsupported legacy constant register set");
                return 0;
            }
            binding->flags = VKD3D_SHADER_BINDING_FLAG_BUFFER;
            binding->binding.binding = descriptor->register_index;
        }
        else
        {
            if (descriptor->register_index > 15)
            {
                snprintf(wb_messages, sizeof(wb_messages), "Legacy sampler index exceeds 15");
                return 0;
            }
            binding->flags = descriptor->type == VKD3D_SHADER_DESCRIPTOR_TYPE_SRV
                    ? VKD3D_SHADER_BINDING_FLAG_IMAGE : 0;
            binding->binding.binding = 16 + 2 * descriptor->register_index
                    + (descriptor->type == VKD3D_SHADER_DESCRIPTOR_TYPE_SAMPLER);
        }
    }

    interface.type = VKD3D_SHADER_STRUCTURE_TYPE_INTERFACE_INFO;
    interface.next = varying_map;
    interface.bindings = bindings;
    interface.binding_count = wb_legacy_descriptors[stage].descriptor_count;
    source.type = VKD3D_SHADER_STRUCTURE_TYPE_D3DBC_SOURCE_INFO;
    source.next = &interface;
    target.type = VKD3D_SHADER_STRUCTURE_TYPE_SPIRV_TARGET_INFO;
    target.next = &source;
    target.entry_point = "main";
    target.environment = VKD3D_SHADER_SPIRV_ENVIRONMENT_VULKAN_1_0;
    info.type = VKD3D_SHADER_STRUCTURE_TYPE_COMPILE_INFO;
    info.next = &target;
    info.source.code = bytes;
    info.source.size = length;
    info.source_type = VKD3D_SHADER_SOURCE_D3D_BYTECODE;
    info.target_type = VKD3D_SHADER_TARGET_SPIRV_BINARY;
    info.options = options;
    info.option_count = sizeof(options) / sizeof(options[0]);
    info.log_level = VKD3D_SHADER_LOG_WARNING;
    result = vkd3d_shader_compile(&info, &wb_legacy_results[stage], &messages);
    wb_capture_messages(messages);
    if (result < 0 || !wb_legacy_results[stage].code || wb_legacy_results[stage].size < 20
            || wb_legacy_results[stage].size > WB_MAX_SPIRV || wb_legacy_results[stage].size % 4)
    {
        if (!wb_messages[0]) snprintf(wb_messages, sizeof(wb_messages), "Legacy shader compile failed (%d)", result);
        vkd3d_shader_free_shader_code(&wb_legacy_results[stage]);
        memset(&wb_legacy_results[stage], 0, sizeof(wb_legacy_results[stage]));
        return 0;
    }
    return 1;
}

int wb_d3dbc_compile_pair(const void *vertex, unsigned int vertex_length,
        const void *pixel, unsigned int pixel_length)
{
    struct vkd3d_shader_varying_map varyings[WB_MAX_LEGACY_VARYINGS];
    struct vkd3d_shader_varying_map_info varying_info = {0};
    unsigned int varying_count = WB_MAX_LEGACY_VARYINGS;

    wb_clear();
    if (!wb_legacy_validate(0, vertex, vertex_length) || !wb_legacy_validate(1, pixel, pixel_length)
            || !wb_legacy_scan(0, vertex, vertex_length) || !wb_legacy_scan(1, pixel, pixel_length))
        return 0;
    if (wb_legacy_signatures[1].input.element_count > WB_MAX_LEGACY_VARYINGS)
    {
        snprintf(wb_messages, sizeof(wb_messages), "Legacy pixel varying count exceeds %u", WB_MAX_LEGACY_VARYINGS);
        return 0;
    }
    vkd3d_shader_build_varying_map(&wb_legacy_signatures[0].output,
            &wb_legacy_signatures[1].input, &varying_count, varyings);
    if (varying_count > WB_MAX_LEGACY_VARYINGS)
    {
        snprintf(wb_messages, sizeof(wb_messages), "Legacy varying map exceeds %u", WB_MAX_LEGACY_VARYINGS);
        return 0;
    }
    varying_info.type = VKD3D_SHADER_STRUCTURE_TYPE_VARYING_MAP_INFO;
    varying_info.varying_map = varyings;
    varying_info.varying_count = varying_count;
    return wb_legacy_compile_stage(0, vertex, vertex_length, &varying_info)
            && wb_legacy_compile_stage(1, pixel, pixel_length, NULL);
}

const void *wb_d3dbc_result_ptr(unsigned int stage)
{
    return stage < WB_LEGACY_STAGES ? wb_legacy_results[stage].code : NULL;
}

unsigned int wb_d3dbc_result_size(unsigned int stage)
{
    return stage < WB_LEGACY_STAGES ? (unsigned int)wb_legacy_results[stage].size : 0;
}

int wb_dxbc_compile(const void *bytes, unsigned int length)
{
    struct vkd3d_shader_spirv_target_info target = {0};
    struct vkd3d_shader_compile_info info = {0};
    uint32_t magic = 0;
    char *messages = NULL;
    int result;

    wb_clear();
    if (!bytes || length < 32 || length > WB_MAX_DXBC)
    {
        snprintf(wb_messages, sizeof(wb_messages), "DXBC input length must be 32..%u bytes", WB_MAX_DXBC);
        return 0;
    }
    memcpy(&magic, bytes, sizeof(magic));
    if (magic != 0x43425844u)
    {
        snprintf(wb_messages, sizeof(wb_messages), "DXBC container signature is missing");
        return 0;
    }

    target.type = VKD3D_SHADER_STRUCTURE_TYPE_SPIRV_TARGET_INFO;
    target.entry_point = "main";
    target.environment = VKD3D_SHADER_SPIRV_ENVIRONMENT_VULKAN_1_0;
    info.type = VKD3D_SHADER_STRUCTURE_TYPE_COMPILE_INFO;
    info.next = &target;
    info.source.code = bytes;
    info.source.size = length;
    info.source_type = VKD3D_SHADER_SOURCE_DXBC_TPF;
    info.target_type = VKD3D_SHADER_TARGET_SPIRV_BINARY;
    info.log_level = VKD3D_SHADER_LOG_WARNING;
    result = vkd3d_shader_compile(&info, &wb_result, &messages);
    wb_capture_messages(messages);
    if (result < 0 || !wb_result.code || wb_result.size < 20 || wb_result.size > WB_MAX_SPIRV || wb_result.size % 4)
    {
        if (!wb_messages[0]) snprintf(wb_messages, sizeof(wb_messages), "vkd3d-shader compile failed (%d)", result);
        vkd3d_shader_free_shader_code(&wb_result);
        memset(&wb_result, 0, sizeof(wb_result));
        return 0;
    }
    return 1;
}

/* A real DXBC root-signature container, restricted to the empty v1.0 shape
 * needed by the first D3D12 triangle. Unsupported shapes fail explicitly. */
int wb_root_signature_serialize(unsigned int flags)
{
    struct vkd3d_shader_versioned_root_signature_desc desc = {0};
    char *messages = NULL;
    int result;

    wb_clear();
    if (flags & ~VKD3D_SHADER_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT)
    {
        snprintf(wb_messages, sizeof(wb_messages), "Unsupported root signature flags %#x", flags);
        return 0;
    }
    desc.version = VKD3D_SHADER_ROOT_SIGNATURE_VERSION_1_0;
    desc.u.v_1_0.flags = (enum vkd3d_shader_root_signature_flags)flags;
    result = vkd3d_shader_serialize_root_signature(&desc, &wb_result, &messages);
    wb_capture_messages(messages);
    if (result < 0 || !wb_result.code || wb_result.size < 32 || wb_result.size > WB_MAX_DXBC)
    {
        if (!wb_messages[0]) snprintf(wb_messages, sizeof(wb_messages), "Root signature serialization failed (%d)", result);
        vkd3d_shader_free_shader_code(&wb_result);
        memset(&wb_result, 0, sizeof(wb_result));
        return 0;
    }
    wb_root_flags = flags;
    return 1;
}

int wb_root_signature_validate(const void *bytes, unsigned int length)
{
    struct vkd3d_shader_versioned_root_signature_desc desc = {0};
    struct vkd3d_shader_code dxbc;
    char *messages = NULL;
    uint32_t magic = 0;
    int result;

    /* Keep wb_result alive: bytes may point to the previous serialize result. */
    wb_messages[0] = '\0';
    wb_root_flags = 0;
    if (!bytes || length < 32 || length > WB_MAX_DXBC)
    {
        snprintf(wb_messages, sizeof(wb_messages), "Root signature length must be 32..%u bytes", WB_MAX_DXBC);
        return 0;
    }
    memcpy(&magic, bytes, sizeof(magic));
    if (magic != 0x43425844u)
    {
        snprintf(wb_messages, sizeof(wb_messages), "Root signature DXBC container signature is missing");
        return 0;
    }
    dxbc.code = bytes;
    dxbc.size = length;
    result = vkd3d_shader_parse_root_signature(&dxbc, &desc, &messages);
    wb_capture_messages(messages);
    if (result < 0)
    {
        if (!wb_messages[0]) snprintf(wb_messages, sizeof(wb_messages), "Root signature parse failed (%d)", result);
        return 0; /* vkd3d frees partial descriptions on parse failure. */
    }
    if (desc.version != VKD3D_SHADER_ROOT_SIGNATURE_VERSION_1_0
            || desc.u.v_1_0.parameter_count || desc.u.v_1_0.static_sampler_count
            || (desc.u.v_1_0.flags & ~VKD3D_SHADER_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT))
    {
        snprintf(wb_messages, sizeof(wb_messages), "Only empty version 1.0 root signatures with flags 0 or 1 are supported");
        vkd3d_shader_free_root_signature(&desc);
        return 0;
    }
    wb_root_flags = desc.u.v_1_0.flags;
    vkd3d_shader_free_root_signature(&desc);
    return 1;
}

unsigned int wb_root_signature_flags(void) { return wb_root_flags; }

const void *wb_result_ptr(void) { return wb_result.code; }
unsigned int wb_result_size(void) { return (unsigned int)wb_result.size; }
const char *wb_messages_ptr(void) { return wb_messages; }
