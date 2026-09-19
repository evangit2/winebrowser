/*
 * Extracted unchanged from Wine dlls/d3d9/tests/visual.c test_shademode().
 * Copyright 2005, 2007-2008 Henri Verbeet
 * Copyright (C) 2007-2013 Stefan Dösinger (for CodeWeavers)
 * Copyright (C) 2008 Jason Green (for TransGaming)
 * LGPL-2.1-or-later; see WINE-COPYING.LIB.
 */
static const unsigned long vs1_code[] =
{
    0xfffe0101,                                     /* vs_1_1          */
    0x0000001f, 0x80000000, 0x900f0000,             /* dcl_position v0 */
    0x0000001f, 0x8000000a, 0x900f0001,             /* dcl_color0 v1   */
    0x00000001, 0xc00f0000, 0x90e40000,             /* mov oPos, v0    */
    0x00000001, 0xd00f0000, 0x90e40001,             /* mov oD0, v1     */
    0x0000ffff
};
static const unsigned long ps2_code[] =
{
    0xffff0200,                                     /* ps_2_0          */
    0x0200001f, 0x80000000, 0x900f0000,             /* dcl v0          */
    0x02000001, 0x800f0800, 0x90e40000,             /* mov oC0, v0     */
    0x0000ffff
};

/* Extracted from the same Wine source, test_vs_input(). */
static const unsigned long color_color_shader_code_1[] =
{
    0xfffe0101,
    0x0000001f, 0x80000000, 0x900f0000,
    0x0000001f, 0x8000000a, 0x900f0001,
    0x00000001, 0xc00f0000, 0x90e40000,
    0x00000005, 0xd00f0000, 0xa0e40000, 0x90e40001,
    0x0000ffff
};

/* Extracted from the same Wine source, constant_clamp_ps_test(). */
static const unsigned long pixel_external_constants_shader_code_20[] =
{
    0xffff0200,                                         /* ps_2_0           */
    0x02000001, 0x800f0001, 0xa0e40001,                 /* mov r1, c1       */
    0x03000002, 0x800f0000, 0x80e40001, 0xa0e40002,     /* add r0, r1, c2   */
    0x02000001, 0x800f0800, 0x80e40000,                 /* mov oC0, r0      */
    0x0000ffff                                          /* end              */
};
