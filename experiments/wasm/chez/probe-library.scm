(library (dsh rule test v1)
  (export entry)
  (import (rnrs base (6)))
  (define (entry x) (+ x 1)))

(import (rnrs base (6)) (rnrs io simple (6)) (dsh rule test v1))
(display (entry 41))
(newline)
(exit 0)
