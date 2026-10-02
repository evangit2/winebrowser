// MSVC's L#name preprocessor extension is standard token-pasting in MinGW.
// These helpers name graphics objects only; the application sources are intact.
#include <climits>
#include <cmath>
#include <cstdio>
#include "stdafx.h"
#include "DXSampleHelper.h"
#undef NAME_D3D12_OBJECT
#undef NAME_D3D12_OBJECT_INDEXED
#define WB_WIDEN2(x) L##x
#define WB_WIDEN(x) WB_WIDEN2(x)
#define NAME_D3D12_OBJECT(x) SetName(x.Get(), WB_WIDEN(#x))
#define NAME_D3D12_OBJECT_INDEXED(x,n) SetNameIndexed(x[n].Get(), WB_WIDEN(#x), n)
using std::min;
using std::max;
