;; Stateless experiment: runtime owns memory and all buffers. This module has
;; no data segments, linear-memory stack, allocator, table or memory.grow.
(module
  (import "runtime" "memory" (memory 1))
  (import "runtime" "density" (func $density (param i32 i32) (result f64)))
  (import "runtime" "expand" (func $expand (param i32 i32) (result i32)))
  (func (export "density") (param $x i32) (param $g i32) (result f64)
    local.get $x local.get $g call $density)
  (func (export "expand") (param $x i32) (param $out i32) (result i32)
    local.get $x local.get $out call $expand)
  (func (export "repeat_density") (param $x i32) (param $g i32) (param $count i32) (result f64)
    (local $sum f64)
    block $done
      loop $next
        local.get $count i32.eqz br_if $done
        local.get $sum local.get $x local.get $g call $density f64.add local.set $sum
        local.get $count i32.const 1 i32.sub local.set $count
        br $next
      end
    end
    local.get $sum)
)
