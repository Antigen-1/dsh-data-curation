;; Minimal Hoot smoke guest for the execution-semantics exploration.
;; It deliberately does not implement v1 AST/pin/hash compatibility.
(import (scheme base)
        (scheme read)
        (hoot eval)
        (hoot user))

(define rules '())

(define (register-rule! id version proc . options)
  (set! rules (cons (cons id proc) rules))
  id)

(define (call-rule id arg)
  ((cdr (assoc id rules)) arg))

;; Fixed arity keeps the JS reflection boundary simple. Unused arguments are
;; passed as #f by boot.mjs.
(define (dispatch op source a b c d)
  (cond
    ((string=? op "eval")
     (let ((proc (eval (read (open-input-string source)) (interaction-environment))))
       (proc a)))
    ((string=? op "load-module")
     (eval (read (open-input-string source)) (interaction-environment))
     #t)
    ((string=? op "call")
     (call-rule source a))
    (else
     (error "unknown smoke op" op))))

dispatch
