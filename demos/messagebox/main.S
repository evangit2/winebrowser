.text
.globl _start
_start:
    pushl $0
    pushl $title
    pushl $message
    pushl $0
    call _MessageBoxA@16
    testl %eax, %eax
    jz .Lerror
    pushl $0
    call _ExitProcess@4
.Lerror:
    pushl $1
    call _ExitProcess@4

.section .rdata,"dr"
title:
    .asciz "WineBrowser demo"
message:
    .asciz "MessageBoxA ran successfully."
