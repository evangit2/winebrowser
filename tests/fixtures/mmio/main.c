#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>

_Static_assert(sizeof(MMIOINFO) == 72, "PE32 MMIOINFO ABI");
_Static_assert(sizeof(MMCKINFO) == 20, "PE32 MMCKINFO ABI");

static void print(const char *s) {
  DWORD n = 0, written;
  while (s[n]) ++n;
  WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), s, n, &written, 0);
}
#define CHECK(x, code) do { if (!(x)) { print("MMIO CONTRACT FAILURE\n"); ExitProcess(code); } } while (0)

static LRESULT CALLBACK proc(HWND h, UINT m, WPARAM w, LPARAM l) {
  if (m == WM_NCCREATE) return 1;
  return DefWindowProcA(h, m, w, l);
}

void mainCRTStartup(void) {
  MMCKINFO riff = {0}, chunk = {0}, missing = {0};
  struct { MMIOINFO info; DWORD guard; } state = {{0}, 0xabcddcba};
  PCMWAVEFORMAT format = {0};
  BYTE first[13];
  HMMIO h = mmioOpenA("tone.wav", 0, MMIO_READ | MMIO_ALLOCBUF);
  CHECK(h != 0, 1);
  riff.fccType = mmioFOURCC('W','A','V','E');
  CHECK(mmioDescend(h, &riff, 0, MMIO_FINDRIFF) == 0, 2);
  CHECK(riff.ckid == FOURCC_RIFF && riff.dwDataOffset == 8, 3);
  missing.ckid = mmioFOURCC('n','o','n','e');
  CHECK(mmioDescend(h, &missing, &riff, MMIO_FINDCHUNK) == MMIOERR_CHUNKNOTFOUND, 4);
  CHECK(mmioSeek(h, 0, SEEK_CUR) == 12, 5);
  chunk.ckid = mmioFOURCC('f','m','t',' ');
  CHECK(mmioDescend(h, &chunk, &riff, MMIO_FINDCHUNK) == 0, 6);
  CHECK(chunk.cksize == 16, 7);
  CHECK(mmioRead(h, (HPSTR)&format, 16) == 16, 8);
  CHECK(format.wf.wFormatTag == WAVE_FORMAT_PCM && format.wf.nChannels == 1 &&
        format.wf.nSamplesPerSec == 22050 && format.wBitsPerSample == 8, 9);
  CHECK(mmioAscend(h, &chunk, 0) == 0, 10);
  chunk.ckid = mmioFOURCC('d','a','t','a');
  CHECK(mmioDescend(h, &chunk, &riff, MMIO_FINDCHUNK) == 0 && chunk.cksize == 10001, 11);
  CHECK(mmioRead(h, (HPSTR)first, 13) == 13, 12);
  for (DWORD i = 0; i < 13; ++i) CHECK(first[i] == (BYTE)i, 13);
  CHECK(mmioGetInfo(h, &state.info, 0) == 0 && state.info.hmmio == h, 14);
  CHECK(state.guard == 0xabcddcba && state.info.cchBuffer > 0, 15);
  for (DWORD i = 13; i < chunk.cksize; ++i) {
    if (state.info.pchNext >= state.info.pchEndRead) {
      CHECK(mmioAdvance(h, &state.info, MMIO_READ) == 0, 16);
      CHECK(state.info.pchNext < state.info.pchEndRead, 17);
    }
    CHECK((BYTE)*state.info.pchNext++ == (BYTE)i, 18);
  }
  CHECK(mmioSetInfo(h, &state.info, 0) == 0, 19);
  CHECK(mmioSeek(h, 0, SEEK_CUR) == (LONG)(chunk.dwDataOffset + chunk.cksize), 20);
  CHECK(mmioAscend(h, &chunk, 0) == 0, 21);
  CHECK(mmioRead(h, (HPSTR)first, 1) == 0, 22);
  CHECK(mmioClose(h, 0) == 0 && mmioClose(h, 0) == MMSYSERR_INVALHANDLE, 23);
  h = mmioOpenW(L"tone.wav", 0, MMIO_READ);
  CHECK(h && mmioSeek(h, -1, SEEK_SET) == -1, 24);
  CHECK(mmioRead(h, (HPSTR)first, 4) == 4 && first[0] == 'R', 25);
  CHECK(mmioClose(h, 0) == 0, 26);
  print("MMIO BUFFERED RIFF PASS\n");

  WNDCLASSA cls = {0};
  cls.lpfnWndProc = proc; cls.hInstance = GetModuleHandleA(0); cls.lpszClassName = "MMIOWindow";
  CHECK(RegisterClassA(&cls) != 0, 30);
  HWND window = CreateWindowExA(0, cls.lpszClassName, "MMIO lifecycle", WS_OVERLAPPEDWINDOW,
                              50, 60, 320, 240, 0, 0, cls.hInstance, 0);
  CHECK(window != 0, 31);
  ShowWindow(window, SW_SHOWMAXIMIZED);
  CHECK(IsZoomed(window), 32);
  RECT before, after, clip = {10, 20, 30, 50}, got;
  POINT point;
  GetWindowRect(window, &before);
  CHECK(ClipCursor(&clip) && SetCursorPos(1000, -1000) && GetCursorPos(&point), 33);
  CHECK(point.x == 29 && point.y == 20 && GetClipCursor(&got), 34);
  CHECK(got.left == 10 && got.top == 20 && got.right == 30 && got.bottom == 50, 35);
  CHECK(ClipCursor(0) && SetCursorPos(100, 200) && GetCursorPos(&point), 36);
  CHECK(point.x == 100 && point.y == 200, 37);
  print("WINDOW VISIBLE\n"); Sleep(1500);
  CHECK(CloseWindow(window) && IsIconic(window) && IsWindowVisible(window), 38);
  CHECK(WindowFromPoint(point) != window, 43);
  print("WINDOW MINIMIZED\n"); Sleep(1500);
  CHECK(OpenIcon(window) && !IsIconic(window) && IsZoomed(window), 39);
  GetWindowRect(window, &after);
  CHECK(before.left == after.left && before.top == after.top &&
        before.right == after.right && before.bottom == after.bottom, 40);
  print("WINDOW RESTORED\n"); Sleep(1500);
  CHECK(DestroyWindow(window), 41);
  CHECK(!OpenIcon(window) && !CloseWindow(window), 42);
  print("MMIO WINDOW CURSOR CONTRACTS PASS\n");
  ExitProcess(0);
}
