# Native HLSL compiler API fixture

Original WineBrowser fixture under the repository license. Build with
`sh scripts/build-hlsl-fixture.sh`; test with
`node scripts/test-hlsl-native-browser.mjs`.

The normal browser upload path receives this native PE32 EXE plus Microsoft's
original `shaders.hlsl`, or a nested ZIP with both. The guest calls
D3DCompileFromFile and D3DCompile, checks DXBC output, independent COM references,
syntax diagnostics, missing files, unsupported SM6, null output and recovery.
No precompiled shader or pretranslated application is used by this fixture.
The separate HLSL renderer test verifies actual compiled shader pixels.
