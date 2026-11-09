(import (chezscheme))
(define-condition-type &plugin-error &condition
  make-plugin-error plugin-error?
  (code plugin-error-code))
(display (plugin-error? (make-plugin-error 'E-X)))
(newline)
(guard (e (#t (display "CAUGHT ") (write e) (newline)))
  (raise (make-plugin-error 'E-X)))
(exit 0)
