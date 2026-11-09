(library (dsh lib math v1)
  (export double)
  (import (rnrs base (6)) (only (dsh lib base v1) two))
  (define (double x) (* x (two))))
