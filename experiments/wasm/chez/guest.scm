;; Chez Scheme guest protocol for the Wasm exploration.
;; The host prepends its request as a Scheme datum; this file never talks JSON.
(import (chezscheme))

(define registry '())

(define (lookup-rule id)
  (let ((cell (assoc id registry)))
    (and cell (cdr cell))))

(define (register-rule! id version proc . options)
  (when (lookup-rule id)
    (error 'duplicate-rule id))
  (set! registry (cons (cons id proc) registry))
  id)

(define (json-escape s)
  (let ((out (open-output-string)))
    (for-each
      (lambda (c)
        (cond
          ((char=? c #\") (display "\\\"" out))
          ((char=? c #\\) (display "\\\\" out))
          ((char=? c #\newline) (display "\\n" out))
          ((char=? c #\return) (display "\\r" out))
          ((char=? c #\tab) (display "\\t" out))
          (else (write-char c out))))
      (string->list s))
    (get-output-string out)))

(define (join-json xs sep)
  (cond
    ((null? xs) "")
    ((null? (cdr xs)) (car xs))
    (else (string-append (car xs) sep (join-json (cdr xs) sep)))))

(define (json-array xs)
  (string-append "[" (join-json (map json-value xs) ",") "]"))

(define (json-object xs)
  (string-append "{"
    (join-json
      (map (lambda (x)
             (string-append (json-value (car x)) ":" (json-value (cdr x))))
           xs)
      ",")
    "}"))

(define (json-value v)
  (cond
    ((eq? v #t) "true")
    ((eq? v #f) "false")
    ((number? v) (number->string v))
    ((string? v) (string-append "\"" (json-escape v) "\""))
    ((null? v) "[]")
    ((pair? v)
      (if (and (pair? (car v)) (string? (caar v)))
          (json-object v)
          (json-array v)))
    ((vector? v) (json-array (vector->list v)))
    (else "null")))

(define (json-ok value)
  (string-append "{\"ok\":true,\"value\":" (json-value value) "}"))

(define (json-error code message)
  (string-append "{\"ok\":false,\"error\":{\"code\":\"" (json-escape code)
                 "\",\"message\":\"" (json-escape message) "\"}}"))

(define (eval-source src)
  (let ((port (open-input-string src)))
    (let loop ((last #f))
      (let ((form (read port)))
        (if (eof-object? form)
            last
            (loop (eval form (interaction-environment))))))))

(define (run-eval source args)
  (guard (e (#t (json-error "EVAL_ERROR" (format "~a" e))))
    (let ((value (eval-source source)))
      (if (procedure? value)
          (json-ok (apply value args))
          (json-ok value)))))

(define (run-call call)
  (let ((id (car call)))
    (guard (e (#t
               (string-append "{\"rule\":" (json-value id)
                 ",\"ok\":false,\"error\":{\"code\":\"EVAL_ERROR\",\"message\":\""
                 (json-escape (format "~a" e)) "\"}}")))
      (let ((proc (lookup-rule id)))
        (if proc
            (string-append "{\"rule\":" (json-value id)
              ",\"ok\":true,\"value\":" (json-value (apply proc (cadr call))) "}")
            (string-append "{\"rule\":" (json-value id)
              ",\"ok\":false,\"error\":{\"code\":\"UNBOUND_RULE\",\"message\":\"no such rule\"}}"))))))

(define (run-load source calls)
  (guard (e (#t
             (string-append "{\"ok\":false,\"error\":{\"code\":\"EVAL_ERROR\",\"message\":\""
               (json-escape (format "~a" e)) "\"},\"stateIds\":"
               (json-array (map car registry)) "}")))
    (eval-source source)
    (let ((ids (map car registry)))
      (string-append "{\"ok\":true,\"stateIds\":" (json-array ids)
        ",\"ids\":" (json-array ids)
        ",\"calls\":[" (join-json (map run-call calls) ",") "]}"))))

(define (main req)
  (let ((op (car req)) (source (cadr req)) (arg (caddr req)))
    (cond
      ((string=? op "eval") (run-eval source arg))
      ((string=? op "isolated") (run-eval source arg))
      ((string=? op "load-module") (run-load source arg))
      (else (json-error "UNSUPPORTED" op)))))

;; APPEND_REQUEST
