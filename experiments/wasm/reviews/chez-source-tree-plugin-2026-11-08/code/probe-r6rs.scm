(import (chezscheme))
(define (show label thunk)
  (display label) (display " ")
  (guard (e (#t (display "ERROR ") (write (condition-message e))))
    (write (thunk)))
  (newline))
(show 'rnrs-env
  (lambda ()
    (eval '(+ 1 2) (environment '(rnrs)))))
(show 'rnrs-file-bound
  (lambda ()
    (eval 'open-input-file (environment '(rnrs)))))
(show 'rnrs-eval-bound
  (lambda ()
    (eval 'eval (environment '(rnrs)))))
(show 'rnrs-foreign-bound
  (lambda ()
    (eval 'foreign-procedure (environment '(rnrs)))))
(show 'chez-env
  (lambda ()
    (environment '(chezscheme))))
