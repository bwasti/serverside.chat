(module
  ;; 0..524287 is the document; 524288..589823 is insertion scratch space.
  (memory (export "memory") 9 9)
  (global $length (mut i32) (i32.const 0))
  (global $cursor (mut i32) (i32.const 0))

  (func (export "capacity") (result i32) (i32.const 524288))
  (func (export "scratch") (result i32) (i32.const 524288))
  (func (export "length") (result i32) (global.get $length))
  (func (export "cursor") (result i32) (global.get $cursor))

  (func (export "initialize") (param $length i32) (result i32)
    (if (result i32)
      (i32.gt_u (local.get $length) (i32.const 524288))
      (then (i32.const 0))
      (else
        (global.set $length (local.get $length))
        (global.set $cursor (i32.const 0))
        (i32.const 1))))

  (func (export "set_cursor") (param $position i32)
    (if (i32.gt_u (local.get $position) (global.get $length))
      (then (global.set $cursor (global.get $length)))
      (else (global.set $cursor (local.get $position)))))

  (func $continuation (param $position i32) (result i32)
    (i32.eq
      (i32.and (i32.load8_u (local.get $position)) (i32.const 192))
      (i32.const 128)))

  (func $left (export "left")
    (if (i32.gt_u (global.get $cursor) (i32.const 0))
      (then
        (global.set $cursor (i32.sub (global.get $cursor) (i32.const 1)))
        (loop $scan
          (if
            (i32.and
              (i32.gt_u (global.get $cursor) (i32.const 0))
              (call $continuation (global.get $cursor)))
            (then
              (global.set $cursor (i32.sub (global.get $cursor) (i32.const 1)))
              (br $scan)))))))

  (func $right (export "right")
    (if (i32.lt_u (global.get $cursor) (global.get $length))
      (then
        (global.set $cursor (i32.add (global.get $cursor) (i32.const 1)))
        (loop $scan
          (if
            (i32.and
              (i32.lt_u (global.get $cursor) (global.get $length))
              (call $continuation (global.get $cursor)))
            (then
              (global.set $cursor (i32.add (global.get $cursor) (i32.const 1)))
              (br $scan)))))))

  (func (export "line_start")
    (loop $scan
      (if
        (i32.and
          (i32.gt_u (global.get $cursor) (i32.const 0))
          (i32.ne (i32.load8_u (i32.sub (global.get $cursor) (i32.const 1))) (i32.const 10)))
        (then
          (global.set $cursor (i32.sub (global.get $cursor) (i32.const 1)))
          (br $scan)))))

  (func (export "line_end")
    (loop $scan
      (if
        (i32.and
          (i32.lt_u (global.get $cursor) (global.get $length))
          (i32.ne (i32.load8_u (global.get $cursor)) (i32.const 10)))
        (then
          (global.set $cursor (i32.add (global.get $cursor) (i32.const 1)))
          (br $scan)))))

  (func (export "insert") (param $source i32) (param $count i32) (result i32)
    (if (result i32)
      (i32.gt_u (i32.add (global.get $length) (local.get $count)) (i32.const 524288))
      (then (i32.const 0))
      (else
        (memory.copy
          (i32.add (global.get $cursor) (local.get $count))
          (global.get $cursor)
          (i32.sub (global.get $length) (global.get $cursor)))
        (memory.copy (global.get $cursor) (local.get $source) (local.get $count))
        (global.set $cursor (i32.add (global.get $cursor) (local.get $count)))
        (global.set $length (i32.add (global.get $length) (local.get $count)))
        (i32.const 1))))

  (func (export "backspace") (result i32)
    (local $old i32)
    (local $removed i32)
    (if (result i32)
      (i32.eqz (global.get $cursor))
      (then (i32.const 0))
      (else
        (local.set $old (global.get $cursor))
        (call $left)
        (local.set $removed (i32.sub (local.get $old) (global.get $cursor)))
        (memory.copy
          (global.get $cursor)
          (local.get $old)
          (i32.sub (global.get $length) (local.get $old)))
        (global.set $length (i32.sub (global.get $length) (local.get $removed)))
        (i32.const 1))))

  (func (export "delete") (result i32)
    (local $start i32)
    (local $end i32)
    (if (result i32)
      (i32.ge_u (global.get $cursor) (global.get $length))
      (then (i32.const 0))
      (else
        (local.set $start (global.get $cursor))
        (call $right)
        (local.set $end (global.get $cursor))
        (memory.copy
          (local.get $start)
          (local.get $end)
          (i32.sub (global.get $length) (local.get $end)))
        (global.set $length (i32.sub (global.get $length) (i32.sub (local.get $end) (local.get $start))))
        (global.set $cursor (local.get $start))
        (i32.const 1))))
)
