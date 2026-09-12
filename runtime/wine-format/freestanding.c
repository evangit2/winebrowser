#include <stddef.h>

/* The guest component has no CRT dependency; keep this routine local. */
void *memcpy(void *destination, const void *source, size_t length)
{
    unsigned char *out = destination;
    const unsigned char *in = source;
    size_t i;

    for (i = 0; i < length; ++i) out[i] = in[i];
    return destination;
}
