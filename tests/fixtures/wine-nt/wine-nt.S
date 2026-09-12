/* Minimal Wine i386 syscall-wrapper fixture. No compiler runtime or imports. */
	.text
	.p2align 4
	.globl _DllMain@12
_DllMain@12:
	movl $1, %eax
	ret $12

	.globl _wine_syscall_trampoline
_wine_syscall_trampoline:
	.byte 0xff, 0x25
	.long _wine_syscall_dispatcher

	.macro NT_STUB name, service, stack_bytes
	.globl \name
\name:
	.byte 0xb8
	.long \service
	.byte 0xba
	.long _wine_syscall_trampoline
	.byte 0xff, 0xd2, 0xc2
	.short \stack_bytes
	.endm

	.macro NT_TEB_STUB name, service, stack_bytes
	.globl \name
\name:
	.byte 0xb8
	.long \service
	.byte 0x64, 0xff, 0x15
	.long 0xc0
	.byte 0xc2
	.short \stack_bytes
	.endm

	NT_TEB_STUB _NtQuerySystemTime, 0x5a, 4
	NT_TEB_STUB _NtQueryInformationProcess, 0x19, 20
	NT_STUB _NtQueryPerformanceCounter, 0x31, 8
	NT_STUB _NtAllocateVirtualMemory, 0x18, 24
	NT_STUB _NtFreeVirtualMemory, 0x1e, 16
	NT_STUB _NtClose, 0x0f, 4

	.data
	.p2align 2
	.globl _wine_syscall_dispatcher
_wine_syscall_dispatcher:
	.long 0
