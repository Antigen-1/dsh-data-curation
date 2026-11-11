(library (dsh plugin base (1 0 0))
  (export bump)
  (import (rnrs base (6)) (only (dsh lib math (1 0 0)) double))
  (define (bump) (+ (double 20) 2)))
