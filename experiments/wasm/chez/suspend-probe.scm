(import (chezscheme))

(define pending #f)

(define (dsh-dispatch payload)
  (call/cc
    (lambda (return)
      (if (string=? payload "suspend")
          (begin
            (set! pending
                  (lambda (value)
                    (return (string->utf8 (string-append "final:" value)))))
            (return (string->utf8 "suspended")))
          (return (string->utf8 "normal"))))))

(define (dsh-resume payload)
  (if pending
      (let ((k pending))
        (set! pending #f)
        (k payload))
      (string->utf8 "no-pending")))
