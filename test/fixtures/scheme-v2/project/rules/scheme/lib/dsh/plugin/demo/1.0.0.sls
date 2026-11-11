(library (dsh plugin demo (1 0 0))
  (export answer)
  (import (rnrs base (6)) (only (dsh plugin base (1 0 0)) bump))
  (define (answer) (bump)))
