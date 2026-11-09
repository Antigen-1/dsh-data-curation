;; Fixed-aot Hoot smoke guest: no runtime eval or dynamic module loading.
(import (scheme base))

(define (positive-rule? x)
  (> x 0))

(define (dispatch op source a b c d)
  (cond
    ((string=? op "call")
     (positive-rule? a))
    (else
     #f)))

dispatch
