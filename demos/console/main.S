.text
.globl _start
_start:
    pushl $-11
    call _GetStdHandle@4
    testl %eax, %eax
    jz .Lerror
    cmpl $-1, %eax
    je .Lerror
    pushl $0
    pushl $written
    pushl $message_end-message
    pushl $message
    pushl %eax
    call _WriteFile@20
    testl %eax, %eax
    jz .Lerror
    pushl $0
    call _ExitProcess@4
.Lerror:
    pushl $1
    call _ExitProcess@4

.section .rdata,"dr"
message:
    .ascii "console demo: hello from WriteFile\r\n"
message_end:

.data
written:
    .long 0
