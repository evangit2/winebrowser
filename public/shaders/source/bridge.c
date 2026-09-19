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

static struct vkd3d_shader_code wb_result;
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
    vkd3d_shader_free_shader_code(&wb_result);
    memset(&wb_result, 0, sizeof(wb_result));
    wb_messages[0] = '\0';
    wb_root_flags = 0;
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
