; Minimal Chibi guest for the Wasm exploration protocol.
; This file runs inside the Wasm VM; it does not import project code.
(import (scheme base)
        (scheme read)
        (scheme write)
        (scheme eval)
        (scheme repl)
        (scheme process-context)
        (chibi json))

(define rules '())

(define (field key alist default)
  (let ((cell (assq key alist)))
    (if cell (cdr cell) default)))

(define (json-error code message)
  (list (cons 'ok #f)
        (cons 'error (list (cons 'code code)
                           (cons 'message message)))))

(define (error-code message)
  (cond
    ((string-contains message "unbound") "UNBOUND_VARIABLE")
    ((string-contains message "duplicate") "DUPLICATE_RULE")
    (else "EVAL_ERROR")))

(define (string-contains haystack needle)
  (let ((h (string->list haystack))
        (n (string->list needle)))
    (let loop ((rest h))
      (cond
        ((null? rest) #f)
        ((and (>= (length rest) (length n))
              (equal? n (list-copy (take rest (length n))))) #t)
        (else (loop (cdr rest)))))))

(define (take lst n)
  (if (or (= n 0) (null? lst)) '()
      (cons (car lst) (take (cdr lst) (- n 1)))))

(define (register-rule! id version proc . options)
  (when (assoc id rules)
    (error "duplicate rule" id))
  (let* ((opts (if (null? options) '() (car options)))
         (role (field 'role opts #f)))
    (when (and role
               (let loop ((rest rules))
                 (cond ((null? rest) #f)
                       ((equal? (field 'role (list-ref (car rest) 3) #f) role) #t)
                       (else (loop (cdr rest))))))
      (error "duplicate role" role))
    (set! rules (append rules (list (list id version proc opts))))
    id))

(define (write-response object)
  (write-string (json->string object))
  (newline)
  (flush-output-port))

(define (eval-source source)
  (let ((port (open-input-string source)))
    (let loop ((last #f))
      (let ((form (read port)))
        (if (eof-object? form)
            last
            (loop (eval form (interaction-environment))))))))

(define (call-rule rule-id args)
  (let ((entry (assoc rule-id rules)))
    (if (not entry)
        (json-error "UNBOUND_RULE" "rule not found")
        (let ((proc (list-ref entry 2)))
          (guard (e (#t (json-error "CALL_ERROR" "rule call failed")))
            (let ((value (apply proc (vector->list args))))
              (list (cons 'rule rule-id)
                    (cons 'ok #t)
                    (cons 'value value))))))))

(define (handle request)
  (let* ((id (field 'id request #f))
         (op (field 'op request ""))
         (response
          (cond
            ((string=? op "capabilities")
             (list (cons 'ok #t)
                   (cons 'levels (vector "pure-dynamic"))
                   (cons 'ops (vector "capabilities" "eval" "load-module" "isolated"))))
            ((string=? op "eval")
             (guard (e (#t (json-error (error-code (error-object-message e))
                                        (error-object-message e))))
               (list (cons 'ok #t)
                     (cons 'value
                           (apply (eval-source (field 'source request ""))
                                  (vector->list (field 'args request (vector))))))))
            ((string=? op "isolated")
             (guard (e (#t (json-error (error-code (error-object-message e))
                                        (error-object-message e))))
               (list (cons 'ok #t)
                     (cons 'value
                           (apply (eval-source (field 'source request ""))
                                  (vector->list (field 'args request (vector))))))))
            ((string=? op "load-module")
             (guard (e (#t (json-error (error-code (error-object-message e))
                                        (error-object-message e))))
               (eval-source (field 'source request ""))
               (let* ((calls (vector->list (field 'calls request (vector))))
                      (results
                       (map (lambda (call)
                              (call-rule (field 'rule call "")
                                         (field 'args call (vector))))
                            calls))
                      (ids (map car rules)))
                 (list (cons 'ok #t)
                       (cons 'stateIds (list->vector ids))
                       (cons 'ids (list->vector ids))
                       (cons 'calls (list->vector results))))))
            (else (json-error "UNSUPPORTED_OP" op)))))
    (append (list (cons 'protocolVersion 1) (cons 'id id)) response)))

(let loop ()
  (let ((line (read-line)))
    (if (or (eof-object? line) (string=? line ""))
        (if (eof-object? line) (exit 0) (loop))
        (begin
          (guard (e (#t (write-response (json-error "PROTOCOL_ERROR"
                                                    (error-object-message e)))))
            (write-response (handle (string->json line))))
          (loop)))))
