#ifndef WINE_FORMAT_DEBUG_H
#define WINE_FORMAT_DEBUG_H

/* The extracted Wine formatter keeps its function bodies intact. */
#define WINE_DEFAULT_DEBUG_CHANNEL(name)
#define TRACE(...) ((void)0)
#define ARRAY_SIZE(value) (sizeof(value) / sizeof((value)[0]))

#endif
