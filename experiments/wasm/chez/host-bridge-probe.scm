(import (chezscheme))

;; Blocking host bridge probe. The guest writes one request line to stdout
;; and blocks reading one response line from stdin. The C ABI call remains
;; active, so the Scheme stack is preserved without continuation capture.

(define (dsh-dispatch request)
  (display request)
  (newline)
  (flush-output-port)
  (let ((reply (get-line (current-input-port))))
    (if (eof-object? reply)
        (string->utf8 "{\"error\":\"E-HOST-EOF\"}")
        (string->utf8 reply))))
