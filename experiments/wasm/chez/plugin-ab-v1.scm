(load "/plugin-loader.scm")

(load-plugin-source!
  "(library (dsh plugin demo v1)
     (export answer)
     (import (rnrs base (6)))
     (define (answer) 42))")

(display "AB ") (display (plugin-call 'demo 'answer)) (newline)
(exit 0)
