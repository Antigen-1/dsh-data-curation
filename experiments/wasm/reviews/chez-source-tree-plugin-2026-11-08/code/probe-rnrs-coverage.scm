(import (chezscheme))
(define rnrs (environment '(rnrs)))

(define (bound? name)
  (guard (e (#t #f))
    (eval name rnrs)
    #t))

(for-each
  (lambda (name)
    (display name) (display " ")
    (write (bound? name))
    (newline))
  '(eval environment set-car! string-set! exit syntax-case
         make-eq-hashtable open-input-file load))

(display "eval-library ")
(guard (e (#t (display "ERROR ") (write (condition-message e))))
  (let ()
    (import (rnrs eval (6)))
    (write (eval '(+ 1 2) (environment '(rnrs base (6)))))))
(newline)
