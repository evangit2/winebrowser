# Original WineBrowser contributors, MIT. Native C calls and generated callbacks.
import ctypes, json
from ctypes import c_int, c_void_p, c_char_p, POINTER
import _ctypes
assert _ctypes.__file__.lower().endswith('.pyd')

sqlite = ctypes.CDLL('sqlite3.dll')
sqlite.sqlite3_libversion.restype = c_char_p
sqlite.sqlite3_open.argtypes = [c_char_p, POINTER(c_void_p)]
sqlite.sqlite3_open.restype = c_int
sqlite.sqlite3_close.argtypes = [c_void_p]
sqlite.sqlite3_close.restype = c_int
Callback = ctypes.CFUNCTYPE(c_int, c_void_p, c_int, POINTER(c_char_p), POINTER(c_char_p))
rows = []
cookie = c_int(37)
@Callback
def on_row(data, count, values, names):
    assert ctypes.cast(data, POINTER(c_int)).contents.value == 37
    rows.append({names[i].decode(): values[i].decode() if values[i] else None for i in range(count)})
    return 0
sqlite.sqlite3_exec.argtypes = [c_void_p, c_char_p, Callback, c_void_p, POINTER(c_char_p)]
sqlite.sqlite3_exec.restype = c_int
database = c_void_p()
assert sqlite.sqlite3_open(b':memory:', ctypes.byref(database)) == 0
error = c_char_p()
statement = b"create table sample(n integer, label text);insert into sample values(2,'two'),(1,'one');select n,label from sample order by n"
assert sqlite.sqlite3_exec(database, statement, on_row, ctypes.byref(cookie), ctypes.byref(error)) == 0
assert rows == [{'n': '1', 'label': 'one'}, {'n': '2', 'label': 'two'}]
assert sqlite.sqlite3_close(database) == 0

# The unchanged Wine CRT executes qsort and calls the dynamically generated
# comparison trampoline repeatedly, which reenters the original Python DLL.
crt = ctypes.CDLL('msvcrt.dll')
Compare = ctypes.CFUNCTYPE(c_int, c_void_p, c_void_p)
comparisons = [0]
@Compare
def compare(left, right):
    comparisons[0] += 1
    a = ctypes.cast(left, POINTER(c_int)).contents.value
    b = ctypes.cast(right, POINTER(c_int)).contents.value
    return (a > b) - (a < b)
values = (c_int * 5)(5, 1, 3, 2, 4)
crt.qsort.argtypes = [c_void_p, ctypes.c_size_t, ctypes.c_size_t, Compare]
crt.qsort.restype = None
crt.qsort(values, 5, ctypes.sizeof(c_int), compare)
assert list(values) == [1, 2, 3, 4, 5] and comparisons[0] > 0
result = {'sqlite_version': sqlite.sqlite3_libversion().decode(), 'sqlite_callback_rows': rows,
          'qsort': list(values), 'callback_cookie': cookie.value, 'ffi_int_bytes': ctypes.sizeof(c_int)}
encoded = json.dumps(result, sort_keys=True)
open('ffi-results.json', 'w', encoding='utf-8').write(encoded + '\n')
print('PYTHON NATIVE FFI WORKLOAD ' + encoded, flush=True)
