(load "/plugin-loader.scm")

(load-plugin-source!
  "(library (dsh plugin demo v2)
     (export answer)
     (import (rnrs base (6)))
     (define (answer) 43))")

(display "AB ") (display (plugin-call 'demo 'answer)) (newline)
(exit 0)
