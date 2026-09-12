typedef int(__attribute__((cdecl)) *Callback)(int);

extern int __attribute__((cdecl, dllimport)) sum(int left, int right);
extern int __attribute__((cdecl, dllimport)) OrdinalOnly(void);
extern int __attribute__((cdecl, dllimport)) CallCallback(Callback callback, int value);
extern int __attribute__((cdecl, dllimport)) ForwardSum(int left, int right);
extern void __attribute__((stdcall, dllimport, noreturn)) ExitProcess(unsigned long code);

static int __attribute__((cdecl)) guest_callback(int value) { return value + 5; }

void __attribute__((noreturn)) _start(void) {
  if (sum(20, 22) != 42) ExitProcess(1);
  if (ForwardSum(19, 23) != 42) ExitProcess(2);
  if (CallCallback(guest_callback, 37) != 42) ExitProcess(3);
  if (OrdinalOnly() != 42) ExitProcess(4);
  ExitProcess(0);
}
