-- SPDX-License-Identifier: MIT
-- Executed by the original upstream Windows Lua DLL inside the x86 guest.
local x = 9007199254740993
assert(x + 10 - 10 == x)
assert(native_sum(x, 42) == x + 42)
assert(math.abs(math.sin(0.5) - 0.479425538604203) < 1e-12)
assert(utf8.len('Lua ✓ café') == 10)
local values = {9, 2, 6, 3, 7, 1}
table.sort(values, function(a, b) return a < b end)
assert(table.concat(values, ',') == '1,2,3,6,7,9')
local co = coroutine.create(function()
  coroutine.yield(42)
  return 99
end)
local ok, value = coroutine.resume(co)
assert(ok and value == 42)
ok, value = coroutine.resume(co)
assert(ok and value == 99 and coroutine.status(co) == 'dead')
local passed, error = pcall(function() error('caught error') end)
assert(not passed and error:find('caught error', 1, true))
local bytes = string.pack('<I8i8d', x, -42, 0.5)
local file = assert(io.open('lua-output.bin', 'wb'))
assert(file:write(bytes))
assert(file:close())
file = assert(io.open('lua-output.bin', 'rb'))
assert(file:read('*a') == bytes)
assert(file:close())
local a, b, c = string.unpack('<I8i8d', bytes)
assert(a == x and b == -42 and c == 0.5)
collectgarbage('collect')
print('LUA GUEST SCRIPT PASS')
return true
