/* Independent x86 SSE arithmetic oracle. Linux CI executes this on hardware;
 * macOS x86 builds can also run under Rosetta for local comparison. */
#define _GNU_SOURCE
#ifdef __APPLE__
#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE
#endif
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <signal.h>
#include <setjmp.h>
#include <ucontext.h>
#include <xmmintrin.h>

static sigjmp_buf recover;
static uint32_t result[4], status;
static volatile sig_atomic_t trapped;
static void fault(int signal, siginfo_t *info, void *context) {
    (void)signal; (void)info;
    ucontext_t *uc = context;
#ifdef __APPLE__
    status = uc->uc_mcontext->__fs.__fpu_mxcsr;
    memcpy(result, &uc->uc_mcontext->__fs.__fpu_xmm0, sizeof(result));
#else
    status = uc->uc_mcontext.fpregs->mxcsr;
    memcpy(result, &uc->uc_mcontext.fpregs->_xmm[0], sizeof(result));
#endif
    trapped = 1;
    siglongjmp(recover, 1);
}
#define RUN(op) __asm__ volatile( \
    "movdqu %1,%%xmm0; movdqu %2,%%xmm1; " op " %%xmm1,%%xmm0; movdqu %%xmm0,%0" \
    : "=m"(result) : "m"(left), "m"(right) : "xmm0", "xmm1")
int main(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_sigaction = fault; action.sa_flags = SA_SIGINFO;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGFPE, &action, NULL)) return 2;
    unsigned format, op, control;
    uint32_t left[4], right[4];
    while (scanf("%u %u %x %x %x %x %x %x %x %x %x", &format, &op, &control,
                 &left[0], &left[1], &left[2], &left[3],
                 &right[0], &right[1], &right[2], &right[3]) == 11) {
        trapped = 0;
        if (!sigsetjmp(recover, 1)) {
            _mm_setcsr(control);
            switch (op + 5 * format) {
                case 0: RUN("addps"); break;
                case 1: RUN("subps"); break;
                case 2: RUN("mulps"); break;
                case 3: RUN("divps"); break;
                case 4: RUN("sqrtps"); break;
                case 5: RUN("addpd"); break;
                case 6: RUN("subpd"); break;
                case 7: RUN("mulpd"); break;
                case 8: RUN("divpd"); break;
                case 9: RUN("sqrtpd"); break;
                default: return 3;
            }
            status = _mm_getcsr();
        }
        _mm_setcsr(0x1f80);
        printf("{\"trapped\":%d,\"mxcsr\":%u,\"words\":[%u,%u,%u,%u]}\n",
               trapped, status, result[0], result[1], result[2], result[3]);
    }
    return 0;
}
